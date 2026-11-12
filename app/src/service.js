import crypto from 'node:crypto';
import { tx } from './db.js';
import { PAYPAL_APPROVAL_PREFIX } from './config.js';
import { PayPalError } from './paypal.js';
import { toPayPalValue, fromPayPalValue, sumItems, formatUSD } from './money.js';

export class AppError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
export const newSecret = () => crypto.randomBytes(24).toString('base64url');

export function versionHash(quoteId, version, note, items) {
  const canon = items.map((i) => ({ id: i.id, sku: i.sku, name: i.name, qty: i.qty, unit_cents: i.unit_cents, reason: i.reason || '' }));
  return sha256(JSON.stringify({ quoteId, version, note, items: canon }));
}

// Payment states that mean PayPal has (or may have) an authorization for this approval.
const LOCKING_STATES = new Set(['authorizing', 'held', 'auth_pending', 'capturing', 'capture_pending', 'paid', 'capture_declined', 'voiding', 'released', 'needs_check']);

// Fixed wording for money questions. The assistant never writes these.
export function paymentText(p) {
  if (!p) return { label: 'Not charged', text: 'Nothing has been charged. Approve the work first.' };
  const amt = formatUSD(p.amount_cents);
  switch (p.state) {
    case 'not_started':
    case 'creating':
      return { label: 'Not charged', text: `Nothing has been charged. Continue to PayPal to hold ${amt} for this work.` };
    case 'awaiting_buyer':
      return p.buyer_closed_at
        ? { label: 'Waiting for PayPal approval', text: `You left PayPal before approving. Nothing is held or charged. Your work choice is saved; continue to PayPal when you are ready.` }
        : { label: 'Waiting for PayPal approval', text: `Nothing is held or charged yet. Approve ${amt} in PayPal to finish.` };
    case 'authorizing':
      return { label: 'Confirming with PayPal', text: 'We are confirming your PayPal approval. Nothing has been charged.' };
    case 'held':
    case 'auth_pending':
      return { label: 'Held, not charged', text: `PayPal is holding ${amt}. You are not charged until the shop finishes this work. If the shop cancels it, the hold is released.` };
    case 'capturing':
      return { label: 'Charging', text: `The shop finished this work and is charging ${amt}.` };
    case 'capture_pending':
      return { label: 'Charge pending at PayPal', text: `PayPal is still processing the ${amt} charge. The shop will see the result here.` };
    case 'paid':
      return { label: 'Charged', text: `You were charged ${amt} for this work.` };
    case 'capture_declined':
      return { label: 'Charge failed', text: `PayPal did not complete the ${amt} charge. The shop will contact you.` };
    case 'voiding':
      return { label: 'Releasing hold', text: 'The shop cancelled this work and is releasing the hold. You will not be charged for it.' };
    case 'released':
      return { label: 'Hold released, not charged', text: `The shop cancelled this work. The ${amt} hold was released and you were not charged. Your bank may take a few days to show the released amount.` };
    case 'auth_expired':
      return { label: 'Hold expired, not charged', text: 'The PayPal hold expired before the shop charged it. You were not charged.' };
    case 'abandoned':
      return { label: 'Not charged', text: 'Nothing was held or charged for this choice.' };
    case 'needs_check':
      return { label: 'Checking with PayPal', text: 'The shop is confirming this payment with PayPal. You do not need to do anything.' };
    default:
      return { label: 'Not charged', text: 'Nothing has been charged.' };
  }
}

export function createService({ db, paypal, ai, cfg, now = () => new Date() }) {
  const iso = () => now().toISOString();
  const locks = new Set();

  const q = {
    job: db.prepare('SELECT * FROM jobs WHERE id = ?'),
    jobs: db.prepare('SELECT * FROM jobs ORDER BY created_at'),
    quote: db.prepare('SELECT * FROM quotes WHERE id = ?'),
    quotesByJob: db.prepare('SELECT * FROM quotes WHERE job_id = ? ORDER BY seq'),
    version: db.prepare('SELECT * FROM quote_versions WHERE quote_id = ? AND version = ?'),
    versions: db.prepare('SELECT * FROM quote_versions WHERE quote_id = ? ORDER BY version'),
    approval: db.prepare('SELECT * FROM approvals WHERE id = ?'),
    currentApproval: db.prepare("SELECT * FROM approvals WHERE quote_id = ? AND status IN ('current','cancelled') ORDER BY created_at DESC, rowid DESC LIMIT 1"),
    approvalsByQuote: db.prepare('SELECT * FROM approvals WHERE quote_id = ? ORDER BY created_at'),
    payment: db.prepare('SELECT * FROM payments WHERE id = ?'),
    paymentByApproval: db.prepare('SELECT * FROM payments WHERE approval_id = ?'),
    ops: db.prepare('SELECT * FROM operations WHERE payment_id = ? ORDER BY id'),
    lastOp: db.prepare('SELECT * FROM operations WHERE payment_id = ? AND kind = ? ORDER BY attempt DESC LIMIT 1'),
    events: db.prepare('SELECT * FROM events WHERE job_id = ? ORDER BY id DESC LIMIT 200'),
  };

  function event(jobId, quoteId, actor, type, detail = {}) {
    db.prepare('INSERT INTO events (job_id, quote_id, at, actor, type, detail_json) VALUES (?,?,?,?,?,?)')
      .run(jobId, quoteId, iso(), actor, type, JSON.stringify(detail));
  }

  function setPayment(id, fields) {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE payments SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), iso(), id);
  }

  function loadVersion(quote, version = quote.current_version) {
    const v = q.version.get(quote.id, version);
    return { ...v, items: JSON.parse(v.items_json) };
  }

  // ---------- quotes ----------

  function validateItems(items) {
    if (!Array.isArray(items) || items.length < 1 || items.length > 12) throw new AppError(400, 'INVALID_ITEMS', 'A quote needs 1 to 12 items.');
    const seen = new Set();
    return items.map((raw, i) => {
      const name = String(raw.name || '').trim();
      const sku = String(raw.sku || '').trim().toUpperCase();
      const qty = Number(raw.qty);
      const unit = Number(raw.unit_cents);
      const id = String(raw.id || sku.toLowerCase() || `item-${i + 1}`).trim();
      if (!name || name.length > 80) throw new AppError(400, 'INVALID_ITEMS', 'Each item needs a name (80 characters max).');
      if (!/^[A-Z0-9-]{1,30}$/.test(sku)) throw new AppError(400, 'INVALID_ITEMS', 'SKU must be letters, digits or dashes.');
      if (!/^[a-z0-9-]{1,40}$/.test(id) || seen.has(id)) throw new AppError(400, 'INVALID_ITEMS', 'Item IDs must be unique.');
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw new AppError(400, 'INVALID_ITEMS', 'Quantity must be a whole number from 1 to 20.');
      if (!Number.isInteger(unit) || unit < 1 || unit > 1_000_000) throw new AppError(400, 'INVALID_ITEMS', 'Unit price must be between $0.01 and $10,000.');
      seen.add(id);
      return { id, sku, name, qty, unit_cents: unit, reason: String(raw.reason || '').trim().slice(0, 300) };
    });
  }

  function insertVersion(quoteId, version, note, items) {
    const hash = versionHash(quoteId, version, note, items);
    db.prepare('INSERT INTO quote_versions (quote_id, version, note, items_json, total_cents, hash, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(quoteId, version, note, JSON.stringify(items), sumItems(items), hash, iso());
    return hash;
  }

  function createQuote({ jobId, kind, title, note, items, status = 'draft' }) {
    const clean = validateItems(items);
    return tx(db, () => {
      const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM quotes WHERE job_id = ?').get(jobId).m) + 1;
      const id = newId('qt');
      db.prepare('INSERT INTO quotes (id, job_id, seq, kind, title, status, current_version, sent_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, jobId, seq, kind, title, status, 1, status === 'sent' ? iso() : null, iso());
      insertVersion(id, 1, note, clean);
      event(jobId, id, 'shop', 'quote_created', { title, version: 1, total_cents: sumItems(clean) });
      return id;
    });
  }

  function editQuote(quoteId, { baseVersion, note, items }) {
    const clean = validateItems(items);
    const noteText = String(note || '').trim().slice(0, 1000);
    if (!noteText) throw new AppError(400, 'NOTE_REQUIRED', 'Add a note that explains the work to the customer.');
    return tx(db, () => {
      const quote = q.quote.get(quoteId);
      if (!quote) throw new AppError(404, 'NOT_FOUND', 'Quote not found.');
      if (Number(baseVersion) !== quote.current_version) throw new AppError(409, 'STALE_EDIT', 'Someone changed this quote. Reload before editing.');
      for (const a of q.approvalsByQuote.all(quoteId)) {
        const p = q.paymentByApproval.get(a.id);
        if (p && LOCKING_STATES.has(p.state) && p.state !== 'released') {
          throw new AppError(409, 'PAYMENT_LOCKED', 'PayPal has an active or completed payment for this quote. Release the hold before changing it, or create a new add-on quote.');
        }
      }
      const cur = q.currentApproval.get(quoteId);
      if (cur) {
        db.prepare("UPDATE approvals SET status = 'stale', updated_at = ? WHERE id = ?").run(iso(), cur.id);
        const p = q.paymentByApproval.get(cur.id);
        if (p && ['not_started', 'awaiting_buyer'].includes(p.state)) setPayment(p.id, { state: 'abandoned' });
      }
      const version = quote.current_version + 1;
      const hash = insertVersion(quoteId, version, noteText, clean);
      db.prepare('UPDATE quotes SET current_version = ? WHERE id = ?').run(version, quoteId);
      event(quote.job_id, quoteId, 'shop', 'quote_revised', { version, total_cents: sumItems(clean), customer_choice_cleared: Boolean(cur) });
      return { version, hash };
    });
  }

  function sendQuote(quoteId) {
    const quote = q.quote.get(quoteId);
    if (!quote) throw new AppError(404, 'NOT_FOUND', 'Quote not found.');
    if (quote.status === 'sent') return;
    db.prepare("UPDATE quotes SET status = 'sent', sent_at = ? WHERE id = ?").run(iso(), quoteId);
    event(quote.job_id, quoteId, 'shop', 'quote_sent', { version: quote.current_version });
  }

  // ---------- tokens ----------

  function issueCustomerLink(jobId) {
    if (!q.job.get(jobId)) throw new AppError(404, 'NOT_FOUND', 'Job not found.');
    const token = newSecret();
    const expires = new Date(now().getTime() + cfg.customerLinkDays * 86400_000).toISOString();
    db.prepare("INSERT INTO tokens (hash, kind, job_id, expires_at, created_at) VALUES (?, 'customer', ?, ?, ?)").run(sha256(token), jobId, expires, iso());
    event(jobId, null, 'shop', 'customer_link_created', { expires_at: expires });
    return { url: `${cfg.publicBaseUrl}/c/${token}`, token, expires_at: expires };
  }

  function customerJobId(token) {
    if (!token || typeof token !== 'string' || token.length > 100) throw new AppError(401, 'LINK_INVALID', 'This link is not valid. Ask the shop for a new one.');
    const row = db.prepare("SELECT * FROM tokens WHERE hash = ? AND kind = 'customer'").get(sha256(token));
    if (!row || row.revoked_at) throw new AppError(401, 'LINK_INVALID', 'This link is not valid. Ask the shop for a new one.');
    if (row.expires_at && row.expires_at <= iso()) throw new AppError(401, 'LINK_EXPIRED', 'This link has expired. Ask the shop to send a new one.');
    return row.job_id;
  }

  function createShopKey() {
    const key = newSecret();
    db.prepare("INSERT INTO tokens (hash, kind, created_at) VALUES (?, 'shop_key', ?)").run(sha256(key), iso());
    return key;
  }

  function shopLogin(key) {
    if (typeof key !== 'string' || key.length > 100) throw new AppError(401, 'SHOP_KEY_INVALID', 'That shop key is not valid.');
    const row = db.prepare("SELECT * FROM tokens WHERE hash = ? AND kind = 'shop_key' AND revoked_at IS NULL").get(sha256(key));
    if (!row) throw new AppError(401, 'SHOP_KEY_INVALID', 'That shop key is not valid.');
    const session = newSecret();
    const expires = new Date(now().getTime() + 12 * 3600_000).toISOString();
    db.prepare("INSERT INTO tokens (hash, kind, expires_at, created_at) VALUES (?, 'shop_session', ?, ?)").run(sha256(session), expires, iso());
    return { session, expires_at: expires };
  }

  function checkShopSession(session) {
    if (!session) throw new AppError(401, 'SHOP_LOGIN_REQUIRED', 'Sign in with the shop key.');
    const row = db.prepare("SELECT * FROM tokens WHERE hash = ? AND kind = 'shop_session'").get(sha256(session));
    if (!row || row.revoked_at || row.expires_at <= iso()) throw new AppError(401, 'SHOP_LOGIN_REQUIRED', 'Sign in with the shop key.');
  }

  function shopLogout(session) {
    if (session) db.prepare("UPDATE tokens SET revoked_at = ? WHERE hash = ? AND kind = 'shop_session'").run(iso(), sha256(session));
  }

  // ---------- views ----------

  function paymentView(p, forShop) {
    if (!p) return null;
    const v = {
      id: p.id, state: p.state, amount_cents: p.amount_cents, currency: p.currency,
      ...paymentText(p),
      approve_url: p.state === 'awaiting_buyer' ? p.approve_url : null,
      held_until: p.auth_expires_at, work_done_at: p.work_done_at, buyer_closed_at: p.buyer_closed_at,
      updated_at: p.updated_at,
    };
    if (forShop) {
      Object.assign(v, { order_id: p.order_id, authorization_id: p.authorization_id, capture_id: p.capture_id, capture_status: p.capture_status, last_error: p.last_error });
      v.operations = q.ops.all(p.id).map((o) => ({ kind: o.kind, attempt: o.attempt, state: o.state, http_status: o.http_status, request_id: o.request_id, remote_id: o.remote_id, debug_id: o.debug_id, error: o.error, started_at: o.started_at, finished_at: o.finished_at }));
    }
    return v;
  }

  function quoteView(quote, forShop) {
    const v = loadVersion(quote);
    const cur = q.currentApproval.get(quote.id);
    const pay = cur ? q.paymentByApproval.get(cur.id) : null;
    const out = {
      id: quote.id, seq: quote.seq, kind: quote.kind, title: quote.title, status: quote.status, sent_at: quote.sent_at,
      version: v.version, version_hash: v.hash, version_created_at: v.created_at, note: v.note,
      items: v.items, total_cents: v.total_cents,
      approval: cur ? { id: cur.id, status: cur.status, decision: cur.decision, version: cur.version, version_hash: cur.version_hash, selected: JSON.parse(cur.selected_json), total_cents: cur.total_cents, created_at: cur.created_at, from_ai_suggestion: Boolean(cur.ai_suggestion_id) } : null,
      payment: paymentView(pay, forShop),
    };
    if (forShop) {
      out.versions = q.versions.all(quote.id).map((x) => ({ version: x.version, hash: x.hash, total_cents: x.total_cents, created_at: x.created_at }));
      out.past_choices = q.approvalsByQuote.all(quote.id).filter((a) => a.status !== 'current').map((a) => {
        const p = q.paymentByApproval.get(a.id);
        return { id: a.id, decision: a.decision, version: a.version, status: a.status, total_cents: a.total_cents, created_at: a.created_at, payment: paymentView(p, true) };
      });
    }
    return out;
  }

  function jobView(jobId, forShop) {
    const job = q.job.get(jobId);
    if (!job) throw new AppError(404, 'NOT_FOUND', 'Job not found.');
    const quotes = q.quotesByJob.all(jobId).filter((x) => forShop || x.status === 'sent').map((x) => quoteView(x, forShop));
    const out = { job: { id: job.id, ref: job.ref, customer_name: job.customer_name, vehicle: job.vehicle, shop_name: job.shop_name }, quotes };
    if (forShop) out.history = q.events.all(jobId).map((e) => ({ at: e.at, actor: e.actor, type: e.type, quote_id: e.quote_id, detail: JSON.parse(e.detail_json) }));
    return out;
  }

  // ---------- customer decisions ----------

  function customerQuote(jobId, quoteId) {
    const quote = q.quote.get(quoteId);
    if (!quote || quote.job_id !== jobId || quote.status !== 'sent') throw new AppError(404, 'NOT_FOUND', 'This quote is not part of your repair.');
    return quote;
  }

  function decide(jobId, quoteId, body) {
    const decision = body?.decision;
    if (!['approved', 'declined', 'deferred'].includes(decision)) throw new AppError(400, 'INVALID_DECISION', 'Choose approve, decline or decide later.');
    return tx(db, () => {
      const quote = customerQuote(jobId, quoteId);
      const v = loadVersion(quote);
      if (body.versionHash !== v.hash) throw new AppError(409, 'STALE_QUOTE', 'The shop updated this quote. Review the new version before you decide.', { current_version: v.version });
      const byId = new Map(v.items.map((i) => [i.id, i]));
      const picked = Array.isArray(body.items) ? body.items : [];
      const selected = [];
      const seen = new Set();
      for (const p of picked) {
        const item = byId.get(p?.id);
        if (!item) throw new AppError(400, 'UNKNOWN_ITEM', 'One of the selected items is not on this quote.');
        if (seen.has(item.id)) throw new AppError(400, 'DUPLICATE_ITEM', 'An item was selected twice.');
        if (p.qty !== undefined && Number(p.qty) !== item.qty) throw new AppError(400, 'INVALID_QUANTITY', 'Quantities are set by the shop and cannot be changed here.');
        for (const k of ['unit_cents', 'price', 'amount', 'name']) if (k in p) throw new AppError(400, 'PRICE_FIELDS_NOT_ACCEPTED', 'Prices come from the shop quote only.');
        seen.add(item.id);
        selected.push(item);
      }
      if (decision === 'approved' && selected.length === 0) throw new AppError(400, 'NOTHING_SELECTED', 'Select at least one item, or decline the quote.');
      if (decision !== 'approved' && selected.length) throw new AppError(400, 'UNEXPECTED_ITEMS', 'Declining or deciding later does not take items.');
      const total = decision === 'approved' ? sumItems(selected) : 0;
      if (decision === 'approved' && body.expectedTotalCents !== total) throw new AppError(409, 'TOTAL_MISMATCH', 'The total on your screen does not match the quote. Reload and review again.');

      let aiId = null;
      if (body.aiSuggestionId) {
        const s = db.prepare('SELECT * FROM ai_suggestions WHERE id = ?').get(body.aiSuggestionId);
        if (!s || s.quote_id !== quoteId || s.version_hash !== v.hash) throw new AppError(409, 'STALE_SUGGESTION', 'That suggestion was for an older version of the quote. Choose items again.');
        aiId = s.id;
      }

      const selectedIds = selected.map((i) => i.id);
      const cur = q.currentApproval.get(quoteId);
      if (cur) {
        const p = q.paymentByApproval.get(cur.id);
        if (p && LOCKING_STATES.has(p.state)) throw new AppError(409, 'PAYMENT_LOCKED', 'This work already has a PayPal hold or charge. Contact the shop to change it.');
        if (cur.version_hash === v.hash && cur.decision === decision && cur.selected_json === JSON.stringify(selectedIds)) return { approval: q.approval.get(cur.id), repeated: true };
        db.prepare("UPDATE approvals SET status = 'replaced', updated_at = ? WHERE id = ?").run(iso(), cur.id);
        if (p) setPayment(p.id, { state: 'abandoned' });
      }
      const id = newId('ap');
      db.prepare("INSERT INTO approvals (id, quote_id, version, version_hash, decision, selected_json, total_cents, ai_suggestion_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?, 'current', ?, ?)")
        .run(id, quoteId, v.version, v.hash, decision, JSON.stringify(selectedIds), total, aiId, iso(), iso());
      event(jobId, quoteId, 'customer', `scope_${decision}`, { version: v.version, version_hash: v.hash, items: selectedIds, total_cents: total, declined_items: v.items.filter((i) => !seen.has(i.id)).map((i) => i.id), used_ai_suggestion: Boolean(aiId) });
      return { approval: q.approval.get(id), repeated: false };
    });
  }

  // ---------- PayPal operations ----------

  function reserveOp(paymentId, kind, { reuseUnknown = false } = {}) {
    return tx(db, () => {
      const last = q.lastOp.get(paymentId, kind);
      if (last?.state === 'sending') throw new AppError(409, 'IN_PROGRESS', 'This PayPal step is already running. Wait a moment and refresh.');
      if (last?.state === 'succeeded') return { op: last, done: true };
      if (last?.state === 'unknown') {
        if (!reuseUnknown) throw new AppError(409, 'NEEDS_CHECK', 'The last PayPal request did not return an answer. Use "Check with PayPal" first.');
        db.prepare("UPDATE operations SET state = 'sending', started_at = ? WHERE id = ?").run(iso(), last.id);
        return { op: { ...last, state: 'sending' }, done: false };
      }
      const attempt = (last?.attempt || 0) + 1;
      const requestId = `ra-${paymentId}-${kind}-${attempt}`;
      db.prepare("INSERT INTO operations (payment_id, kind, attempt, request_id, state, started_at) VALUES (?,?,?,?, 'sending', ?)").run(paymentId, kind, attempt, requestId, iso());
      return { op: q.lastOp.get(paymentId, kind), done: false };
    });
  }

  function finishOp(op, state, info = {}) {
    db.prepare('UPDATE operations SET state = ?, http_status = ?, debug_id = ?, remote_id = ?, error = ?, finished_at = ? WHERE id = ?')
      .run(state, info.status ?? null, info.debugId ?? null, info.remoteId ?? null, info.error ?? null, iso(), op.id);
  }

  async function runOp(payment, kind, fn, { reuseUnknown = false } = {}) {
    const { op, done } = reserveOp(payment.id, kind, { reuseUnknown });
    if (done) return { alreadyDone: true, op };
    try {
      const res = await fn(op.request_id);
      finishOp(op, 'succeeded', { status: res.status, debugId: res.debugId, remoteId: res.value?.id });
      return { res, op };
    } catch (e) {
      if (e instanceof PayPalError && e.kind === 'http') {
        finishOp(op, 'failed', { status: e.status, debugId: e.debugId, error: e.issue || e.message });
      } else {
        finishOp(op, 'unknown', { status: e.status, debugId: e.debugId, error: e.message });
        setPayment(payment.id, { state: 'needs_check', last_error: `${kind}: no answer from PayPal. Use "Check with PayPal".` });
      }
      throw e;
    }
  }

  async function withLock(paymentId, fn) {
    if (locks.has(paymentId)) throw new AppError(409, 'IN_PROGRESS', 'Another action on this payment is running. Wait a moment and refresh.');
    locks.add(paymentId);
    try { return await fn(); } finally { locks.delete(paymentId); }
  }

  function expectedFor(approval) {
    const quote = q.quote.get(approval.quote_id);
    const v = loadVersion(quote, approval.version);
    const ids = JSON.parse(approval.selected_json);
    const items = ids.map((id) => v.items.find((i) => i.id === id));
    const total = sumItems(items);
    if (total !== approval.total_cents) throw new Error('APPROVAL_TOTAL_INCONSISTENT');
    return { quote, version: v, items, total };
  }

  function orderPayload(payment, approval) {
    const { quote, version, items, total } = expectedFor(approval);
    const job = q.job.get(quote.job_id);
    const value = toPayPalValue(total);
    return {
      intent: 'AUTHORIZE',
      purchase_units: [{
        reference_id: `${quote.id}-v${version.version}`,
        custom_id: approval.id,
        invoice_id: payment.id,
        description: `${job.ref} ${quote.title} v${version.version} (Sandbox)`.slice(0, 127),
        items: items.map((i) => ({ name: i.name, sku: i.sku, quantity: String(i.qty), unit_amount: { currency_code: 'USD', value: toPayPalValue(i.unit_cents) } })),
        amount: { currency_code: 'USD', value, breakdown: { item_total: { currency_code: 'USD', value } } },
      }],
      payment_source: { paypal: { experience_context: {
        brand_name: `${job.shop_name} - SANDBOX`.slice(0, 127),
        shipping_preference: 'NO_SHIPPING',
        user_action: 'CONTINUE',
        return_url: `${cfg.publicBaseUrl}/paypal/return?p=${payment.id}`,
        cancel_url: `${cfg.publicBaseUrl}/paypal/cancel?p=${payment.id}`,
      } } },
    };
  }

  // Returns a list of problems; empty means the PayPal order matches what the customer approved in this app.
  function orderMismatches(order, payment, approval) {
    const { items, total } = expectedFor(approval);
    const problems = [];
    if (order.id !== payment.order_id) problems.push('order id');
    if (order.intent && order.intent !== 'AUTHORIZE') problems.push('intent');
    const pu = order.purchase_units || [];
    if (pu.length !== 1) return [...problems, 'purchase unit count'];
    const u = pu[0];
    if (u.custom_id !== undefined && u.custom_id !== approval.id) problems.push('approval link (custom_id)');
    if (u.amount?.currency_code !== 'USD') problems.push('currency');
    if (fromPayPalValue(u.amount?.value) !== total) problems.push('amount');
    if (Array.isArray(u.items)) {
      const want = items.map((i) => `${i.sku}|${i.qty}|${i.unit_cents}`).sort().join(',');
      const got = u.items.map((i) => `${i.sku}|${Number(i.quantity)}|${fromPayPalValue(i.unit_amount?.value)}`).sort().join(',');
      if (want !== got) problems.push('items');
    }
    return problems;
  }

  function customerPayment(jobId, paymentId) {
    const p = q.payment.get(paymentId);
    if (!p) throw new AppError(404, 'NOT_FOUND', 'Payment not found.');
    const a = q.approval.get(p.approval_id);
    const quote = q.quote.get(a.quote_id);
    if (quote.job_id !== jobId) throw new AppError(404, 'NOT_FOUND', 'Payment not found.');
    return { p, a, quote };
  }

  async function startCheckout(jobId, approvalId) {
    const a = q.approval.get(approvalId);
    const quote = a && q.quote.get(a.quote_id);
    if (!a || quote.job_id !== jobId) throw new AppError(404, 'NOT_FOUND', 'Approval not found.');
    if (a.status !== 'current' || a.decision !== 'approved') throw new AppError(409, 'APPROVAL_NOT_CURRENT', 'This choice is no longer current. Review the quote again.');
    if (a.version_hash !== loadVersion(quote).hash) throw new AppError(409, 'STALE_QUOTE', 'The shop updated this quote. Review the new version before you pay.');
    let p = q.paymentByApproval.get(a.id);
    if (!p) {
      const id = newId('pay');
      db.prepare("INSERT INTO payments (id, approval_id, amount_cents, currency, state, created_at, updated_at) VALUES (?,?,?, 'USD', 'not_started', ?, ?)").run(id, a.id, a.total_cents, iso(), iso());
      p = q.payment.get(id);
    }
    if (p.state === 'awaiting_buyer' && p.approve_url) return paymentView(p);
    if (p.state !== 'not_started') return paymentView(p);
    return withLock(p.id, async () => {
      setPayment(p.id, { state: 'creating', last_error: null });
      try {
        const out = await runOp(p, 'create_order', (rid) => paypal.createOrder(orderPayload(p, a), rid));
        applyCreatedOrder(p, out.res.value, quote.job_id);
      } catch (e) {
        if (e instanceof PayPalError && e.kind === 'http') setPayment(p.id, { state: 'not_started', last_error: e.message });
        if (e instanceof PayPalError) throw new AppError(502, 'PAYPAL_ERROR', e.kind === 'http' ? `${e.message} Nothing was held or charged. Try again.` : 'PayPal did not answer. Nothing is charged; the shop will confirm the order status.');
        throw e;
      }
      return paymentView(q.payment.get(p.id));
    });
  }

  function applyCreatedOrder(p, order, jobId) {
    const link = (order.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
    if (!order.id || !link || !link.startsWith(PAYPAL_APPROVAL_PREFIX)) {
      setPayment(p.id, { state: 'not_started', last_error: 'PayPal order did not include a Sandbox approval link.' });
      throw new AppError(502, 'PAYPAL_ERROR', 'PayPal did not return a Sandbox approval link. Nothing was charged.');
    }
    setPayment(p.id, { state: 'awaiting_buyer', order_id: order.id, approve_url: link, last_error: null });
    event(jobId, q.approval.get(p.approval_id).quote_id, 'system', 'paypal_order_created', { order_id: order.id, amount_cents: p.amount_cents, payment_id: p.id });
  }

  function markBuyerClosed(jobId, paymentId, orderId) {
    const { p, quote } = customerPayment(jobId, paymentId);
    if (orderId !== p.order_id) throw new AppError(400, 'ORDER_MISMATCH', 'This PayPal return does not match your order.');
    if (p.state === 'awaiting_buyer' && !p.buyer_closed_at) {
      setPayment(p.id, { buyer_closed_at: iso() });
      event(jobId, quote.id, 'customer', 'paypal_left_without_approval', { order_id: p.order_id });
    }
    return paymentView(q.payment.get(p.id));
  }

  async function authorizeApproved(p, a, quote, actor) {
    // A return URL is not proof. Ask PayPal what happened to this order.
    const { value: order } = await paypal.getOrder(p.order_id);
    const problems = orderMismatches(order, p, a);
    if (problems.length) {
      setPayment(p.id, { last_error: `PayPal order does not match the approved work: ${problems.join(', ')}` });
      event(quote.job_id, quote.id, 'system', 'paypal_order_mismatch', { order_id: p.order_id, problems });
      throw new AppError(409, 'ORDER_MISMATCH', 'The PayPal order does not match the approved work. Nothing was held by this app.');
    }
    const existing = order.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (order.status === 'COMPLETED' && existing) return adoptAuthorization(p, a, quote, existing.id, actor);
    if (order.status !== 'APPROVED') {
      return { pending: true, message: order.status === 'PAYER_ACTION_REQUIRED' || order.status === 'CREATED' ? 'PayPal has not recorded your approval yet.' : `PayPal order status is ${order.status}.` };
    }
    if (a.status !== 'current' || a.version_hash !== loadVersion(quote).hash) {
      throw new AppError(409, 'STALE_QUOTE', 'The quote changed after this PayPal order was created. No hold was placed. Review the new version.');
    }
    setPayment(p.id, { state: 'authorizing' });
    const out = await runOp(p, 'authorize', (rid) => paypal.authorizeOrder(p.order_id, rid), { reuseUnknown: true });
    const auth = out.res?.value?.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!auth?.id) {
      setPayment(p.id, { state: 'needs_check', last_error: 'Authorization response had no authorization ID.' });
      throw new AppError(502, 'PAYPAL_ERROR', 'PayPal did not return a hold ID. The shop will check with PayPal.');
    }
    return adoptAuthorization(p, a, quote, auth.id, actor);
  }

  async function adoptAuthorization(p, a, quote, authId, actor) {
    db.prepare('UPDATE payments SET authorization_id = ? WHERE id = ?').run(authId, p.id);
    db.prepare("UPDATE operations SET state = 'succeeded', remote_id = ?, finished_at = ? WHERE payment_id = ? AND kind = 'authorize' AND state = 'unknown'").run(authId, iso(), p.id);
    const { value: auth } = await paypal.getAuthorization(authId);
    if (auth.amount?.currency_code !== 'USD' || fromPayPalValue(auth.amount?.value) !== p.amount_cents) {
      setPayment(p.id, { state: 'needs_check', last_error: 'Held amount differs from the approved amount.' });
      throw new AppError(409, 'AMOUNT_MISMATCH', 'PayPal holds a different amount than you approved. The shop must review this before any charge.');
    }
    const stateMap = { CREATED: 'held', PENDING: 'auth_pending', CAPTURED: 'paid', VOIDED: 'released', EXPIRED: 'auth_expired', DENIED: 'not_started' };
    const state = stateMap[auth.status] || 'needs_check';
    setPayment(p.id, { state, auth_expires_at: auth.expiration_time || null, last_error: state === 'not_started' ? 'PayPal denied the hold.' : null });
    event(quote.job_id, quote.id, actor, 'paypal_hold_confirmed', { authorization_id: authId, status: auth.status, amount_cents: p.amount_cents, paypal_expiration_time: auth.expiration_time || null });
    return { state };
  }

  async function handleReturn(jobId, paymentId, orderId) {
    const { p, a, quote } = customerPayment(jobId, paymentId);
    if (!orderId || orderId !== p.order_id) throw new AppError(400, 'ORDER_MISMATCH', 'This PayPal return does not match your order.');
    if (!['awaiting_buyer', 'not_started'].includes(p.state)) return { payment: paymentView(p), repeated: true };
    return withLock(p.id, async () => {
      try {
        const r = await authorizeApproved(p, a, quote, 'customer');
        return { payment: paymentView(q.payment.get(p.id)), message: r.message || null };
      } catch (e) {
        if (e instanceof PayPalError) {
          const cur = q.payment.get(p.id);
          if (cur.state === 'authorizing') setPayment(p.id, { state: 'awaiting_buyer', last_error: e.message });
          throw new AppError(502, 'PAYPAL_ERROR', e.kind === 'http' ? `${e.message} Nothing was charged.` : 'PayPal did not answer. Nothing was charged; the shop will confirm the hold.');
        }
        throw e;
      }
    });
  }

  function shopPayment(paymentId) {
    const p = q.payment.get(paymentId);
    if (!p) throw new AppError(404, 'NOT_FOUND', 'Payment not found.');
    const a = q.approval.get(p.approval_id);
    return { p, a, quote: q.quote.get(a.quote_id) };
  }

  function markWorkDone(paymentId) {
    const { p, quote } = shopPayment(paymentId);
    if (p.state !== 'held') throw new AppError(409, 'NOT_HELD', 'Only work with a PayPal hold can be marked done here.');
    if (!p.work_done_at) {
      setPayment(p.id, { work_done_at: iso() });
      event(quote.job_id, quote.id, 'shop', 'work_done', { payment_id: p.id });
    }
    return paymentView(q.payment.get(p.id), true);
  }

  async function verifyCapture(p, quote, captureId) {
    const { value: cap } = await paypal.getCapture(captureId);
    const amountOk = cap.amount?.currency_code === 'USD' && fromPayPalValue(cap.amount?.value) === p.amount_cents;
    let state;
    if (!amountOk) state = 'needs_check';
    else if (cap.status === 'COMPLETED') state = 'paid';
    else if (cap.status === 'PENDING') state = 'capture_pending';
    else if (['DECLINED', 'FAILED'].includes(cap.status)) state = 'capture_declined';
    else state = 'needs_check';
    setPayment(p.id, { state, capture_id: captureId, capture_status: cap.status, last_error: amountOk ? (cap.status_details?.reason ? `PayPal reason: ${cap.status_details.reason}` : null) : 'Captured amount differs from approved amount.' });
    event(quote.job_id, quote.id, 'system', 'paypal_charge_checked', { capture_id: captureId, status: cap.status, amount_cents: fromPayPalValue(cap.amount?.value), matches_approved_amount: amountOk });
    return state;
  }

  async function capture(paymentId) {
    const { p, a, quote } = shopPayment(paymentId);
    if (p.state === 'paid') return paymentView(p, true);
    if (p.state !== 'held') throw new AppError(409, 'NOT_HELD', 'There is no active PayPal hold to charge.');
    if (!p.work_done_at) throw new AppError(409, 'WORK_NOT_DONE', 'Mark the work done before charging.');
    if (a.total_cents !== p.amount_cents) throw new AppError(409, 'AMOUNT_MISMATCH', 'Approved amount and payment amount differ. Charging is blocked.');
    return withLock(p.id, async () => {
      try {
        const { value: auth } = await paypal.getAuthorization(p.authorization_id);
        if (fromPayPalValue(auth.amount?.value) !== p.amount_cents) throw new AppError(409, 'AMOUNT_MISMATCH', 'PayPal hold amount differs from the approved amount. Charging is blocked.');
        if (auth.status !== 'CREATED') {
          setPayment(p.id, { state: 'needs_check', last_error: `PayPal hold status is ${auth.status}. Use "Check with PayPal".` });
          throw new AppError(409, 'HOLD_NOT_ACTIVE', `PayPal reports the hold as ${auth.status}. Nothing was sent.`);
        }
        setPayment(p.id, { state: 'capturing' });
        const body = { amount: { currency_code: 'USD', value: toPayPalValue(a.total_cents) }, final_capture: true, invoice_id: p.id };
        const out = await runOp(p, 'capture', (rid) => paypal.captureAuthorization(p.authorization_id, body, rid));
        const capId = out.res?.value?.id;
        if (!capId) {
          setPayment(p.id, { state: 'needs_check', last_error: 'Charge response had no capture ID.' });
          throw new AppError(502, 'PAYPAL_ERROR', 'PayPal did not return a charge ID. Use "Check with PayPal".');
        }
        // Save the ID first; a minimal response can omit the amount, so the GET decides the state.
        setPayment(p.id, { capture_id: capId, capture_status: out.res.value.status || null });
        await verifyCapture(p, quote, capId);
      } catch (e) {
        if (e instanceof PayPalError) {
          const cur = q.payment.get(p.id);
          if (e.kind === 'http' && cur.state === 'capturing') setPayment(p.id, { state: 'held', last_error: e.message });
          throw new AppError(502, 'PAYPAL_ERROR', e.kind === 'http' ? `${e.message} The hold is unchanged.` : 'PayPal did not answer. Do not charge again; use "Check with PayPal".');
        }
        throw e;
      }
      return paymentView(q.payment.get(p.id), true);
    });
  }

  async function cancelWork(paymentId, reason) {
    const { p, a, quote } = shopPayment(paymentId);
    const why = String(reason || '').trim().slice(0, 200) || 'Cancelled by shop';
    if (['not_started', 'awaiting_buyer'].includes(p.state)) {
      // No hold exists, so there is nothing to void.
      tx(db, () => {
        setPayment(p.id, { state: 'abandoned' });
        db.prepare("UPDATE approvals SET status = 'cancelled', updated_at = ? WHERE id = ?").run(iso(), a.id);
        event(quote.job_id, quote.id, 'shop', 'request_cancelled_no_hold', { payment_id: p.id, reason: why, paypal_called: false });
      });
      return paymentView(q.payment.get(p.id), true);
    }
    if (p.state === 'released') return paymentView(p, true);
    if (p.state !== 'held') throw new AppError(409, 'NOT_HELD', 'Only an active hold can be released.');
    if (p.work_done_at) throw new AppError(409, 'WORK_DONE', 'This work is marked done. Charge it instead of releasing the hold.');
    return withLock(p.id, async () => {
      try {
        const { value: auth } = await paypal.getAuthorization(p.authorization_id);
        if (auth.status === 'CAPTURED') {
          setPayment(p.id, { state: 'needs_check', last_error: 'PayPal shows this hold as already charged; a charged hold cannot be released.' });
          throw new AppError(409, 'ALREADY_CAPTURED', 'PayPal already charged this hold. It cannot be released.');
        }
        if (auth.status === 'VOIDED') {
          setPayment(p.id, { state: 'released' });
          return paymentView(q.payment.get(p.id), true);
        }
        setPayment(p.id, { state: 'voiding' });
        await runOp(p, 'void', (rid) => paypal.voidAuthorization(p.authorization_id, rid));
        const { value: after } = await paypal.getAuthorization(p.authorization_id);
        if (after.status !== 'VOIDED') {
          setPayment(p.id, { state: 'needs_check', last_error: `After release PayPal reports ${after.status}.` });
          throw new AppError(502, 'PAYPAL_ERROR', `PayPal reports the hold as ${after.status}. Use "Check with PayPal".`);
        }
        tx(db, () => {
          setPayment(p.id, { state: 'released', last_error: null });
          db.prepare("UPDATE approvals SET status = 'cancelled', updated_at = ? WHERE id = ?").run(iso(), a.id);
          event(quote.job_id, quote.id, 'shop', 'hold_released', { payment_id: p.id, authorization_id: p.authorization_id, reason: why, amount_cents: p.amount_cents });
        });
      } catch (e) {
        if (e instanceof PayPalError) {
          const cur = q.payment.get(p.id);
          if (e.kind === 'http' && cur.state === 'voiding') setPayment(p.id, { state: 'held', last_error: e.message });
          throw new AppError(502, 'PAYPAL_ERROR', e.kind === 'http' ? `${e.message} The hold is unchanged.` : 'PayPal did not answer. Use "Check with PayPal".');
        }
        throw e;
      }
      return paymentView(q.payment.get(p.id), true);
    });
  }

  // Human-triggered. Reads PayPal first; replays only with the original PayPal-Request-Id.
  async function reconcile(paymentId) {
    const { p, a, quote } = shopPayment(paymentId);
    return withLock(p.id, async () => {
      const unknown = q.ops.all(p.id).filter((o) => o.state === 'unknown').pop();
      try {
        if (unknown?.kind === 'create_order' || (p.state === 'needs_check' && !p.order_id)) {
          const out = await runOp(p, 'create_order', (rid) => paypal.createOrder(orderPayload(p, a), rid), { reuseUnknown: true });
          if (out.res) applyCreatedOrder(p, out.res.value, quote.job_id);
        } else if (p.capture_id && ['capture_pending', 'needs_check'].includes(p.state)) {
          await verifyCapture(p, quote, p.capture_id);
        } else if (unknown?.kind === 'capture' || (p.authorization_id && p.state === 'needs_check')) {
          const { value: auth } = await paypal.getAuthorization(p.authorization_id);
          if (auth.status === 'CAPTURED') {
            const { value: order } = await paypal.getOrder(p.order_id);
            const caps = order.purchase_units?.[0]?.payments?.captures || [];
            if (unknown) finishOp(unknown, 'succeeded', { remoteId: caps[0]?.id });
            if (caps.length !== 1) setPayment(p.id, { state: 'needs_check', last_error: `PayPal lists ${caps.length} charges for this order.` });
            else await verifyCapture(p, quote, caps[0].id);
          } else if (auth.status === 'CREATED' && unknown?.kind === 'capture') {
            const body = { amount: { currency_code: 'USD', value: toPayPalValue(a.total_cents) }, final_capture: true, invoice_id: p.id };
            const out = await runOp(p, 'capture', (rid) => paypal.captureAuthorization(p.authorization_id, body, rid), { reuseUnknown: true });
            setPayment(p.id, { capture_id: out.res.value.id });
            await verifyCapture(p, quote, out.res.value.id);
          } else if (auth.status === 'CREATED' && unknown?.kind === 'void') {
            await runOp(p, 'void', (rid) => paypal.voidAuthorization(p.authorization_id, rid), { reuseUnknown: true });
            const { value: after } = await paypal.getAuthorization(p.authorization_id);
            setPayment(p.id, { state: after.status === 'VOIDED' ? 'released' : 'needs_check' });
          } else {
            const stateMap = { CREATED: 'held', PENDING: 'auth_pending', VOIDED: 'released', EXPIRED: 'auth_expired' };
            if (unknown && auth.status === 'VOIDED') finishOp(unknown, 'succeeded', {});
            setPayment(p.id, { state: stateMap[auth.status] || 'needs_check', auth_expires_at: auth.expiration_time || p.auth_expires_at, last_error: stateMap[auth.status] ? null : `PayPal hold status ${auth.status}` });
          }
        } else if (p.order_id && ['awaiting_buyer', 'needs_check', 'authorizing'].includes(p.state)) {
          const r = await authorizeApproved(q.payment.get(p.id), a, quote, 'shop');
          if (r.pending) {
            setPayment(p.id, { state: 'awaiting_buyer' });
            event(quote.job_id, quote.id, 'shop', 'paypal_checked', { result: r.message });
          }
        } else if (p.authorization_id && ['held', 'auth_pending'].includes(p.state)) {
          const { value: auth } = await paypal.getAuthorization(p.authorization_id);
          const stateMap = { CREATED: 'held', PENDING: 'auth_pending', CAPTURED: 'needs_check', VOIDED: 'released', EXPIRED: 'auth_expired' };
          setPayment(p.id, { state: stateMap[auth.status] || 'needs_check', auth_expires_at: auth.expiration_time || p.auth_expires_at });
        }
      } catch (e) {
        if (e instanceof PayPalError) throw new AppError(502, 'PAYPAL_ERROR', e.kind === 'http' ? e.message : 'PayPal still did not answer. Try "Check with PayPal" again later; nothing new was sent with a new request ID.');
        throw e;
      }
      event(quote.job_id, quote.id, 'shop', 'paypal_reconciled', { payment_id: p.id, state: q.payment.get(p.id).state });
      return paymentView(q.payment.get(p.id), true);
    });
  }

  // After a crash, a request that was 'sending' has an unknown outcome.
  function recoverInterrupted() {
    const rows = db.prepare("SELECT * FROM operations WHERE state = 'sending'").all();
    for (const o of rows) {
      finishOp(o, 'unknown', { error: 'Server stopped while waiting for PayPal.' });
      setPayment(o.payment_id, { state: 'needs_check', last_error: `${o.kind}: server stopped before PayPal answered. Use "Check with PayPal".` });
    }
    return rows.length;
  }

  // ---------- assistant ----------

  async function ask(jobId, quoteId, { question, versionHash: vh }) {
    const quote = customerQuote(jobId, quoteId);
    const v = loadVersion(quote);
    if (vh !== v.hash) throw new AppError(409, 'STALE_QUOTE', 'The shop updated this quote. Read the new version first.');
    const text = String(question || '').trim();
    if (!text || text.length > 500) throw new AppError(400, 'INVALID_QUESTION', 'Write a question or answer of up to 500 characters.');
    const hourAgo = new Date(now().getTime() - 3600_000).toISOString();
    const recent = db.prepare('SELECT COUNT(*) AS n FROM ai_suggestions s JOIN quotes q ON q.id = s.quote_id WHERE q.job_id = ? AND s.created_at > ?').get(jobId, hourAgo).n;
    if (recent >= 30) throw new AppError(429, 'TOO_MANY_QUESTIONS', 'Too many questions in the last hour. Call or text the shop instead.');
    if (!ai) throw new AppError(503, 'AI_UNAVAILABLE', 'The assistant is not available. Choose items yourself or contact the shop.');
    const id = newId('ai');
    const started = Date.now();
    let result;
    try {
      result = await ai.suggest({ quote: { title: quote.title, note: v.note, items: v.items, total_cents: v.total_cents }, question: text });
    } catch (e) {
      db.prepare('INSERT INTO ai_suggestions (id, quote_id, version_hash, question, provider, model, ok, error, latency_ms, created_at) VALUES (?,?,?,?,?,?,0,?,?,?)')
        .run(id, quoteId, v.hash, text, ai.name, ai.model || null, String(e.message).slice(0, 300), Date.now() - started, iso());
      throw new AppError(502, 'AI_FAILED', 'The assistant could not answer just now. You can still choose items yourself or contact the shop.');
    }
    const stillCurrent = loadVersion(q.quote.get(quoteId));
    if (stillCurrent.hash !== v.hash) throw new AppError(409, 'STALE_QUOTE', 'The shop updated this quote while the assistant was answering. Read the new version first.');
    const out = result.output;
    const selected = out.selected_item_ids.map((x) => v.items.find((i) => i.id === x));
    const resp = {
      suggestion_id: id,
      kind: out.kind,
      answer: out.kind === 'payment_question' ? null : out.answer,
      selected_item_ids: out.kind === 'selection' ? out.selected_item_ids : [],
      selection_total_cents: out.kind === 'selection' && selected.length ? sumItems(selected) : null,
      handoff_reason: out.handoff_reason,
      version_hash: v.hash,
    };
    if (out.kind === 'payment_question') {
      const cur = q.currentApproval.get(quoteId);
      const p = cur ? q.paymentByApproval.get(cur.id) : null;
      resp.answer = paymentText(p).text;
      resp.fixed_text = true;
    }
    db.prepare('INSERT INTO ai_suggestions (id, quote_id, version_hash, question, provider, model, ok, output_json, latency_ms, cost_usd, created_at) VALUES (?,?,?,?,?,?,1,?,?,?,?)')
      .run(id, quoteId, v.hash, text, ai.name, result.model || ai.model || null, JSON.stringify(out), Date.now() - started, result.cost_usd ?? null, iso());
    if (out.kind === 'handoff') event(jobId, quoteId, 'customer', 'question_for_shop', { question: text, reason: out.handoff_reason });
    return resp;
  }

  return {
    createQuote, editQuote, sendQuote, issueCustomerLink, customerJobId, createShopKey, shopLogin, checkShopSession, shopLogout,
    jobView, decide, startCheckout, handleReturn, markBuyerClosed, markWorkDone, capture, cancelWork, reconcile, recoverInterrupted, ask,
    listJobs: () => q.jobs.all().map((j) => ({ id: j.id, ref: j.ref, customer_name: j.customer_name, vehicle: j.vehicle })),
    _orderPayload: orderPayload,
  };
}
