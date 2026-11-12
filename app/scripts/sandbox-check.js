// Real PayPal Sandbox check through the running app's HTTP API. Creates at most 3 synthetic orders.
// Buyer approval in PayPal needs a person in a browser, so this stops at "waiting for PayPal approval"
// and writes the approval links for a human tester to handoff/sandbox-approval-links.json (git-ignored).
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, loadConfig } from '../src/config.js';
import { PayPalClient } from '../src/paypal.js';
import { openDb } from '../src/db.js';
import { createService } from '../src/service.js';

const cfg = loadConfig();
const ROOT = path.resolve(APP_DIR, '..');
const base = cfg.publicBaseUrl;
const out = { at: new Date().toISOString(), environment: 'SANDBOX', app_base: base, steps: [] };
const step = (name, data) => { out.steps.push({ name, ...data }); console.log(name, JSON.stringify(data)); };

let cookie = null;
let custToken = null;
async function call(method, url, body, who) {
  const headers = { 'X-Requested-With': 'repair-approval' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (who === 'shop') headers.Cookie = cookie;
  if (who === 'cust') headers['X-Customer-Token'] = custToken;
  const res = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (url === '/api/shop/login') cookie = res.headers.get('set-cookie')?.split(';')[0];
  return { status: res.status, body: json };
}

const key = fs.readFileSync(path.join(cfg.dataDir, 'shop-key.txt'), 'utf8').trim();
await call('POST', '/api/shop/login', { key });
const { jobs } = (await call('GET', '/api/shop/jobs', undefined, 'shop')).body;
const jobId = jobs[0].id;
const link = (await call('POST', `/api/shop/jobs/${jobId}/customer-link`, undefined, 'shop')).body;
custToken = link.token;
let job = (await call('GET', `/api/shop/jobs/${jobId}`, undefined, 'shop')).body;
const quoteByTitle = (t) => job.quotes.find((q) => q.title.startsWith(t));
for (const t of ['Found during', 'Air filter']) {
  const q = quoteByTitle(t);
  if (q.status === 'draft') await call('POST', `/api/shop/quotes/${q.id}/send`, undefined, 'shop');
}
job = (await call('GET', `/api/shop/jobs/${jobId}`, undefined, 'shop')).body;

const plan = [
  { title: 'Front brake pads', ids: ['brake-part', 'brake-labor'] },
  { title: 'Found during', ids: ['hose-part', 'hose-labor'] },
  { title: 'Air filter', ids: ['filter-part'] },
];
const links = [];
for (const p of plan) {
  const cq = (await call('GET', '/api/c/job', undefined, 'cust')).body.quotes.find((q) => q.title.startsWith(p.title));
  if (cq.payment && cq.payment.state !== 'not_started') { step('skip_existing', { quote: cq.title, state: cq.payment.state }); continue; }
  const items = cq.items.filter((i) => p.ids.includes(i.id));
  const total = items.reduce((s, i) => s + i.unit_cents * i.qty, 0);
  const d = await call('POST', `/api/c/quotes/${cq.id}/decision`, { decision: 'approved', versionHash: cq.version_hash, items: items.map((i) => ({ id: i.id, qty: i.qty })), expectedTotalCents: total }, 'cust');
  step('customer_approved_scope', { quote: cq.title, version: cq.version, status: d.status, total_cents: d.body.total_cents });
  const [c1, c2] = await Promise.all([1, 2].map(() => call('POST', `/api/c/approvals/${d.body.approval_id}/checkout`, undefined, 'cust')));
  const ok = [c1, c2].find((c) => c.status === 200);
  const again = await call('POST', `/api/c/approvals/${d.body.approval_id}/checkout`, undefined, 'cust');
  const orderId = new URL(ok.body.approve_url).searchParams.get('token');
  step('checkout_double_click', { statuses: [c1.status, c2.status], third_call_same_link: again.body.approve_url === ok.body.approve_url, order_id: orderId, approve_host: new URL(ok.body.approve_url).host, payment_label: ok.body.label });
  const early = await call('POST', `/api/c/payments/${ok.body.id}/return`, { orderId }, 'cust');
  step('return_before_buyer_approval', { status: early.status, state: early.body.payment?.state, message: early.body.message });
  const wrong = await call('POST', `/api/c/payments/${ok.body.id}/return`, { orderId: 'NOTTHEORDER1' }, 'cust');
  step('return_with_wrong_order_id', { status: wrong.status, error: wrong.body.error });
  links.push({ quote: cq.title, amount_cents: total, payment_id: ok.body.id, order_id: orderId, approve_url: ok.body.approve_url });
}

// Real idempotency check: resend the app's first create-order request with the same PayPal-Request-Id.
const db = openDb(cfg.dataDir);
const svc = createService({ db, paypal: null, ai: null, cfg });
const op = db.prepare("SELECT * FROM operations WHERE kind = 'create_order' AND state = 'succeeded' ORDER BY id LIMIT 1").get();
if (op) {
  const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(op.payment_id);
  const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(pay.approval_id);
  const paypal = new PayPalClient({ clientId: cfg.paypal.clientId, clientSecret: cfg.paypal.clientSecret, logFile: path.join(cfg.dataDir, 'paypal-requests.jsonl') });
  const replay = await paypal.createOrder(svc._orderPayload(pay, approval), op.request_id);
  step('paypal_request_id_replay', { request_id: op.request_id, original_order: pay.order_id, replay_order: replay.value.id, same_order: replay.value.id === pay.order_id, http_status: replay.status });
}
db.close();

const shopRec = await call('POST', `/api/shop/payments/${links[0]?.payment_id}/reconcile`, {}, 'shop');
step('shop_check_with_paypal_before_buyer_approval', { status: shopRec.status, state: shopRec.body.state });

out.orders_created_by_this_run = links.length;
fs.writeFileSync(path.join(ROOT, 'qa', 'sandbox-check.json'), JSON.stringify(out, null, 2));
fs.mkdirSync(path.join(ROOT, 'handoff'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'handoff', 'sandbox-approval-links.json'), JSON.stringify({ note: 'Local test links. The customer link is a capability token; do not publish it.', customer_link: link.url, links }, null, 2));
console.log('wrote qa/sandbox-check.json and handoff/sandbox-approval-links.json');
