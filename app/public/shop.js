import { $, h, usd, when, day, api, busy, tone } from './common.js';

const main = $('#main');
let jobId = null;
let data = null;
let link = null;
let flash = null;
const editing = new Set();

const EVENT_TEXT = {
  quote_created: (d) => `Quote created (v${d.version}, ${usd(d.total_cents)})`,
  quote_sent: (d) => `Quote v${d.version} sent to customer`,
  quote_revised: (d) => `Quote changed to v${d.version} (${usd(d.total_cents)})${d.customer_choice_cleared ? '; customer must approve again' : ''}`,
  customer_link_created: (d) => `Customer link created, valid until ${day(d.expires_at)}`,
  scope_approved: (d) => `Customer approved ${d.items.length} item(s), ${usd(d.total_cents)}, v${d.version}${d.declined_items.length ? `; left out ${d.declined_items.join(', ')}` : ''}${d.used_ai_suggestion ? ' (started from an assistant suggestion)' : ''}`,
  scope_declined: (d) => `Customer declined the quote (v${d.version})`,
  scope_deferred: (d) => `Customer asked for time to decide (v${d.version})`,
  question_for_shop: (d) => `Customer question for you: “${d.question}”`,
  paypal_order_created: (d) => `PayPal order ${d.order_id} created for ${usd(d.amount_cents)}`,
  paypal_left_without_approval: () => 'Customer left PayPal without approving',
  paypal_hold_confirmed: (d) => `PayPal hold ${d.authorization_id}: ${d.status}, ${usd(d.amount_cents)}`,
  paypal_order_mismatch: (d) => `PayPal order did not match the approval (${d.problems.join(', ')}); no hold placed`,
  work_done: () => 'Work marked done',
  paypal_charge_checked: (d) => `Charge ${d.capture_id}: ${d.status}, ${d.amount_cents !== null ? usd(d.amount_cents) : 'amount missing'}${d.matches_approved_amount ? '' : ' — does not match approval'}`,
  hold_released: (d) => `Work cancelled, hold ${d.authorization_id} released (${usd(d.amount_cents)}): ${d.reason}`,
  request_cancelled_no_hold: (d) => `Request cancelled before any hold; PayPal not called: ${d.reason}`,
  paypal_checked: (d) => `Checked PayPal: ${d.result}`,
  paypal_reconciled: (d) => `Checked with PayPal; payment state is ${d.state}`,
};

async function load() {
  try {
    if (!jobId) {
      const { jobs } = await api('GET', '/api/shop/jobs');
      if (!jobs.length) { main.replaceChildren(h('h1', {}, 'No job yet'), h('p', {}, 'Run npm run seed to create the sample job.')); return; }
      jobId = jobs[0].id;
    }
    data = await api('GET', `/api/shop/jobs/${jobId}`);
    render();
  } catch (err) {
    if (err.status === 401) location.replace('/shop/login');
    else main.replaceChildren(h('h1', {}, 'Could not load the job'), h('p', { class: 'error' }, err.message));
  }
}

function workLabel(q) {
  if (q.status === 'draft') return { text: 'Not sent', tone: 'quiet' };
  const a = q.approval;
  if (!a) return { text: 'Waiting for customer', tone: 'wait' };
  if (a.status === 'cancelled') return { text: `Cancelled by shop · was approved v${a.version}, ${usd(a.total_cents)}`, tone: 'quiet' };
  if (a.decision === 'declined') return { text: `Declined by customer · v${a.version}`, tone: 'quiet' };
  if (a.decision === 'deferred') return { text: 'Customer wants time to decide', tone: 'wait' };
  return { text: `Approved · v${a.version} · ${a.selected.length} of ${q.items.length} items · ${usd(a.total_cents)}`, tone: 'done' };
}

function nextAction(q) {
  const p = q.payment;
  if (q.status === 'draft') return { hint: 'The customer cannot see this quote yet.', buttons: [btn('primary', 'Send to customer', () => post(`/api/shop/quotes/${q.id}/send`, 'Sending…', 'Quote sent.'))] };
  const a = q.approval;
  if (a?.status === 'cancelled') return { hint: p?.state === 'released' ? 'Work cancelled. The hold was released; the customer was not charged.' : 'Request cancelled. Nothing was held or charged.', buttons: [] };
  if (!a || a.decision !== 'approved') return { hint: a?.decision === 'declined' ? 'Do not do this work. Nothing is held.' : 'Do not start this work until the customer approves.', buttons: [] };
  if (!p || p.state === 'not_started') return { hint: 'Customer approved the work but has not opened PayPal. Nothing is held. Do not start yet.', buttons: [] };
  switch (p.state) {
    case 'awaiting_buyer':
      return { hint: p.buyer_closed_at ? 'Customer left PayPal without approving. Nothing is held. Do not start yet.' : 'Waiting for the customer to approve in PayPal. Do not start yet.', buttons: [btn('secondary', 'Check with PayPal', () => post(`/api/shop/payments/${p.id}/reconcile`, 'Checking…', 'Checked with PayPal.'))], extra: [cancelBtn(p, 'Cancel request (nothing held)')] };
    case 'held':
      if (!p.work_done_at) return { hint: `PayPal holds ${usd(p.amount_cents)}. Do the approved work, then mark it done.`, buttons: [btn('primary', 'Mark work done', () => post(`/api/shop/payments/${p.id}/work-done`, 'Saving…', 'Marked done.'))], extra: [cancelBtn(p, 'Cancel work and release hold')] };
      return { hint: `Work done. Charging takes exactly the approved ${usd(p.amount_cents)}.`, buttons: [btn('primary', `Charge ${usd(p.amount_cents)}`, () => post(`/api/shop/payments/${p.id}/capture`, 'Charging…', 'Charge checked with PayPal.'))] };
    case 'paid': return { hint: `Charged ${usd(p.amount_cents)}. Charge ID ${p.capture_id}.`, buttons: [] };
    case 'released': return { hint: 'Work cancelled. The hold was released; the customer was not charged.', buttons: [] };
    case 'capture_pending':
    case 'needs_check':
    case 'auth_pending':
    case 'authorizing':
      return { hint: p.last_error || 'PayPal has not given a final answer. Check again before doing anything else.', buttons: [btn('primary', 'Check with PayPal', () => post(`/api/shop/payments/${p.id}/reconcile`, 'Checking…', 'Checked with PayPal.'))] };
    case 'capture_declined': return { hint: `${p.last_error || 'PayPal declined the charge.'} Contact the customer.`, buttons: [] };
    default: return { hint: p.text, buttons: [] };
  }
}

function btn(cls, label, fn) {
  return h('button', { class: cls, type: 'button', onclick: (e) => fn(e.target) }, label);
}

function cancelBtn(p, label) {
  return btn('danger', label, async (b) => {
    const held = p.state === 'held';
    const reason = prompt(held ? `Release the ${usd(p.amount_cents)} hold? The customer will not be charged for this work.\n\nReason (shown in history):` : 'Cancel this request? No PayPal hold exists.\n\nReason (shown in history):', held ? 'Part does not fit; work not done' : 'Cancelled by shop');
    if (reason === null) return;
    await post(`/api/shop/payments/${p.id}/cancel`, held ? 'Releasing…' : 'Cancelling…', held ? 'Hold released.' : 'Request cancelled.', { reason }, b);
  });
}

async function post(url, busyLabel, okText, body = {}, button) {
  const run = async () => {
    try {
      await api('POST', url, body);
      flash = { text: okText, tone: 'good' };
    } catch (err) {
      flash = { text: err.message, tone: 'bad' };
    }
    await load();
  };
  if (button) return busy(button, busyLabel, run);
  return run();
}

function render() {
  const { job, quotes } = data;
  $('#shop-name').textContent = `${job.shop_name} · Shop`;
  main.replaceChildren(
    h('div', { class: 'job-head' },
      h('div', {}, h('p', { class: 'eyebrow' }, `Repair order ${job.ref}`), h('h1', {}, `${job.vehicle} · ${job.customer_name}`)),
      h('div', { class: 'link-box' },
        h('button', { class: 'secondary', type: 'button', onclick: (e) => busy(e.target, 'Creating…', async () => {
          link = await api('POST', `/api/shop/jobs/${jobId}/customer-link`);
          render();
          $('#cust-link')?.select();
        }) }, link ? 'Create another link' : 'Create customer link'),
        link ? h('div', { class: 'link-out' },
          h('label', { for: 'cust-link' }, `Send this to the customer (valid until ${day(link.expires_at)}):`),
          h('input', { id: 'cust-link', readonly: true, value: link.url, onfocus: (e) => e.target.select() }),
          h('a', { href: link.url, target: '_blank', rel: 'noopener' }, 'Open customer view')) : null)),
    flash ? h('div', { class: `notice ${flash.tone || ''}`, role: 'status' }, flash.text) : '',
    ...quotes.map(quoteBlock),
    historyBlock());
  flash = null;
}

function quoteBlock(q) {
  if (editing.has(q.id)) return editBlock(q);
  const a = q.approval;
  const wl = workLabel(q);
  const p = q.payment;
  const na = nextAction(q);
  const sel = a?.decision === 'approved' ? new Set(a.selected) : null;
  const locked = p && !['not_started', 'awaiting_buyer', 'abandoned', 'released'].includes(p.state);
  return h('section', { class: 'sheet', 'aria-labelledby': `q-${q.id}` },
    h('div', { class: 'sheet-head' },
      h('h2', { id: `q-${q.id}` }, `${q.seq}. ${q.title}`),
      h('span', { class: 'meta' }, `${q.kind === 'addon' ? 'Add-on' : 'Base job'} · v${q.version}${q.sent_at ? ` · sent ${when(q.sent_at)}` : ''}`)),
    h('table', { class: 'lines' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Item'), h('th', { scope: 'col' }, 'SKU'), h('th', { scope: 'col', class: 'num' }, 'Qty'), h('th', { scope: 'col', class: 'num' }, 'Amount'))),
      h('tbody', {}, q.items.map((i) => {
        const out = sel && !sel.has(i.id);
        return h('tr', { class: out ? 'declined' : '' },
          h('td', {}, sel ? h('span', { class: 'mark', 'aria-hidden': 'true' }, out ? '–' : '✓') : null, out ? h('s', {}, i.name) : i.name, out ? h('span', { class: 'sr' }, ' (not approved)') : null),
          h('td', { class: 'sku' }, i.sku), h('td', { class: 'num' }, i.qty), h('td', { class: 'num' }, usd(i.unit_cents * i.qty)));
      })),
      h('tfoot', {}, h('tr', {}, h('th', { scope: 'row', colspan: 3 }, 'Quote total'), h('td', { class: 'num strong' }, usd(q.total_cents))))),
    h('div', { class: 'status' },
      h('div', { class: 'status-row' }, h('span', { class: 'axis' }, 'Work'), h('span', { class: `badge ${wl.tone}` }, wl.text)),
      a?.decision === 'approved' ? h('div', { class: 'status-row' }, h('span', { class: 'axis' }, 'Payment'), h('span', { class: `badge ${tone(p?.state || 'not_started')}` }, p ? p.label : 'Not charged'),
        p?.held_until && ['held', 'auth_pending'].includes(p.state) ? h('span', { class: 'meta' }, `PayPal lists the hold as valid until ${day(p.held_until)}`) : null) : null),
    h('div', { class: 'next' }, h('p', {}, na.hint), h('div', { class: 'actions' }, ...na.buttons, ...(na.extra || []),
      !locked ? h('button', { class: 'link-btn', type: 'button', onclick: () => { editing.add(q.id); render(); } }, 'Edit quote') : null)),
    p ? paypalDetails(p) : null,
    q.past_choices?.length ? h('details', { class: 'details' }, h('summary', {}, `Earlier customer choices (${q.past_choices.length})`),
      h('ul', {}, q.past_choices.map((c) => h('li', {}, `${when(c.created_at)} · v${c.version} · ${c.decision} · ${usd(c.total_cents)} · ${c.status}${c.payment ? ` · payment ${c.payment.state}` : ''}`)))) : null);
}

function paypalDetails(p) {
  const rows = [['Order', p.order_id], ['Hold (authorization)', p.authorization_id], ['Charge (capture)', p.capture_id ? `${p.capture_id} · ${p.capture_status}` : null], ['Hold valid until (PayPal)', p.held_until ? when(p.held_until) : null], ['Last problem', p.last_error]].filter(([, v]) => v);
  return h('details', { class: 'details' }, h('summary', {}, 'PayPal record'),
    h('dl', {}, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    p.operations?.length ? h('table', { class: 'ops' },
      h('thead', {}, h('tr', {}, ['Step', 'Try', 'Result', 'HTTP', 'PayPal-Request-Id', 'Time'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, p.operations.map((o) => h('tr', {}, h('td', {}, o.kind), h('td', {}, o.attempt), h('td', {}, o.state), h('td', {}, o.http_status ?? '—'), h('td', { class: 'mono' }, o.request_id), h('td', {}, when(o.started_at)))))) : null);
}

function editBlock(q) {
  const rows = q.items.map((i) => ({ ...i }));
  const tbody = h('tbody');
  const note = h('textarea', { id: `note-${q.id}`, rows: 3, maxlength: 1000 }, q.note);
  const err = h('p', { class: 'error', role: 'alert', hidden: true });
  const draw = () => {
    tbody.replaceChildren(...rows.map((r, idx) => h('tr', {},
      h('td', {}, h('input', { 'aria-label': `Item ${idx + 1} name`, value: r.name, oninput: (e) => { r.name = e.target.value; } })),
      h('td', {}, h('input', { 'aria-label': `Item ${idx + 1} SKU`, class: 'sku-in', value: r.sku, oninput: (e) => { r.sku = e.target.value; } })),
      h('td', {}, h('input', { 'aria-label': `Item ${idx + 1} quantity`, type: 'number', min: 1, max: 20, class: 'num-in', value: r.qty, oninput: (e) => { r.qty = Number(e.target.value); } })),
      h('td', {}, h('input', { 'aria-label': `Item ${idx + 1} unit price in dollars`, inputmode: 'decimal', class: 'num-in', value: (r.unit_cents / 100).toFixed(2), oninput: (e) => { r.unit_cents = Math.round(Number(e.target.value) * 100); } })),
      h('td', {}, h('input', { 'aria-label': `Item ${idx + 1} reason for the customer`, value: r.reason || '', oninput: (e) => { r.reason = e.target.value; } })),
      h('td', {}, h('button', { class: 'link-btn', type: 'button', onclick: () => { rows.splice(idx, 1); draw(); } }, 'Remove')))));
  };
  draw();
  return h('section', { class: 'sheet editing', 'aria-labelledby': `e-${q.id}` },
    h('div', { class: 'sheet-head' }, h('h2', { id: `e-${q.id}` }, `Edit: ${q.title}`), h('span', { class: 'meta' }, `saving creates v${q.version + 1}`)),
    q.approval ? h('p', { class: 'notice bad' }, 'Saving clears the customer’s current choice. They must review and approve the new version.') : null,
    h('label', { for: `note-${q.id}` }, 'Note to the customer'), note,
    h('table', { class: 'lines edit' },
      h('thead', {}, h('tr', {}, ['Item', 'SKU', 'Qty', 'Unit $', 'Reason shown to customer', ''].map((t) => h('th', { scope: 'col' }, t)))), tbody),
    h('div', { class: 'actions' },
      h('button', { class: 'secondary', type: 'button', onclick: () => { rows.push({ id: '', sku: '', name: '', qty: 1, unit_cents: 0, reason: '' }); draw(); } }, 'Add item'),
      h('button', { class: 'primary', type: 'button', onclick: (e) => busy(e.target, 'Saving…', async () => {
        try {
          await api('POST', `/api/shop/quotes/${q.id}/versions`, { baseVersion: q.version, note: note.value, items: rows.map((r) => ({ ...r, id: r.id || undefined })) });
          editing.delete(q.id);
          flash = { text: `Saved as v${q.version + 1}.`, tone: 'good' };
          await load();
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      }) }, `Save as v${q.version + 1}`),
      h('button', { class: 'link-btn', type: 'button', onclick: () => { editing.delete(q.id); render(); } }, 'Cancel')),
    err);
}

function historyBlock() {
  return h('section', { class: 'history', 'aria-labelledby': 'hist' },
    h('h2', { id: 'hist' }, 'History'),
    h('ol', {}, data.history.map((e) => {
      const q = data.quotes.find((x) => x.id === e.quote_id);
      const text = (EVENT_TEXT[e.type] || (() => e.type))(e.detail);
      return h('li', {}, h('time', { datetime: e.at }, when(e.at)), h('span', { class: `actor ${e.actor}` }, e.actor), h('span', {}, q ? `${q.title}: ` : '', text));
    })));
}

$('#logout').addEventListener('click', async () => { await api('POST', '/api/shop/logout').catch(() => {}); location.replace('/shop/login'); });
load();
