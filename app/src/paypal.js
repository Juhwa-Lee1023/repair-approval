import fs from 'node:fs';
import path from 'node:path';
import { PAYPAL_API_BASE } from './config.js';

export class PayPalError extends Error {
  constructor(kind, message, info = {}) {
    super(message);
    this.kind = kind; // 'http' (definite answer from PayPal) or 'transport' (outcome unknown)
    Object.assign(this, info);
  }
}

// Keep only what review needs: no payer names, emails, addresses, tokens or credentials.
export function extract(value) {
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const k of ['id', 'status', 'intent', 'amount', 'final_capture', 'name', 'debug_id', 'expiration_time', 'status_details']) if (k in value) out[k] = value[k];
  if (Array.isArray(value.details)) out.details = value.details.map((d) => ({ issue: d.issue, description: d.description, field: d.field }));
  if (Array.isArray(value.purchase_units)) {
    out.purchase_units = value.purchase_units.map((pu) => {
      const u = {};
      for (const k of ['reference_id', 'custom_id', 'invoice_id', 'amount', 'items']) if (k in pu) u[k] = pu[k];
      if (pu.payments) {
        u.payments = {};
        for (const [k, v] of Object.entries(pu.payments)) u.payments[k] = v.map(extract);
      }
      return u;
    });
  }
  return out;
}

const ALLOWED = [
  ['POST', /^\/v1\/oauth2\/token$/],
  ['POST', /^\/v2\/checkout\/orders$/],
  ['GET', /^\/v2\/checkout\/orders\/[A-Z0-9]+$/],
  ['POST', /^\/v2\/checkout\/orders\/[A-Z0-9]+\/authorize$/],
  ['GET', /^\/v2\/payments\/authorizations\/[A-Z0-9]+$/],
  ['POST', /^\/v2\/payments\/authorizations\/[A-Z0-9]+\/(capture|void)$/],
  ['GET', /^\/v2\/payments\/captures\/[A-Z0-9]+$/],
];

export class PayPalClient {
  // transport(url, init) -> {status, headers:{get}, text()} ; defaults to global fetch.
  constructor({ clientId, clientSecret, transport, logFile, timeoutMs = 25000 }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.transport = transport || fetch;
    this.logFile = logFile;
    this.timeoutMs = timeoutMs;
    this.token = null;
    this.tokenExp = 0;
  }

  get configured() { return Boolean(this.clientId && this.clientSecret); }

  log(event) {
    if (!this.logFile) return;
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    fs.appendFileSync(this.logFile, JSON.stringify({ at_utc: new Date().toISOString(), environment: 'SANDBOX', ...event }) + '\n');
  }

  async call(method, apiPath, { body, requestId, auth } = {}) {
    if (!ALLOWED.some(([m, re]) => m === method && re.test(apiPath))) throw new Error('PAYPAL_PATH_NOT_ALLOWED');
    const headers = { Accept: 'application/json' };
    let data;
    if (auth) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers.Authorization = 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      data = 'grant_type=client_credentials';
    } else {
      headers['Content-Type'] = 'application/json';
      headers.Authorization = 'Bearer ' + (await this.accessToken());
      headers.Prefer = 'return=representation';
      if (body !== undefined) data = JSON.stringify(body);
    }
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    const started = Date.now();
    let res;
    try {
      res = await this.transport(PAYPAL_API_BASE + apiPath, { method, headers, body: data, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      this.log({ method, path: apiPath, request_id: requestId || null, status: 'TRANSPORT_ERROR', error: String(e.name || e.message), automatic_retry: false });
      throw new PayPalError('transport', 'No answer from PayPal. The outcome is unknown.', { requestId });
    }
    const text = await res.text();
    let value = {};
    try { value = text ? JSON.parse(text) : {}; } catch { value = { unparsed: true }; }
    const debugId = res.headers.get('paypal-debug-id');
    const event = { method, path: apiPath, http_status: res.status, debug_id: debugId, seconds: (Date.now() - started) / 1000, request_id: requestId || null };
    event.response = auth ? { token_returned: Boolean(value.access_token), error: value.error || null } : extract(value);
    this.log(event);
    if (res.status >= 500) throw new PayPalError('transport', `PayPal returned ${res.status}. The outcome is unknown.`, { status: res.status, debugId, response: extract(value) });
    if (res.status >= 400) {
      const issue = value?.details?.[0]?.issue || value?.name || value?.error || 'ERROR';
      throw new PayPalError('http', `PayPal declined the request (${issue}).`, { status: res.status, debugId, issue, response: extract(value) });
    }
    return { status: res.status, debugId, value };
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExp) return this.token;
    if (!this.configured) throw new PayPalError('http', 'PayPal Sandbox credentials are not configured on the server.', { issue: 'CONFIG_REQUIRED' });
    const { value } = await this.call('POST', '/v1/oauth2/token', { auth: true });
    this.token = value.access_token;
    this.tokenExp = Date.now() + Math.max(60, (value.expires_in || 300) - 120) * 1000;
    return this.token;
  }

  createOrder(payload, requestId) { return this.call('POST', '/v2/checkout/orders', { body: payload, requestId }); }
  getOrder(id) { return this.call('GET', `/v2/checkout/orders/${id}`); }
  authorizeOrder(id, requestId) { return this.call('POST', `/v2/checkout/orders/${id}/authorize`, { body: {}, requestId }); }
  getAuthorization(id) { return this.call('GET', `/v2/payments/authorizations/${id}`); }
  captureAuthorization(id, body, requestId) { return this.call('POST', `/v2/payments/authorizations/${id}/capture`, { body, requestId }); }
  voidAuthorization(id, requestId) { return this.call('POST', `/v2/payments/authorizations/${id}/void`, { body: {}, requestId }); }
  getCapture(id) { return this.call('GET', `/v2/payments/captures/${id}`); }
}
