// Synthetic sample job. Amounts match the PayPal Sandbox evidence: 420 + 103, and a separate 25 job.
import { newId } from '../src/service.js';

export function seedJob(db, svc, now = new Date()) {
  const jobId = newId('job');
  db.prepare('INSERT INTO jobs (id, ref, customer_name, vehicle, shop_name, created_at) VALUES (?,?,?,?,?,?)')
    .run(jobId, 'RO-1042', 'Sam Rivera', '2017 Honda Civic', 'Northside Auto Repair', now.toISOString());
  const base = svc.createQuote({
    jobId, kind: 'base', status: 'sent', title: 'Front brake pads',
    note: 'You booked a front brake pad replacement. We measured the front pads at 2 mm. This quote covers new pads and the labor to fit them.',
    items: [
      { id: 'brake-part', sku: 'BRAKE-PART', name: 'Front brake pads', qty: 1, unit_cents: 30000, reason: 'Replacement pads for both front wheels.' },
      { id: 'brake-labor', sku: 'BRAKE-LABOR', name: 'Labor - brake pad replacement', qty: 1, unit_cents: 12000, reason: 'Fitting the new pads.' },
    ],
  });
  const addon = svc.createQuote({
    jobId, kind: 'addon', status: 'draft', title: 'Found during the brake job',
    note: 'While the car was on the lift I saw the upper radiator hose is cracked near the clamp and there is coolant residue around it. I recommend replacing it. The engine air filter is dirty; it can wait until your next service if you prefer.',
    items: [
      { id: 'hose-part', sku: 'HOSE-PART', name: 'Upper radiator hose', qty: 1, unit_cents: 3800, reason: 'Cracked near the clamp, coolant residue around it.' },
      { id: 'hose-labor', sku: 'HOSE-LABOR', name: 'Labor - hose replacement (0.5h)', qty: 1, unit_cents: 6500, reason: 'Fitting the new hose and topping up coolant.' },
      { id: 'filter-part', sku: 'FILTER-PART', name: 'Engine air filter', qty: 1, unit_cents: 2500, reason: 'Dirty. Can wait until your next service.' },
    ],
  });
  const filter = svc.createQuote({
    jobId, kind: 'addon', status: 'draft', title: 'Air filter (you called back)',
    note: 'You called back and asked us to replace the engine air filter today after all. This is a separate approval for that one item.',
    items: [
      { id: 'filter-part', sku: 'FILTER-PART', name: 'Engine air filter', qty: 1, unit_cents: 2500, reason: 'Dirty. Replacing it today at your request.' },
    ],
  });
  return { jobId, base, addon, filter };
}
