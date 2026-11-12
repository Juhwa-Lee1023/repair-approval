import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, configSummary, APP_DIR } from './config.js';
import { openDb } from './db.js';
import { PayPalClient } from './paypal.js';
import { createService, AppError } from './service.js';
import { ClaudeCliProvider } from './ai.js';

const PUBLIC = path.join(APP_DIR, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': isJson ? 'application/json; charset=utf-8' : headers['Content-Type'] || 'text/plain', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

function sendFile(res, file) {
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC + path.sep) || !fs.existsSync(full)) return send(res, 404, 'Not found');
  send(res, 200, fs.readFileSync(full), { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
}

async function readJson(req) {
  if (!/^application\/json/.test(req.headers['content-type'] || '')) throw new AppError(415, 'JSON_REQUIRED', 'Send JSON.');
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 32_768) throw new AppError(413, 'TOO_LARGE', 'Request too large.');
    chunks.push(c);
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { throw new AppError(400, 'BAD_JSON', 'Invalid JSON.'); }
}

function cookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

export function createApp({ cfg, db, paypal, ai, now }) {
  const svc = createService({ db, paypal, ai, cfg, now });
  const recovered = svc.recoverInterrupted();

  const routes = [];
  const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[A-Za-z0-9_-]+)') + '$'), handler, ...opts });

  // ----- shop (owner session cookie) -----
  route('POST', '/api/shop/login', async (req, res) => {
    const body = await readJson(req);
    const { session } = svc.shopLogin(body.key);
    send(res, 200, { ok: true }, { 'Set-Cookie': `ra_shop=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` });
  });
  route('POST', '/api/shop/logout', async (req, res) => {
    svc.shopLogout(cookie(req, 'ra_shop'));
    send(res, 200, { ok: true }, { 'Set-Cookie': 'ra_shop=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  });
  route('GET', '/api/shop/jobs', (req, res) => send(res, 200, { jobs: svc.listJobs() }), { shop: true });
  route('GET', '/api/shop/jobs/:id', (req, res, p) => send(res, 200, svc.jobView(p.id, true)), { shop: true });
  route('POST', '/api/shop/jobs/:id/customer-link', (req, res, p) => send(res, 200, svc.issueCustomerLink(p.id)), { shop: true });
  route('POST', '/api/shop/quotes/:id/send', (req, res, p) => { svc.sendQuote(p.id); send(res, 200, { ok: true }); }, { shop: true });
  route('POST', '/api/shop/quotes/:id/versions', async (req, res, p) => send(res, 200, svc.editQuote(p.id, await readJson(req))), { shop: true });
  route('POST', '/api/shop/payments/:id/work-done', (req, res, p) => send(res, 200, svc.markWorkDone(p.id)), { shop: true });
  route('POST', '/api/shop/payments/:id/capture', async (req, res, p) => send(res, 200, await svc.capture(p.id)), { shop: true });
  route('POST', '/api/shop/payments/:id/cancel', async (req, res, p) => send(res, 200, await svc.cancelWork(p.id, (await readJson(req)).reason)), { shop: true });
  route('POST', '/api/shop/payments/:id/reconcile', async (req, res, p) => send(res, 200, await svc.reconcile(p.id)), { shop: true });

  // ----- customer (capability token in header) -----
  route('GET', '/api/c/job', (req, res, p, jobId) => send(res, 200, svc.jobView(jobId, false)), { customer: true });
  route('POST', '/api/c/quotes/:id/decision', async (req, res, p, jobId) => {
    const out = svc.decide(jobId, p.id, await readJson(req));
    send(res, 200, { approval_id: out.approval.id, decision: out.approval.decision, total_cents: out.approval.total_cents, repeated: out.repeated });
  }, { customer: true });
  route('POST', '/api/c/quotes/:id/ask', async (req, res, p, jobId) => send(res, 200, await svc.ask(jobId, p.id, await readJson(req))), { customer: true });
  route('POST', '/api/c/approvals/:id/checkout', async (req, res, p, jobId) => send(res, 200, await svc.startCheckout(jobId, p.id)), { customer: true });
  route('POST', '/api/c/payments/:id/return', async (req, res, p, jobId) => send(res, 200, await svc.handleReturn(jobId, p.id, (await readJson(req)).orderId)), { customer: true });
  route('POST', '/api/c/payments/:id/closed', async (req, res, p, jobId) => send(res, 200, svc.markBuyerClosed(jobId, p.id, (await readJson(req)).orderId)), { customer: true });

  route('GET', '/api/health', (req, res) => send(res, 200, { ok: true, paypal: 'sandbox', paypal_configured: paypal.configured, ai_provider: ai ? ai.name : 'off', interrupted_operations_recovered: recovered }));

  // ----- pages -----
  route('GET', '/', (req, res) => send(res, 302, '', { Location: '/shop' }));
  route('GET', '/shop', (req, res) => sendFile(res, 'shop.html'));
  route('GET', '/shop/login', (req, res) => sendFile(res, 'login.html'));
  route('GET', '/c/:token', (req, res) => sendFile(res, 'customer.html'));
  route('GET', '/paypal/return', (req, res) => sendFile(res, 'customer.html'));
  route('GET', '/paypal/cancel', (req, res) => sendFile(res, 'customer.html'));

  return {
    svc,
    async handle(req, res) {
      const url = new URL(req.url, 'http://local');
      const pathname = url.pathname;
      const asset = /^\/assets\/([a-z0-9-]+\.(?:css|js|svg))$/.exec(pathname);
      if (req.method === 'GET' && asset) return sendFile(res, asset[1]);
      try {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(pathname);
          if (!m) continue;
          if (req.method === 'POST' && req.headers['x-requested-with'] !== 'repair-approval') throw new AppError(403, 'CSRF', 'Missing request header.');
          if (r.shop) svc.checkShopSession(cookie(req, 'ra_shop'));
          const jobId = r.customer ? svc.customerJobId(req.headers['x-customer-token']) : null;
          return await r.handler(req, res, m.groups || {}, jobId);
        }
        send(res, 404, { error: 'NOT_FOUND', message: 'Not found.' });
      } catch (e) {
        if (e instanceof AppError) return send(res, e.status, { error: e.code, message: e.message, ...e.extra });
        console.error('[server] unexpected error:', e?.message);
        send(res, 500, { error: 'SERVER_ERROR', message: 'We could not confirm the result. Check the payment status before trying again.' });
      }
    },
  };
}

export function start() {
  const cfg = loadConfig();
  const db = openDb(cfg.dataDir);
  const paypal = new PayPalClient({ clientId: cfg.paypal.clientId, clientSecret: cfg.paypal.clientSecret, logFile: path.join(cfg.dataDir, 'paypal-requests.jsonl') });
  let ai = null;
  if (cfg.aiProvider === 'claude-cli') {
    const cwd = path.join(cfg.dataDir, 'ai-cwd');
    fs.mkdirSync(cwd, { recursive: true });
    ai = new ClaudeCliProvider({ model: cfg.aiModel, timeoutMs: cfg.aiTimeoutMs, cwd });
  }
  const app = createApp({ cfg, db, paypal, ai });
  const server = http.createServer((req, res) => app.handle(req, res));
  server.listen(cfg.port, '127.0.0.1', () => {
    console.log(`Repair Approval running at ${cfg.publicBaseUrl}  (PayPal Sandbox only)`);
    console.log('Config:', JSON.stringify(configSummary(cfg)));
    if (!app.svc.listJobs().length) console.log('No job yet. Run `npm run seed` to create the sample job and shop key.');
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) start();
