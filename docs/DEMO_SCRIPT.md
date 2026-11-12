# Demo script (under 3 minutes)

Record the real app on the local machine against PayPal Sandbox. Start from `npm run reset`. Keep the Sandbox label visible. Don't show the shop key, the customer link token, `.env` files or the PayPal Developer dashboard. Don't use the developer-account balance page; it isn't a live ledger.

| Time | Screen | Action | Voice-over (suggested) |
|---|---|---|---|
| 0:00–0:15 | Shop, RO-1042 | Show the job header and three quotes | "A shop is replacing brake pads. The mechanic found a cracked radiator hose and a dirty air filter." |
| 0:15–0:30 | Shop | **Send to customer** on quote 2, **Create customer link**, open it | "The shop sends one link. The customer doesn't need an account." |
| 0:30–1:00 | Customer (phone width) | Show note and items. Type "Hose only. Leave the filter for next time." → **Ask** → **Select these items** | "The customer answers in their own words. The assistant only reads this quote. It suggests the hose and its labor, $103. It can't approve anything." |
| 1:00–1:10 | Customer | Ask "Can you knock $20 off?" | "Price requests go to the shop. The assistant doesn't negotiate." |
| 1:10–1:30 | Customer review | Show the list, "Not included: Engine air filter", the three steps; press **Approve $103.00 and continue to PayPal** | "The customer approves exact items. Next, PayPal holds $103. Nothing is charged yet." |
| 1:30–1:50 | PayPal Sandbox | Expand *Order details* (two items), approve | "PayPal shows the same two lines. Its list is collapsed by default, which is why our page shows them first." |
| 1:50–2:05 | Customer | Return message | "Back in the app: held, not charged." |
| 2:05–2:25 | Shop | Work: Approved v1, 2 of 3 items. Payment: Held, not charged. **Mark work done** → **Charge $103.00** → Charged. Open *PayPal record* | "The shop charges after the work is done. The server charges exactly the approved amount and checks PayPal's record before showing Charged." |
| 2:25–2:45 | Shop | Quote 3 (filter, approved and held earlier): **Cancel work and release hold** → Hold released | "If approved work is cancelled, the hold is released. A customer who declines up front never had a hold, so there's nothing to release." |
| 2:45–2:55 | Shop history | Scroll the history | "Every approval, version, hold, charge and release is recorded." |

Before recording: approve quote 3 ($25) in PayPal so it shows as held when you reach it. Budget: each run creates up to 3 Sandbox orders.

Captions should describe what is on screen at that moment. Don't add music you don't have rights to.
