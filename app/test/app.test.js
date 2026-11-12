// Local functional and security tests. PayPal and the assistant are MOCKS here (see helpers.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closeAll, startTestApp, ready, quoteOf, approveAndHold, FAKE_ID, FAKE_SECRET, FakePayPal } from './helpers.js';
import { openDb } from '../src/db.js';
import { createService } from '../src/service.js';
import { toPayPalValue, fromPayPalValue } from '../src/money.js';

after(closeAll);

const CAPTURE_POST = /\/authorizations\/\w+\/capture$/;
const VOID_POST = /\/authorizations\/\w+\/void$/;
const AUTH_POST = /\/orders\/\w+\/authorize$/;

test('money helpers use integer cents', () => {
  assert.equal(toPayPalValue(42000), '420.00');
  assert.equal(toPayPalValue(10305), '103.05');
  assert.equal(fromPayPalValue('103.00'), 10300);
  assert.equal(fromPayPalValue('103'), null);
});

test('base job: approve, hold, mark done, charge once; minimal capture response is verified by GET', async () => {
  const t = await startTestApp();
  const { shop, cust } = await ready(t);
  const r = await approveAndHold(t, cust, t.ids.base, ['brake-part', 'brake-labor']);
  assert.equal(r.ret.status, 200);
  assert.equal(r.ret.body.payment.state, 'held');
  assert.equal(r.ret.body.payment.label, 'Held, not charged');
  // Order payload carries the approval link and exact items.
  const order = t.sim.orders.get(r.orderId);
  assert.equal(order.purchase_units[0].custom_id, r.approvalId);
  assert.equal(order.purchase_units[0].amount.value, '420.00');
  assert.deepEqual(order.purchase_units[0].items.map((i) => [i.sku, i.unit_amount.value]), [['BRAKE-PART', '300.00'], ['BRAKE-LABOR', '120.00']]);

  // Charging before work is marked done is refused.
  assert.equal((await shop('POST', `/api/shop/payments/${r.paymentId}/capture`)).body.error, 'WORK_NOT_DONE');
  assert.equal((await shop('POST', `/api/shop/payments/${r.paymentId}/work-done`)).status, 200);
  t.sim.captureMode = 'minimal';
  const cap = await shop('POST', `/api/shop/payments/${r.paymentId}/capture`);
  assert.equal(cap.status, 200, JSON.stringify(cap.body));
  assert.equal(cap.body.state, 'paid');
  assert.equal(t.sim.count('POST', CAPTURE_POST), 1);
  assert.ok(t.sim.calls.some((c) => c.method === 'GET' && /\/captures\//.test(c.path)), 'capture verified with GET');
  const capBody = [...t.sim.captures.values()][0];
  assert.equal(capBody.final_capture, true);
  assert.equal(capBody.amount.value, '420.00');

  // Second click / retry does not capture again.
  const again = await shop('POST', `/api/shop/payments/${r.paymentId}/capture`);
  assert.equal(again.body.state, 'paid');
  assert.equal(t.sim.count('POST', CAPTURE_POST), 1);
  // A charged hold cannot be released.
  assert.equal((await shop('POST', `/api/shop/payments/${r.paymentId}/cancel`, { reason: 'x' })).status, 409);
  assert.equal(t.sim.count('POST', VOID_POST), 0);
  await t.close();
});

test('price tampering, unknown items, quantity changes and total mismatch are rejected', async () => {
  const t = await startTestApp();
  const { cust } = await ready(t);
  const q = await quoteOf(cust, t.ids.base);
  const url = `/api/c/quotes/${t.ids.base}/decision`;
  const base = { decision: 'approved', versionHash: q.version_hash };
  let r = await cust('POST', url, { ...base, items: [{ id: 'brake-part', unit_cents: 1 }], expectedTotalCents: 1 });
  assert.equal(r.body.error, 'PRICE_FIELDS_NOT_ACCEPTED');
  r = await cust('POST', url, { ...base, items: [{ id: 'brake-part' }], expectedTotalCents: 100 });
  assert.equal(r.body.error, 'TOTAL_MISMATCH');
  r = await cust('POST', url, { ...base, items: [{ id: 'brake-part', qty: 0.5 }], expectedTotalCents: 15000 });
  assert.equal(r.body.error, 'INVALID_QUANTITY');
  r = await cust('POST', url, { ...base, items: [{ id: 'oil-change' }], expectedTotalCents: 0 });
  assert.equal(r.body.error, 'UNKNOWN_ITEM');
  r = await cust('POST', url, { ...base, items: [{ id: 'brake-part' }, { id: 'brake-part' }], expectedTotalCents: 60000 });
  assert.equal(r.body.error, 'DUPLICATE_ITEM');
  r = await cust('POST', url, { ...base, items: [], expectedTotalCents: 0 });
  assert.equal(r.body.error, 'NOTHING_SELECTED');
  r = await cust('POST', url, { ...base, items: [{ id: 'brake-part' }], expectedTotalCents: 30000 });
  assert.equal(r.status, 200);
  assert.equal(r.body.total_cents, 30000);
  assert.equal(t.sim.calls.length, 0, 'no PayPal call from a decision');
  await t.close();
});

test('add-on partial selection creates a separate order for exactly the selected items', async () => {
  const t = await startTestApp();
  const { shop, cust } = await ready(t);
  await shop('POST', `/api/shop/quotes/${t.ids.addon}/send`);
  const base = await approveAndHold(t, cust, t.ids.base, ['brake-part', 'brake-labor']);
  const addon = await approveAndHold(t, cust, t.ids.addon, ['hose-part', 'hose-labor']);
  assert.notEqual(base.orderId, addon.orderId);
  const pu = t.sim.orders.get(addon.orderId).purchase_units[0];
  assert.equal(pu.amount.value, '103.00');
  assert.deepEqual(pu.items.map((i) => i.sku), ['HOSE-PART', 'HOSE-LABOR']);
  const job = (await shop('GET', `/api/shop/jobs/${t.ids.jobId}`)).body;
  const ev = job.history.find((e) => e.type === 'scope_approved' && e.quote_id === t.ids.addon);
  assert.deepEqual(ev.detail.declined_items, ['filter-part']);
  await t.close();
});

test('stale quote: edits clear the old choice, old hashes and old suggestions cannot approve, abandoned order is never authorized', async () => {
  const t = await startTestApp();
  const { shop, cust } = await ready(t);
  await shop('POST', `/api/shop/quotes/${t.ids.addon}/send`);
  const old = await quoteOf(cust, t.ids.addon);
  t.ai.next = { kind: 'selection', answer: 'Upper radiator hose and its labor. Review and approve below.', selected_item_ids: ['hose-part', 'hose-labor'] };
  const sug = (await cust('POST', `/api/c/quotes/${t.ids.addon}/ask`, { question: 'Hose only', versionHash: old.version_hash })).body;
  // Customer approves and opens PayPal, but has not approved there yet.
  const d = await cust('POST', `/api/c/quotes/${t.ids.addon}/decision`, { decision: 'approved', versionHash: old.version_hash, items: [{ id: 'hose-part' }, { id: 'hose-labor' }], expectedTotalCents: 10300, aiSuggestionId: sug.suggestion_id });
  const co = (await cust('POST', `/api/c/approvals/${d.body.approval_id}/checkout`)).body;
  // Shop changes the price.
  const items = old.items.map((i) => (i.id === 'hose-labor' ? { ...i, unit_cents: 7000 } : i));
  const ed = await shop('POST', `/api/shop/quotes/${t.ids.addon}/versions`, { baseVersion: 1, note: old.note, items });
  assert.equal(ed.status, 200);
  assert.equal((await shop('POST', `/api/shop/quotes/${t.ids.addon}/versions`, { baseVersion: 1, note: old.note, items })).body.error, 'STALE_EDIT');
  // Stale tab tries to approve with the old hash.
  const stale = await cust('POST', `/api/c/quotes/${t.ids.addon}/decision`, { decision: 'approved', versionHash: old.version_hash, items: [{ id: 'hose-part' }], expectedTotalCents: 3800 });
  assert.equal(stale.body.error, 'STALE_QUOTE');
  // The buyer approves the old PayPal order anyway; the app must not place a hold.
  const orderId = new URL(co.approve_url).searchParams.get('token');
  t.sim.approve(orderId);
  const ret = await cust('POST', `/api/c/payments/${co.id}/return`, { orderId });
  assert.equal(ret.body.payment.state, 'abandoned');
  assert.equal(t.sim.count('POST', AUTH_POST), 0);
  // Old checkout cannot be restarted.
  assert.equal((await cust('POST', `/api/c/approvals/${d.body.approval_id}/checkout`)).body.error, 'APPROVAL_NOT_CURRENT');
  // An assistant suggestion from v1 cannot be used on v2.
  const nq = await quoteOf(cust, t.ids.addon);
  const s2 = await cust('POST', `/api/c/quotes/${t.ids.addon}/decision`, { decision: 'approved', versionHash: nq.version_hash, items: [{ id: 'hose-part' }, { id: 'hose-labor' }], expectedTotalCents: 10800, aiSuggestionId: sug.suggestion_id });
  assert.equal(s2.body.error, 'STALE_SUGGESTION');
  assert.equal(nq.approval, null);
  await t.close();
});

test('quote with an active hold cannot be edited', async () => {
  const t = await startTestApp();
  const { shop, cust } = await ready(t);
  await approveAndHold(t, cust, t.ids.base, ['brake-part']);
  const q = await quoteOf(cust, t.ids.base);
  const r = await shop('POST', `/api/shop/quotes/${t.ids.base}/versions`, { baseVersion: 1, note: q.note, items: q.items });
  assert.equal(r.body.error, 'PAYMENT_LOCKED');
  await t.close();
});

test('tokens: cross-job, expired, invalid, shop privilege and CSRF header', async () => {
  const clock = { now: new Date('2026-11-13T00:00:00Z') };
  const t = await startTestApp({ clock });
  const { shop, cust, link } = await ready(t);
  // Second job with its own link.
  const { seedJob } = await import('../scripts/seed-data.js');
  const other = seedJob(t.db, t.app.svc);
  const link2 = (await shop('POST', `/api/shop/jobs/${other.jobId}/customer-link`)).body;
  const q1 = await quoteOf(cust, t.ids.base);
  const cross = await t.req('POST', `/api/c/quotes/${t.ids.base}/decision`, { decision: 'declined', versionHash: q1.version_hash, items: [] }, { 'X-Customer-Token': link2.token });
  assert.equal(cross.status, 404);
  const crossAsk = await t.req('POST', `/api/c/quotes/${t.ids.base}/ask`, { question: 'hi', versionHash: q1.version_hash }, { 'X-Customer-Token': link2.token });
  assert.equal(crossAsk.status, 404);
  const job2 = await t.req('GET', '/api/c/job', undefined, { 'X-Customer-Token': link2.token });
  assert.ok(job2.body.quotes.every((q) => q.id !== t.ids.base));
  // Customer token cannot use shop routes; no cookie means no shop access.
  assert.equal((await t.req('GET', `/api/shop/jobs/${t.ids.jobId}`, undefined, { 'X-Customer-Token': link.token })).status, 401);
  assert.equal((await t.req('POST', '/api/shop/login', { key: 'wrong' })).status, 401);
  assert.equal((await t.req('POST', `/api/shop/payments/pay_x/capture`, {})).status, 401);
  // Missing CSRF header.
  const noHeader = await fetch(t.base + `/api/shop/jobs/${t.ids.jobId}/customer-link`, { method: 'POST', headers: { Cookie: (await t.shopLogin(t.ids.shopKey)) } });
  assert.equal(noHeader.status, 403);
  assert.equal((await t.req('GET', '/api/c/job', undefined, { 'X-Customer-Token': 'nope' })).body.error, 'LINK_INVALID');
  // Expiry.
  clock.now = new Date('2026-11-21T00:00:00Z');
  assert.equal((await cust('GET', '/api/c/job')).body.error, 'LINK_EXPIRED');
  // Customer view hides shop-only fields.
  clock.now = new Date('2026-11-13T00:00:00Z');
  const view = (await cust('GET', '/api/c/job')).body;
  assert.equal(view.history, undefined);
  assert.ok(view.quotes.every((q) => q.status === 'sent'), 'draft quotes hidden');
  await t.close();
});

test('duplicate PayPal return and concurrent capture clicks never create a second authorization or capture', async () => {
  const t = await startTestApp();
  const { shop, cust } = await ready(t);
  const r = await approveAndHold(t, cust, t.ids.base, ['brake-part', 'brake-labor']);
  const dup = await Promise.all([1, 2, 3].map(() => cust('POST', `/api/c/payments/${r.paymentId}/return`, { orderId: r.orderId })));
  assert.ok(dup.every((x) => x.status === 200 || x.status === 409));
  assert.equal(t.sim.count('POST', AUTH_POST), 1);
  // Return with a different order id is refused.
  assert.equal((await cust('POST', `/api/c/payments/${r.paymentId}/return`, { orderId: 'ORDXXXX' })).body.error, 'ORDER_MISMATCH');
  await shop('POST', `/api/shop/payments/${r.paymentId}/work-done`);
  const caps = await Promise.all([1, 2, 3, 4].map(() => shop('POST', `/api/shop/payments/${r.paymentId}/capture`)));
  assert.ok(caps.some((c) => c.status === 200 && c.body.state === 'paid'));
  assert.equal(t.sim.count('POST', CAPTURE_POST), 1);
  // Double click on checkout returns the same order.
  await shop('POST', `/api/shop/quotes/${t.ids.addon}/send`);
  const q = await quoteOf(cust, t.ids.addon);
  const d = await cust('POST', `/api/c/quotes/${t.ids.addon}/decision`, { decision: 'approved', versionHash: q.version_hash, items: [{ id: 'hose-part' }, { id: 'hose-labor' }], expectedTotalCents: 10300 });
  const d2 = await cust('POST', `/api/c/quotes/${t.ids.addon}/decision`, { decision: 'approved', versionHash: q.version_hash, items: [{ id: 'hose-part' }, { id: 'hose-labor' }], expectedTotalCents: 10300 });
  assert.equal(d2.body.approval_id, d.body.approval_id);
  assert.equal(d2.body.repeated, true);
  const c1 = await Promise.all([1, 2].map(() => cust('POST', `/api/c/approvals/${d.body.approval_id}/checkout`)));
  const c2 = await cust('POST', `/api/c/approvals/${d.body.approval_id}/checkout`);
  assert.equal(t.sim.count('POST', /\/v2\/checkout\/orders$/), 2, 'one order for base, one for add-on');
  assert.ok(c1.some((x) => x.status === 200));
  assert.equal(c2.body.approve_url, c1.find((x) => x.status === 200).body.approve_url);
  await t.close();
});

test('capture timeout after PayPal charged: state is unknown, button blocked, reconcile finds the one capture', async () => {
  const t = await startTestApp();
  const { shop, cust } = await ready(t);
  const r = await approveAndHold(t, cust, t.ids.base, ['brake-part', 'brake-labor']);
  await shop('POST', `/api/shop/payments/${r.paymentId}/work-done`);
  t.sim.faults.push({ match: (m, p) => m === 'POST' && CAPTURE_POST.test(p), mode: 'lost-response' });
  const cap = await shop('POST', `/api/shop/payments/${r.paymentId}/capture`);
  assert.equal(cap.status, 502);
  let job = (await shop('GET', `/api/shop/jobs/${t.ids.jobId}`)).body;
  let p = job.quotes.find((q) => q.id === t.ids.base).payment;
  assert.equal(p.state, 'needs_check');
  assert.equal(p.label, 'Checking with PayPal');
  // Pressing charge again does nothing.
  assert.equal((await shop('POST', `/api/shop/payments/${r.paymentId}/capture`)).body.error, 'NOT_HELD');
  const rec = await shop('POST', `/api/shop/payments/${r.paymentId}/reconcile`);
  assert.equal(rec.status, 200, JSON.stringify(rec.body));
  assert.equal(rec.body.state, 'paid');
  assert.equal(t.sim.count('POST', CAPTURE_POST), 1);
  assert.ok(rec.body.operations.filter((o) => o.kind === 'capture').every((o) => o.attempt === 1));
  await t.close();
});

test('capture timeout before PayPal received it: reconcile replays with the same PayPal-Request-Id once', async () => {
  const t = await startTestApp();
  const { shop, cust } = await ready(t);
  const r = await approveAndHold(t, cust, t.ids.base, ['brake-part']);
  await shop('POST', `/api/shop/payments/${r.paymentId}/work-done`);
  t.sim.faults.push({ match: (m, p) => m === 'POST' && CAPTURE_POST.test(p), mode: 'drop' });
  await shop('POST', `/api/shop/payments/${r.paymentId}/capture`);
  assert.equal(t.sim.captures.size, 0);
  const rec = await shop('POST', `/api/shop/payments/${r.paymentId}/reconcile`);
  assert.equal(rec.body.state, 'paid');
  const rids = t.sim.calls.filter((c) => CAPTURE_POST.test(c.path)).map((c) => c.rid);
  assert.equal(rids.length, 2);
  assert.equal(rids[0], rids[1], 'same request id on replay');
  assert.equal(t.sim.captures.size, 1);
  await t.close();
});

test('pending capture is not shown as paid until PayPal completes it', async () => {
  const t = await startTestApp();
  const { shop, cust } = await ready(t);
  const r = await approveAndHold(t, cust, t.ids.base, ['brake-part', 'brake-labor']);
  await shop('POST', `/api/shop/payments/${r.paymentId}/work-done`);
  t.sim.captureMode = 'pending';
  const cap = await shop('POST', `/api/shop/payments/${r.paymentId}/capture`);
  assert.equal(cap.body.state, 'capture_pending');
  assert.match(cap.body.last_error, /PENDING_REVIEW/);
  const custView = (await cust('GET', '/api/c/job')).body.quotes.find((q) => q.id === t.ids.base).payment;
  assert.equal(custView.label, 'Charge pending at PayPal');
  [...t.sim.captures.values()][0].status = 'COMPLETED';
  const rec = await shop('POST', `/api/shop/payments/${r.paymentId}/reconcile`);
  assert.equal(rec.body.state, 'paid');
  assert.equal(t.sim.count('POST', CAPTURE_POST), 1);
  await t.close();
});

test('initial refusal creates no hold and no void; approved-then-cancelled work is voided once', async () => {
  const t = await startTestApp();
  const { shop, cust } = await ready(t);
  await shop('POST', `/api/shop/quotes/${t.ids.addon}/send`);
  const q = await quoteOf(cust, t.ids.addon);
  const dec = await cust('POST', `/api/c/quotes/${t.ids.addon}/decision`, { decision: 'declined', versionHash: q.version_hash, items: [] });
  assert.equal(dec.status, 200);
  assert.equal((await quoteOf(cust, t.ids.addon)).payment, null);
  assert.equal(t.sim.calls.length, 0, 'declining calls PayPal zero times');
  // Separate air-filter job: approved, held, then cancelled before work.
  await shop('POST', `/api/shop/quotes/${t.ids.filter}/send`);
  const f = await approveAndHold(t, cust, t.ids.filter, ['filter-part']);
  assert.equal(f.ret.body.payment.state, 'held');
  const c = await shop('POST', `/api/shop/payments/${f.paymentId}/cancel`, { reason: 'Filter in stock does not fit' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.state, 'released');
  assert.equal(t.sim.count('POST', VOID_POST), 1);
  assert.equal(t.sim.count('POST', CAPTURE_POST), 0);
  const cv = (await quoteOf(cust, t.ids.filter));
  assert.equal(cv.payment.label, 'Hold released, not charged');
  // Repeat cancel is a no-op.
  await shop('POST', `/api/shop/payments/${f.paymentId}/cancel`, { reason: 'again' });
  assert.equal(t.sim.count('POST', VOID_POST), 1);
  await t.close();
});

test('customer closes PayPal after approving scope: saved choice, nothing held, shop cancel does not call void', async () => {
  const t = await startTestApp();
  const { shop, cust } = await ready(t);
  const q = await quoteOf(cust, t.ids.base);
  const d = await cust('POST', `/api/c/quotes/${t.ids.base}/decision`, { decision: 'approved', versionHash: q.version_hash, items: [{ id: 'brake-part' }, { id: 'brake-labor' }], expectedTotalCents: 42000 });
  const co = (await cust('POST', `/api/c/approvals/${d.body.approval_id}/checkout`)).body;
  const orderId = new URL(co.approve_url).searchParams.get('token');
  const closed = await cust('POST', `/api/c/payments/${co.id}/closed`, { orderId });
  assert.equal(closed.body.state, 'awaiting_buyer');
  assert.match(closed.body.text, /Nothing is held or charged/);
  // Returning without approval does not authorize.
  const ret = await cust('POST', `/api/c/payments/${co.id}/return`, { orderId });
  assert.equal(ret.body.payment.state, 'awaiting_buyer');
  assert.equal(t.sim.count('POST', AUTH_POST), 0);
  const job = (await shop('GET', `/api/shop/jobs/${t.ids.jobId}`)).body;
  assert.equal(job.quotes.find((x) => x.id === t.ids.base).approval.decision, 'approved');
  const c = await shop('POST', `/api/shop/payments/${co.id}/cancel`, { reason: 'Customer will come back later' });
  assert.equal(c.body.state, 'abandoned');
  assert.equal(t.sim.count('POST', VOID_POST), 0);
  await t.close();
});

test('order that does not match the approved amount or items is not authorized', async () => {
  const t = await startTestApp();
  const { cust } = await ready(t);
  const q = await quoteOf(cust, t.ids.base);
  const d = await cust('POST', `/api/c/quotes/${t.ids.base}/decision`, { decision: 'approved', versionHash: q.version_hash, items: [{ id: 'brake-part' }, { id: 'brake-labor' }], expectedTotalCents: 42000 });
  const co = (await cust('POST', `/api/c/approvals/${d.body.approval_id}/checkout`)).body;
  const orderId = new URL(co.approve_url).searchParams.get('token');
  t.sim.approve(orderId);
  t.sim.orders.get(orderId).purchase_units[0].amount.value = '520.00';
  const ret = await cust('POST', `/api/c/payments/${co.id}/return`, { orderId });
  assert.equal(ret.body.error, 'ORDER_MISMATCH');
  assert.equal(t.sim.count('POST', AUTH_POST), 0);
  await t.close();
});

test('authorize timeout: state needs_check, reconcile adopts the existing authorization without a second one', async () => {
  const t = await startTestApp();
  const { shop, cust } = await ready(t);
  const q = await quoteOf(cust, t.ids.base);
  const d = await cust('POST', `/api/c/quotes/${t.ids.base}/decision`, { decision: 'approved', versionHash: q.version_hash, items: [{ id: 'brake-part' }, { id: 'brake-labor' }], expectedTotalCents: 42000 });
  const co = (await cust('POST', `/api/c/approvals/${d.body.approval_id}/checkout`)).body;
  const orderId = new URL(co.approve_url).searchParams.get('token');
  t.sim.approve(orderId);
  t.sim.faults.push({ match: (m, p) => AUTH_POST.test(p), mode: 'lost-response' });
  const ret = await cust('POST', `/api/c/payments/${co.id}/return`, { orderId });
  assert.equal(ret.status, 502);
  assert.equal((await quoteOf(cust, t.ids.base)).payment.label, 'Checking with PayPal');
  const rec = await shop('POST', `/api/shop/payments/${co.id}/reconcile`);
  assert.equal(rec.body.state, 'held', JSON.stringify(rec.body));
  assert.equal(t.sim.auths.size, 1);
  await t.close();
});

test('assistant output is checked: unknown items and invented amounts are rejected, payment questions use fixed text, no approval is created', async () => {
  const t = await startTestApp();
  const { shop, cust } = await ready(t);
  await shop('POST', `/api/shop/quotes/${t.ids.addon}/send`);
  const q = await quoteOf(cust, t.ids.addon);
  const ask = (question) => cust('POST', `/api/c/quotes/${t.ids.addon}/ask`, { question, versionHash: q.version_hash });
  t.ai.next = { kind: 'selection', answer: 'Hose and labor.', selected_item_ids: ['hose-part', 'oil-change'] };
  assert.equal((await ask('hose')).body.error, 'AI_FAILED');
  t.ai.next = { kind: 'answer', answer: 'I can do the hose for $80.00.', selected_item_ids: [] };
  assert.equal((await ask('discount?')).body.error, 'AI_FAILED');
  t.ai.next = { kind: 'answer', answer: 'The hose part is $38.00 and labor is $65.00, so $103.00 together.', selected_item_ids: [] };
  assert.equal((await ask('how much for the hose?')).status, 200);
  t.ai.next = { kind: 'payment_question', answer: 'You have already been charged $103.', selected_item_ids: [] };
  const pq = await ask('was I charged?');
  assert.equal(pq.body.fixed_text, true);
  assert.match(pq.body.answer, /Nothing has been charged/);
  t.ai.next = new Error('AI_TIMEOUT');
  assert.equal((await ask('anything')).status, 502);
  t.ai.next = { kind: 'handoff', answer: 'I passed your question to the shop. Nothing was approved.', selected_item_ids: [], handoff_reason: 'price_negotiation' };
  assert.equal((await ask('Can you do it for less?')).body.kind, 'handoff');
  const job = (await shop('GET', `/api/shop/jobs/${t.ids.jobId}`)).body;
  assert.ok(job.history.some((e) => e.type === 'question_for_shop'));
  assert.equal((await quoteOf(cust, t.ids.addon)).approval, null, 'assistant never creates an approval');
  assert.equal(t.sim.calls.length, 0, 'assistant never calls PayPal');
  // Stale hash.
  assert.equal((await cust('POST', `/api/c/quotes/${t.ids.addon}/ask`, { question: 'x', versionHash: 'old' })).body.error, 'STALE_QUOTE');
  await t.close();
});

test('secrets never appear in API responses, pages or the PayPal request log', async () => {
  const t = await startTestApp();
  const { shop, cust } = await ready(t);
  const r = await approveAndHold(t, cust, t.ids.base, ['brake-part', 'brake-labor']);
  await shop('POST', `/api/shop/payments/${r.paymentId}/work-done`);
  await shop('POST', `/api/shop/payments/${r.paymentId}/capture`);
  const bodies = [
    (await cust('GET', '/api/c/job')).text,
    (await shop('GET', `/api/shop/jobs/${t.ids.jobId}`)).text,
    (await t.req('GET', '/api/health')).text,
    (await t.req('GET', '/assets/customer.js')).text,
    (await t.req('GET', '/assets/shop.js')).text,
    fs.readFileSync(path.join(t.dir, 'paypal-requests.jsonl'), 'utf8'),
  ];
  const basic = Buffer.from(`${FAKE_ID}:${FAKE_SECRET}`).toString('base64');
  for (const b of bodies) {
    for (const s of [FAKE_ID, FAKE_SECRET, basic, 'A21_fake_access_token', 'Bearer ']) assert.ok(!b.includes(s), `leaked ${s.slice(0, 8)}`);
  }
  const custText = bodies[0];
  assert.ok(!custText.includes('authorization_id') && !custText.includes('request_id'), 'customer view has no internal payment ids');
  const h = await t.req('GET', '/api/health');
  assert.equal(h.headers.get('referrer-policy'), 'no-referrer');
  assert.match(h.headers.get('content-security-policy'), /script-src 'self'/);
  await t.close();
});

test('state survives restart; a request interrupted by a crash becomes "check with PayPal", not a resend', async () => {
  const sim = new FakePayPal();
  const t = await startTestApp({ sim });
  const { shop, cust, link } = await ready(t);
  const r = await approveAndHold(t, cust, t.ids.base, ['brake-part', 'brake-labor']);
  await shop('POST', `/api/shop/payments/${r.paymentId}/work-done`);
  // Simulate a crash mid-capture: an operation stuck in 'sending'.
  t.db.prepare("INSERT INTO operations (payment_id, kind, attempt, request_id, state, started_at) VALUES (?, 'capture', 1, ?, 'sending', ?)").run(r.paymentId, `ra-${r.paymentId}-capture-1`, new Date().toISOString());
  const dir = t.dir;
  const ids = t.ids;
  await t.close();
  const t2 = await startTestApp({ dir, sim });
  const after = await t2.req('GET', '/api/c/job', undefined, { 'X-Customer-Token': link.token });
  assert.equal(after.status, 200);
  const p = after.body.quotes.find((q) => q.id === ids.base).payment;
  assert.equal(p.state, 'needs_check');
  const cookie = await t2.shopLogin(ids.shopKey);
  const rec = await t2.req('POST', `/api/shop/payments/${r.paymentId}/reconcile`, {}, { Cookie: cookie });
  assert.equal(rec.body.state, 'paid', JSON.stringify(rec.body));
  assert.equal(sim.count('POST', CAPTURE_POST), 1);
  // Shop session from before restart is still valid (stored hashed in SQLite).
  assert.equal((await t2.req('GET', `/api/shop/jobs/${ids.jobId}`, undefined, { Cookie: cookie })).status, 200);
  await t2.close();
});

test('sandbox host is fixed and non-allowed PayPal paths are refused', async () => {
  const src = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
  assert.match(src, /PAYPAL_API_BASE = 'https:\/\/api-m\.sandbox\.paypal\.com'/);
  assert.ok(!/api-m\.paypal\.com/.test(src.replace('api-m.sandbox.paypal.com', '')));
  const { PayPalClient } = await import('../src/paypal.js');
  const c = new PayPalClient({ clientId: 'a', clientSecret: 'b', transport: async () => { throw new Error('should not be called'); } });
  await assert.rejects(c.call('POST', '/v2/payments/captures/X/refund'), /PAYPAL_PATH_NOT_ALLOWED/);
});

test('service refuses to build an order whose items no longer sum to the approved total', async () => {
  const t = await startTestApp();
  const { cust } = await ready(t);
  const q = await quoteOf(cust, t.ids.base);
  const d = await cust('POST', `/api/c/quotes/${t.ids.base}/decision`, { decision: 'approved', versionHash: q.version_hash, items: [{ id: 'brake-part' }], expectedTotalCents: 30000 });
  t.db.prepare('UPDATE approvals SET total_cents = 1 WHERE id = ?').run(d.body.approval_id);
  const svc = createService({ db: openDb(t.dir), paypal: null, ai: null, cfg: { publicBaseUrl: 'x' } });
  assert.throws(() => svc._orderPayload({ id: 'pay_x' }, t.db.prepare('SELECT * FROM approvals WHERE id = ?').get(d.body.approval_id)), /APPROVAL_TOTAL_INCONSISTENT/);
  await t.close();
});
