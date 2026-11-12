import { $, api } from './common.js';

async function signIn(key) {
  await api('POST', '/api/shop/login', { key });
  location.replace('/shop');
}

const fromHash = new URLSearchParams(location.hash.slice(1)).get('key');
if (fromHash) {
  history.replaceState(null, '', '/shop/login');
  signIn(fromHash).catch((e) => { $('#error').textContent = e.message; $('#error').hidden = false; });
}

$('#login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = ev.submitter;
  btn.disabled = true;
  try { await signIn($('#key').value.trim()); } catch (e) {
    $('#error').textContent = e.message;
    $('#error').hidden = false;
  } finally { btn.disabled = false; }
});
