// MOCK PayPal for local tests. Not the real Sandbox. Real Sandbox runs are in scripts/sandbox-check.js.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { PayPalClient } from '../src/paypal.js';
import { createApp } from '../src/server.js';
import { seedJob } from '../scripts/seed-data.js';

const OPEN = new Set();
export async function closeAll() { for (const c of [...OPEN]) await c(); }

export const FAKE_ID = 'TEST_CLIENT_ID_should_never_leak';
export const FAKE_SECRET = 'TEST_SECRET_should_never_leak';

export class FakePayPal {
  constructor() {
    this.n = 0;
    this.orders = new Map();
    this.auths = new Map();
    this.captures = new Map();
    this.idem = new Map();
    this.calls = [];
    this.faults = []; // {match:(method,path)=>bool, mode:'drop'|'lost-response'|'500'}
    this.captureMode = 'minimal'; // 'minimal' | 'full' | 'pending'
  }
  id(prefix) { return `${prefix}${String(++this.n).padStart(6, '0')}`; }
  count(method, re) { return this.calls.filter((c) => c.method === method && re.test(c.path)).length; }
  approve(orderId) { this.orders.get(orderId).status = 'APPROVED'; }

  transport = async (url, init) => {
    const u = new URL(url);
    if (u.host !== 'api-m.sandbox.paypal.com') throw new Error('non-sandbox host');
    const p = u.pathname;
    const method = init.method;
    const rid = init.headers['PayPal-Request-Id'];
    this.calls.push({ method, path: p, rid });
    const fault = this.faults.find((f) => f.match(method, p));
    if (fault) {
      this.faults.splice(this.faults.indexOf(fault), 1);
      if (fault.mode === 'drop') throw new DOMException('timed out', 'TimeoutError');
    }
    let out;
    if (rid && this.idem.has(rid)) out = this.idem.get(rid);
    else {
      out = this.handle(method, p, init.body ? JSON.parse(init.body.startsWith('{') ? init.body : '{}') : {});
      if (rid && out.status < 500) this.idem.set(rid, out);
    }
    if (fault?.mode === 'lost-response') throw new DOMException('timed out', 'TimeoutError');
    if (fault?.mode === '500') out = { status: 500, body: { name: 'INTERNAL_SERVER_ERROR' } };
    const text = JSON.stringify(out.body);
    return { status: out.status, headers: { get: (k) => (k.toLowerCase() === 'paypal-debug-id' ? 'dbg' + this.n : null) }, text: async () => text };
  };

  handle(method, p, body) {
    let m;
    if (p === '/v1/oauth2/token') return { status: 200, body: { access_token: 'A21_fake_access_token', expires_in: 32000 } };
    if (method === 'POST' && p === '/v2/checkout/orders') {
      const id = this.id('ORD');
      const pu = body.purchase_units[0];
      this.orders.set(id, { id, status: 'PAYER_ACTION_REQUIRED', intent: body.intent, purchase_units: [JSON.parse(JSON.stringify(pu))] });
      return { status: 200, body: { id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] } };
    }
    if ((m = /^\/v2\/checkout\/orders\/(\w+)$/.exec(p)) && method === 'GET') {
      const o = this.orders.get(m[1]);
      if (!o) return { status: 404, body: { name: 'RESOURCE_NOT_FOUND' } };
      return { status: 200, body: o };
    }
    if ((m = /^\/v2\/checkout\/orders\/(\w+)\/authorize$/.exec(p))) {
      const o = this.orders.get(m[1]);
      if (o.status !== 'APPROVED') return { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] } };
      const aid = this.id('AUTH');
      const auth = { id: aid, status: 'CREATED', amount: o.purchase_units[0].amount, expiration_time: '2026-12-11T16:05:23Z', order: o.id };
      this.auths.set(aid, auth);
      o.status = 'COMPLETED';
      o.purchase_units[0].payments = { authorizations: [{ id: aid, status: 'CREATED', amount: auth.amount }] };
      return { status: 201, body: o };
    }
    if ((m = /^\/v2\/payments\/authorizations\/(\w+)$/.exec(p))) {
      const a = this.auths.get(m[1]);
      return { status: 200, body: { id: a.id, status: a.status, amount: a.amount, expiration_time: a.expiration_time } };
    }
    if ((m = /^\/v2\/payments\/authorizations\/(\w+)\/capture$/.exec(p))) {
      const a = this.auths.get(m[1]);
      if (a.status !== 'CREATED') return { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'AUTHORIZATION_ALREADY_CAPTURED' }] } };
      const cid = this.id('CAP');
      const status = this.captureMode === 'pending' ? 'PENDING' : 'COMPLETED';
      const cap = { id: cid, status, amount: body.amount, final_capture: body.final_capture, ...(status === 'PENDING' ? { status_details: { reason: 'PENDING_REVIEW' } } : {}) };
      this.captures.set(cid, cap);
      a.status = 'CAPTURED';
      const o = this.orders.get(a.order);
      o.purchase_units[0].payments.captures = [{ id: cid, status, amount: body.amount }];
      return { status: 201, body: this.captureMode === 'full' ? cap : { id: cid, status, links: [] } };
    }
    if ((m = /^\/v2\/payments\/authorizations\/(\w+)\/void$/.exec(p))) {
      const a = this.auths.get(m[1]);
      if (a.status !== 'CREATED') return { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'PREVIOUSLY_CAPTURED' }] } };
      a.status = 'VOIDED';
      return { status: 200, body: { id: a.id, status: 'VOIDED', amount: a.amount } };
    }
    if ((m = /^\/v2\/payments\/captures\/(\w+)$/.exec(p))) {
      return { status: 200, body: this.captures.get(m[1]) };
    }
    return { status: 404, body: { name: 'NOT_FOUND' } };
  }
}

export class FakeAi {
  // MOCK assistant. Returns whatever the test sets; validation runs on it like real output.
  constructor() { this.name = 'mock-ai'; this.model = 'mock'; this.next = null; this.calls = 0; }
  async suggest({ quote }) {
    this.calls++;
    const { validateOutput } = await import('../src/ai.js');
    if (this.next instanceof Error) throw this.next;
    return { output: validateOutput(this.next, quote), model: 'mock', cost_usd: 0 };
  }
}

export async function startTestApp({ dir, sim, ai, clock } = {}) {
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'ra-test-'));
  sim = sim || new FakePayPal();
  ai = ai || new FakeAi();
  const cfg = { publicBaseUrl: 'http://127.0.0.1:0', customerLinkDays: 7, dataDir: dir };
  const db = openDb(dir);
  const paypal = new PayPalClient({ clientId: FAKE_ID, clientSecret: FAKE_SECRET, transport: sim.transport, logFile: path.join(dir, 'paypal-requests.jsonl') });
  const now = clock ? () => clock.now : undefined;
  const app = createApp({ cfg, db, paypal, ai, now });
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let ids = null;
  if (!app.svc.listJobs().length) {
    ids = seedJob(db, app.svc);
    ids.shopKey = app.svc.createShopKey();
  }
  async function req(method, url, body, headers = {}) {
    const res = await fetch(base + url, { method, headers: { 'X-Requested-With': 'repair-approval', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text, headers: res.headers };
  }
  async function shopLogin(key) {
    const r = await req('POST', '/api/shop/login', { key });
    return r.headers.get('set-cookie')?.split(';')[0];
  }
  async function close() {
    if (!OPEN.has(close)) return;
    OPEN.delete(close);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    db.close();
  }
  OPEN.add(close);
  return { dir, sim, ai, app, db, base, req, ids, shopLogin, close };
}

// Shop cookie + a customer link, ready for the customer flow.
export async function ready(t) {
  const cookie = await t.shopLogin(t.ids.shopKey);
  const shop = (method, url, body) => t.req(method, url, body, { Cookie: cookie });
  const link = (await shop('POST', `/api/shop/jobs/${t.ids.jobId}/customer-link`)).body;
  const cust = (method, url, body) => t.req(method, url, body, { 'X-Customer-Token': link.token });
  return { cookie, shop, cust, link };
}

export async function quoteOf(cust, quoteId) {
  const r = await cust('GET', '/api/c/job');
  return r.body.quotes.find((q) => q.id === quoteId);
}

// Customer approves the given item ids, goes to PayPal, the (mock) buyer approves, and the app authorizes.
export async function approveAndHold(t, cust, quoteId, itemIds) {
  const q = await quoteOf(cust, quoteId);
  const items = q.items.filter((i) => itemIds.includes(i.id));
  const total = items.reduce((s, i) => s + i.unit_cents * i.qty, 0);
  const d = await cust('POST', `/api/c/quotes/${quoteId}/decision`, { decision: 'approved', versionHash: q.version_hash, items: items.map((i) => ({ id: i.id, qty: i.qty })), expectedTotalCents: total });
  if (d.status !== 200) throw new Error('decision failed ' + JSON.stringify(d.body));
  const co = await cust('POST', `/api/c/approvals/${d.body.approval_id}/checkout`);
  if (co.status !== 200) throw new Error('checkout failed ' + JSON.stringify(co.body));
  const orderId = new URL(co.body.approve_url).searchParams.get('token');
  t.sim.approve(orderId);
  const ret = await cust('POST', `/api/c/payments/${co.body.id}/return`, { orderId });
  return { approvalId: d.body.approval_id, paymentId: co.body.id, orderId, ret, total };
}
