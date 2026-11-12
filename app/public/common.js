export const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function usd(cents) {
  const whole = Math.floor(cents / 100).toLocaleString('en-US');
  return `$${whole}.${String(cents % 100).padStart(2, '0')}`;
}

export function when(isoString) {
  if (!isoString) return '';
  return new Date(isoString).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function day(isoString) {
  return isoString ? new Date(isoString).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
}

export async function api(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'X-Requested-With': 'repair-approval', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error(data.message || `Request failed (${res.status}).`);
    err.code = data.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

// Disables the button while the action runs so a double click cannot send twice.
export async function busy(button, label, fn) {
  const old = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = label;
  try { return await fn(); } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = old;
  }
}

export function tone(state) {
  if (['paid'].includes(state)) return 'done';
  if (['capture_declined'].includes(state)) return 'bad';
  if (['released', 'abandoned', 'auth_expired'].includes(state)) return 'quiet';
  return 'wait';
}
