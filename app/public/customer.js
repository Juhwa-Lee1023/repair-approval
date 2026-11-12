import { $, h, usd, when, api, busy, tone } from './common.js';

const main = $('#main');
const ui = {}; // per quote: { selected:Set, stage, chat:[], suggestionId, changing }
let token = null;
let data = null;
let flash = null;

const call = (method, url, body) => api(method, url, body, { 'X-Customer-Token': token });

function say(msg) { $('#live').textContent = msg; }

function quoteUi(q) {
  if (!ui[q.id] || ui[q.id].hash !== q.version_hash) {
    const pre = q.approval?.decision === 'approved' && q.approval.version_hash === q.version_hash ? q.approval.selected : [];
    ui[q.id] = { hash: q.version_hash, selected: new Set(pre), stage: 'choose', chat: [], suggestionId: null, changing: false };
  }
  return ui[q.id];
}

function needsDecision(q) {
  return !q.approval || q.approval.decision === 'deferred' || quoteUi(q).changing;
}

async function load() {
  data = await call('GET', '/api/c/job');
  $('#shop-name').textContent = data.job.shop_name;
  render();
}

function render() {
  main.replaceChildren();
  const pending = data.quotes.filter(needsDecision);
  main.append(h('p', { class: 'eyebrow' }, `${data.job.ref} · ${data.job.vehicle}`));
  if (pending.length) {
    const first = pending[0];
    main.append(h('h1', {}, first.kind === 'addon' ? 'Your mechanic found more work. Choose what to do today.' : 'Review your repair quote and approve the work.'));
  } else if (data.quotes.some((q) => q.approval?.decision === 'approved' && q.approval.status !== 'cancelled' && (!q.payment || ['not_started', 'awaiting_buyer'].includes(q.payment.state)))) {
    main.append(h('h1', {}, 'Finish your approval in PayPal'));
    main.append(h('p', { class: 'lead' }, 'You approved the work below. PayPal still needs your OK to hold the amount. You are not charged until the shop finishes the work.'));
  } else {
    main.append(h('h1', {}, 'Your repair choices'));
    main.append(h('p', { class: 'lead' }, 'Nothing needs your answer right now. Each item shows whether it was charged, is held, or was released.'));
  }
  if (flash) {
    main.append(h('div', { class: `notice ${flash.tone || ''}`, role: 'status' }, flash.text));
    flash = null;
  }
  const order = [...pending, ...data.quotes.filter((q) => !pending.includes(q))];
  for (const q of order) main.append(needsDecision(q) ? chooseSection(q) : summarySection(q));
  if (!data.quotes.length) main.append(h('p', {}, 'The shop has not sent a quote yet.'));
}

function itemRow(q, item, st) {
  const id = `${q.id}-${item.id}`;
  const box = h('input', { type: 'checkbox', id, checked: st.selected.has(item.id), onchange: (e) => { e.target.checked ? st.selected.add(item.id) : st.selected.delete(item.id); st.suggestionId = null; render(); $(`#${CSS.escape(id)}`)?.focus(); } });
  return h('li', { class: 'item' },
    box,
    h('label', { for: id },
      h('span', { class: 'item-name' }, item.name, item.qty > 1 ? ` × ${item.qty}` : ''),
      item.reason ? h('span', { class: 'item-reason' }, item.reason) : null),
    h('span', { class: 'amount' }, usd(item.unit_cents * item.qty)));
}

function chooseSection(q) {
  const st = quoteUi(q);
  if (st.stage === 'review') return reviewSection(q, st);
  const chosen = q.items.filter((i) => st.selected.has(i.id));
  const total = chosen.reduce((s, i) => s + i.unit_cents * i.qty, 0);
  const sec = h('section', { class: 'sheet', 'aria-labelledby': `t-${q.id}` },
    h('div', { class: 'sheet-head' },
      h('h2', { id: `t-${q.id}` }, q.title),
      h('span', { class: 'meta' }, `${q.kind === 'addon' ? 'Additional work' : 'Booked work'} · quote v${q.version}`)),
    h('figure', { class: 'note' }, h('figcaption', {}, 'From your mechanic'), h('blockquote', {}, q.note)),
    q.approval?.decision === 'deferred' && !st.changing ? h('p', { class: 'hint' }, 'You said you need time. Choose when you are ready.') : null,
    h('fieldset', {},
      h('legend', {}, 'Choose the work you want done now'),
      h('ul', { class: 'items' }, q.items.map((i) => itemRow(q, i, st)))),
    h('div', { class: 'total' }, h('span', {}, `Selected (${chosen.length} of ${q.items.length})`), h('span', { class: 'amount' }, usd(total))),
    h('div', { class: 'actions' },
      h('button', { class: 'primary', type: 'button', disabled: !chosen.length, onclick: () => { st.stage = 'review'; render(); $(`#r-${q.id}`)?.focus(); } }, chosen.length ? `Review ${usd(total)} of work` : 'Select work to review'),
      h('button', { class: 'secondary', type: 'button', onclick: (e) => decideOther(q, 'declined', e.target) }, 'Decline all'),
      h('button', { class: 'link-btn', type: 'button', onclick: (e) => decideOther(q, 'deferred', e.target) }, 'I need time to decide')),
    askPanel(q, st));
  return sec;
}

function askPanel(q, st) {
  const ta = h('textarea', { id: `ask-${q.id}`, rows: 2, maxlength: 500, placeholder: 'e.g. "Hose only. Leave the filter for next time."' });
  const btn = h('button', { class: 'secondary', type: 'submit' }, 'Ask');
  const form = h('form', { class: 'ask', onsubmit: async (e) => {
    e.preventDefault();
    const question = ta.value.trim();
    if (!question) return;
    await busy(btn, 'Asking…', async () => {
      st.chat.push({ who: 'you', text: question });
      try {
        const r = await call('POST', `/api/c/quotes/${q.id}/ask`, { question, versionHash: q.version_hash });
        st.chat.push({ who: 'assistant', r });
      } catch (err) {
        st.chat.push({ who: 'error', text: err.message });
        if (err.code === 'STALE_QUOTE') { flash = { text: err.message }; await load(); return; }
      }
    });
    render();
    $(`#ask-${q.id}`)?.focus();
  } },
    h('label', { for: `ask-${q.id}` }, 'Ask a question, or tell us what you want in your own words'),
    h('div', { class: 'ask-row' }, ta, btn),
    h('p', { class: 'hint' }, 'Answers use only this quote and the mechanic’s note. The assistant cannot approve work or change prices; questions it cannot answer go to the shop.'));
  const log = h('ol', { class: 'chat', 'aria-label': 'Questions and answers' }, st.chat.map((m) => chatLine(q, st, m)));
  return h('div', { class: 'ask-wrap' }, st.chat.length ? log : null, form);
}

function chatLine(q, st, m) {
  if (m.who === 'you') return h('li', { class: 'you' }, h('span', { class: 'who' }, 'You'), m.text);
  if (m.who === 'error') return h('li', { class: 'err' }, h('span', { class: 'who' }, 'Not answered'), m.text);
  const r = m.r;
  const names = r.selected_item_ids.map((id) => q.items.find((i) => i.id === id)?.name).filter(Boolean);
  const label = r.kind === 'handoff' ? 'Sent to the shop' : r.fixed_text ? 'Payment status' : 'Assistant';
  return h('li', { class: `bot ${r.kind}` }, h('span', { class: 'who' }, label), r.answer,
    r.kind === 'selection' && names.length ? h('div', { class: 'suggest' },
      h('span', {}, `Suggested: ${names.join(', ')} · ${usd(r.selection_total_cents)}`),
      h('button', { class: 'secondary small', type: 'button', onclick: () => {
        st.selected = new Set(r.selected_item_ids);
        st.suggestionId = r.suggestion_id;
        render();
        say(`Selected ${names.join(', ')}. Review before approving.`);
      } }, 'Select these items')) : null);
}

function reviewSection(q, st) {
  const chosen = q.items.filter((i) => st.selected.has(i.id));
  const left = q.items.filter((i) => !st.selected.has(i.id));
  const total = chosen.reduce((s, i) => s + i.unit_cents * i.qty, 0);
  const approveBtn = h('button', { class: 'primary', type: 'button', onclick: (e) => approve(q, st, chosen, total, e.target) }, `Approve ${usd(total)} and continue to PayPal`);
  return h('section', { class: 'sheet', 'aria-labelledby': `r-${q.id}` },
    h('div', { class: 'sheet-head' }, h('h2', { id: `r-${q.id}`, tabindex: '-1' }, 'Check your choice'), h('span', { class: 'meta' }, `${q.title} · quote v${q.version}`)),
    h('table', { class: 'lines' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Work'), h('th', { scope: 'col', class: 'num' }, 'Qty'), h('th', { scope: 'col', class: 'num' }, 'Amount'))),
      h('tbody', {}, chosen.map((i) => h('tr', {}, h('td', {}, i.name), h('td', { class: 'num' }, i.qty), h('td', { class: 'num' }, usd(i.unit_cents * i.qty))))),
      h('tfoot', {}, h('tr', {}, h('th', { scope: 'row', colspan: 2 }, 'Total'), h('td', { class: 'num strong' }, usd(total))))),
    left.length ? h('p', { class: 'not-included' }, 'Not included: ', left.map((i) => `${i.name} (${usd(i.unit_cents * i.qty)})`).join(', ')) : null,
    h('ol', { class: 'steps' },
      h('li', {}, `Approve: you ask ${data.job.shop_name} to do the work above.`),
      h('li', {}, `PayPal: you approve a hold of ${usd(total)}. You are not charged yet.`),
      h('li', {}, 'Finish: the shop charges the hold after doing the work. If the shop cancels the work, the hold is released.')),
    h('div', { class: 'actions' }, approveBtn,
      h('button', { class: 'secondary', type: 'button', onclick: () => { st.stage = 'choose'; render(); } }, 'Back')));
}

async function approve(q, st, chosen, total, btn) {
  await busy(btn, 'Saving your approval…', async () => {
    try {
      const r = await call('POST', `/api/c/quotes/${q.id}/decision`, {
        decision: 'approved', versionHash: q.version_hash, expectedTotalCents: total,
        items: chosen.map((i) => ({ id: i.id, qty: i.qty })), aiSuggestionId: st.suggestionId || undefined,
      });
      st.changing = false;
      st.stage = 'choose';
      await goToPayPal(r.approval_id, btn);
    } catch (err) {
      await handleError(err);
    }
  });
}

async function goToPayPal(approvalId, btn) {
  btn.textContent = 'Opening PayPal…';
  try {
    const p = await call('POST', `/api/c/approvals/${approvalId}/checkout`);
    if (p.approve_url) {
      sessionStorage.setItem('ra_token', token);
      location.assign(p.approve_url);
      return;
    }
    flash = { text: p.text };
    await load();
  } catch (err) {
    flash = { text: `Your work approval is saved. ${err.message}`, tone: 'bad' };
    await load();
  }
}

async function decideOther(q, decision, btn) {
  await busy(btn, 'Saving…', async () => {
    try {
      await call('POST', `/api/c/quotes/${q.id}/decision`, { decision, versionHash: q.version_hash, items: [] });
      quoteUi(q).changing = false;
      flash = { text: decision === 'declined' ? 'You declined this quote. Nothing is held or charged for it.' : 'Saved. The shop will not start this work until you decide.' };
      await load();
    } catch (err) { await handleError(err); }
  });
}

async function handleError(err) {
  if (err.code === 'STALE_QUOTE') {
    flash = { text: 'The shop updated this quote. Your earlier selection was cleared; review the new version.', tone: 'bad' };
    for (const k of Object.keys(ui)) delete ui[k];
  } else {
    flash = { text: err.message, tone: 'bad' };
  }
  await load();
}

function statusRows(q) {
  const a = q.approval;
  const p = q.payment;
  const work = a.status === 'cancelled' ? `Cancelled by the shop · approved by you ${when(a.created_at)}` : a.decision === 'approved'
    ? `Approved by you · ${a.selected.length} of ${q.items.length} items · ${usd(a.total_cents)} · ${when(a.created_at)}`
    : a.decision === 'declined' ? `Declined · ${when(a.created_at)}` : `You asked for time · ${when(a.created_at)}`;
  const rows = [h('div', { class: 'status-row' }, h('span', { class: 'axis' }, 'Work'), h('span', { class: `badge ${a.decision === 'approved' && a.status !== 'cancelled' ? 'done' : 'quiet'}` }, work))];
  if (a.decision === 'approved') {
    const pv = p || { label: 'Not charged', text: 'Nothing has been charged. Continue to PayPal to finish.', state: 'not_started' };
    rows.push(h('div', { class: 'status-row' }, h('span', { class: 'axis' }, 'Payment'), h('span', { class: `badge ${tone(pv.state)}` }, pv.label)));
    rows.push(h('p', { class: 'pay-text' }, pv.text));
  }
  return rows;
}

function summarySection(q) {
  const a = q.approval;
  const st = quoteUi(q);
  const p = q.payment;
  const chosen = a.decision === 'approved' ? q.items.filter((i) => a.selected.includes(i.id)) : [];
  const left = q.items.filter((i) => !chosen.includes(i));
  const canChange = a.status !== 'cancelled' && (!p || ['not_started', 'awaiting_buyer', 'abandoned'].includes(p.state));
  const actions = [];
  if (a.decision === 'approved' && a.status !== 'cancelled' && (!p || ['not_started', 'awaiting_buyer'].includes(p.state))) {
    actions.push(h('button', { class: 'primary', type: 'button', onclick: (e) => busy(e.target, 'Opening PayPal…', () => goToPayPal(a.id, e.target)) }, `Continue to PayPal (${usd(a.total_cents)})`));
  }
  if (canChange) actions.push(h('button', { class: 'secondary', type: 'button', onclick: () => { st.changing = true; st.stage = 'choose'; render(); } }, 'Change my choice'));
  return h('section', { class: 'sheet compact', 'aria-labelledby': `t-${q.id}` },
    h('div', { class: 'sheet-head' }, h('h2', { id: `t-${q.id}` }, q.title), h('span', { class: 'meta' }, `quote v${q.version}`)),
    h('ul', { class: 'items readonly' },
      chosen.map((i) => h('li', { class: 'item' }, h('span', { class: 'mark', 'aria-hidden': 'true' }, '✓'), h('span', { class: 'item-name' }, i.name), h('span', { class: 'amount' }, usd(i.unit_cents * i.qty)))),
      left.map((i) => h('li', { class: 'item declined' }, h('span', { class: 'mark', 'aria-hidden': 'true' }, '–'), h('span', { class: 'item-name' }, h('s', {}, i.name), h('span', { class: 'sr' }, ' (not approved)')), h('span', { class: 'amount' }, h('s', {}, usd(i.unit_cents * i.qty)))))),
    h('div', { class: 'status' }, statusRows(q)),
    actions.length ? h('div', { class: 'actions' }, actions) : null);
}

async function handlePayPalReturn() {
  const params = new URLSearchParams(location.search);
  const paymentId = params.get('p');
  const orderId = params.get('token');
  token = sessionStorage.getItem('ra_token');
  if (!token) {
    main.replaceChildren(h('h1', {}, 'Back from PayPal'), h('p', {}, 'Open the repair link from the shop again to see your status. If you approved in PayPal, the shop can confirm it.'));
    return;
  }
  const cancelled = location.pathname === '/paypal/cancel';
  history.replaceState(null, '', `/c/${token}`);
  main.replaceChildren(h('p', { class: 'loading' }, cancelled ? 'Saving…' : 'Confirming your PayPal approval…'));
  try {
    if (cancelled) {
      await call('POST', `/api/c/payments/${paymentId}/closed`, { orderId });
      flash = { text: 'You left PayPal without approving. Nothing is held or charged. Your work choice is saved; continue to PayPal when you are ready.' };
    } else {
      const r = await call('POST', `/api/c/payments/${paymentId}/return`, { orderId });
      flash = r.payment.state === 'held'
        ? { text: `Done. PayPal is holding ${usd(r.payment.amount_cents)}. You are not charged until the shop finishes the work.`, tone: 'good' }
        : { text: r.message || r.payment.text };
    }
  } catch (err) {
    flash = { text: err.message, tone: 'bad' };
  }
  await load();
}

async function init() {
  try {
    if (location.pathname.startsWith('/paypal/')) return await handlePayPalReturn();
    token = decodeURIComponent(location.pathname.split('/')[2] || '');
    sessionStorage.setItem('ra_token', token);
    await load();
  } catch (err) {
    main.replaceChildren(h('h1', {}, err.code === 'LINK_EXPIRED' ? 'This link has expired' : 'We could not open this repair'), h('p', {}, err.message));
  }
}

init();
