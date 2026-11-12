// All amounts are integer cents. PayPal strings are produced and parsed here only.

export function toPayPalValue(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('INVALID_CENTS');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

export function fromPayPalValue(value) {
  const m = /^(\d+)\.(\d{2})$/.exec(String(value ?? ''));
  if (!m) return null;
  return Number(m[1]) * 100 + Number(m[2]);
}

export function formatUSD(cents) {
  const v = toPayPalValue(cents);
  const [whole, frac] = v.split('.');
  return `$${Number(whole).toLocaleString('en-US')}.${frac}`;
}

export function sumItems(items) {
  let total = 0;
  for (const it of items) {
    if (!Number.isSafeInteger(it.unit_cents) || !Number.isSafeInteger(it.qty) || it.qty < 1) throw new Error('INVALID_ITEM');
    total += it.unit_cents * it.qty;
  }
  if (!Number.isSafeInteger(total)) throw new Error('INVALID_TOTAL');
  return total;
}
