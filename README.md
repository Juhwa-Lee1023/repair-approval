# Repair Approval

A mechanic finds more work halfway through a repair. The customer answers by text, often with something like "Hose only. Leave the filter for next time." Later, both sides need to know exactly what was approved and what will be charged.

Repair Approval gives the customer a link to the shop's itemized quote. The customer picks the items, sees the total, and approves it. PayPal then **holds** that exact amount. The shop **charges** it after the work is done, or **releases** the hold if the work is cancelled. Each add-on gets its own quote version and its own PayPal order, so the record shows which items, which version and which payment belong together.

Built for small independent repair shops that don't use a full shop-management suite. **PayPal Sandbox only. No real money moves.**

## How it works

| Step | Who | What happens |
|---|---|---|
| 1 | Shop | Writes a quote (items, quantity, price, a note explaining why) and sends the customer a link. |
| 2 | Customer | Reads the note, asks questions, ticks the items to do now, reviews the total, presses **Approve**. |
| 3 | Customer | Approves the hold in PayPal. Our page lists the items before PayPal opens, because PayPal's own item list is collapsed by default. |
| 4 | Server | Asks PayPal for the order, checks the approval ID, currency, items and exact total, then places the hold (`AUTHORIZE`). |
| 5 | Shop | Marks the work done, then presses **Charge**. The server captures exactly the approved amount (`final_capture: true`) and confirms it with a `GET` before showing "Charged". |
| 5′ | Shop | If approved work is cancelled before it is done, presses **Cancel work and release hold** (`void`). |

The screens show two separate statuses for each quote:

- **Work:** waiting for customer / approved v2, 2 of 3 items, $103.00 / declined / customer wants time / cancelled by shop
- **Payment:** not charged / waiting for PayPal approval / held, not charged / charged / hold released, not charged / checking with PayPal

A customer who declines before PayPal never gets a hold, so there is nothing to release. If the customer approves the work but closes PayPal, the screen shows "Waiting for PayPal approval" and the shop is told not to start.

## The assistant

On the quote page the customer can type a question or an answer in their own words. The assistant uses only the mechanic's note and the current quote items. It returns one of:

- **selection:** the items the customer named (shown as "Suggested: … [Select these items]"; the customer still reviews and approves)
- **clarify:** for "yes" or "ok" when several items exist
- **answer:** what an item is, why it's recommended, what it costs
- **handoff:** discounts, conditions ("only if under $100"), out-of-scope work, "I need to ask my wife", and safety or urgency questions the note doesn't answer. The question appears in the shop's history.
- **payment_question:** the server answers with fixed wording based on the real payment state; the model's text is discarded.

The server rejects output that names an item not on the quote, or mentions a dollar amount that is not an item price or a sum of items. A rejected or failed answer shows an error and passes the message to the shop. There is no canned fallback answer.

The assistant cannot approve work, change prices, create quote versions, or call PayPal. Those happen only through the customer's Approve button, the PayPal approval screen, and the shop's buttons.

The default provider is the locally installed **Claude Code CLI** (`claude -p --tools ""`), using the machine's existing Claude login with all tools disabled. Set `AI_PROVIDER=off` to run without it; the page then says the assistant is unavailable.

## Money rules the server enforces

- Prices come only from the shop's quote. The browser sends item IDs and the total it displayed. The server recomputes the total in integer cents, rejects unknown IDs, changed quantities, price fields and total mismatches.
- Each quote version has a hash. Approvals, assistant suggestions and checkouts are tied to that hash. When the shop edits a quote, the old choice is cleared; stale tabs and stale suggestions are rejected; an old PayPal order for a replaced choice is never authorized.
- The capture amount must equal the approved amount and the held amount. PayPal allows a capture to exceed the authorized amount within limits, so this check is the app's own rule. PayPal does not enforce it.
- Every PayPal mutation (`create order`, `authorize`, `capture`, `void`) is reserved in SQLite before it is sent, with a stable `PayPal-Request-Id`. Double clicks, duplicate returns and concurrent requests find the reservation and do not send again.
- If PayPal doesn't answer (timeout, 5xx, crash mid-request), the payment shows **Checking with PayPal** and the Charge button is blocked. **Check with PayPal** reads PayPal first. If the request needs resending, it reuses the original request ID. Nothing retries automatically.
- A successful capture can come back without an amount (we saw this in Sandbox), so the server saves the capture ID first and then `GET`s the capture. Only `COMPLETED` with the exact amount becomes "Charged". `PENDING` shows "Charge pending at PayPal".
- The PayPal host is fixed to `api-m.sandbox.paypal.com`. Approval links must start with `https://www.sandbox.paypal.com/`. No setting switches to live.

## Run it

Requirements: Node.js 22.13 or newer (uses the built-in `node:sqlite`; tested on Node 24.19). No npm packages are needed. For the assistant, install the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) and sign in once.

```bash
cd app
mkdir -p ../private && cp .env.example ../private/paypal-sandbox.env   # then add your Sandbox client ID and secret
npm run check-config      # shows which settings are present, never the values
npm run seed              # sample job RO-1042 and a shop key; prints the shop sign-in link
npm start                 # http://127.0.0.1:8879
```

Open the printed `/shop/login#key=…` link, press **Send to customer** on a quote, then **Create customer link** and open it.

PayPal Sandbox credentials come from a [PayPal Developer](https://developer.paypal.com/) Sandbox REST app. The server reads them from `../private/paypal-sandbox.env` (or the `PAYPAL_ENV_FILE` path, or environment variables). They are never sent to the browser or written to logs.

`npm run reset` deletes this app's local database and shop key (only inside `app/var/`) and reseeds. It doesn't touch PayPal.

## Tests

```bash
cd app
npm test                  # 20 local tests; PayPal and the assistant are mocks here
npm run ai-trials         # real assistant calls through the Claude CLI (19 fixed cases)
npm run sandbox-check     # real PayPal Sandbox calls through the running app (creates 3 orders)
```

The local tests cover price tampering, unknown items, quantity changes, stale quotes and stale suggestions, cross-job and expired links, shop-only routes, missing CSRF header, duplicate PayPal returns, concurrent capture clicks, capture and authorize timeouts with reconciliation, pending captures, decline-vs-release, closing PayPal, mismatched orders, secret leakage and restart persistence. Results are in [`qa/`](qa/).

## What has and hasn't been verified

Verified in real PayPal Sandbox before this app (with the original probe script): authorize → capture → GET for $420 and $103, authorize → void → GET for $25, and the minimal capture response without an amount.

Verified in real PayPal Sandbox through this app: order creation for $420, $103 and $25 with exact line items; double-click checkout producing one order; resending the same `PayPal-Request-Id` returning the same order; a return before buyer approval not placing a hold; a return with the wrong order ID being refused. See [`qa/sandbox-check.json`](qa/sandbox-check.json).

Not yet run through this app: the buyer approving in the PayPal window, then hold, charge and release from the app's buttons. That needs a person in a browser and is described in [`docs/TESTING.md`](docs/TESTING.md). Also not tested: live payments, refunds, partial capture, reauthorization, and how fast a bank shows a released hold. A PayPal hold can be charged later, but the charge itself can still fail. PayPal lists the hold as valid for 29 days and recommends charging within 3 days; the app shows PayPal's own expiry time and doesn't set its own deadline.

## Project layout

```
app/src/server.js     HTTP routes, sessions, security headers
app/src/service.js    quotes, versions, approvals, payment state machine, reconciliation
app/src/paypal.js     Sandbox-only REST client with path allow-list and redacted request log
app/src/ai.js         Claude CLI provider, prompt, output validation
app/public/           customer page (phone-first) and shop page (desktop)
app/test/             local tests with a mock PayPal and mock assistant
app/scripts/          seed, reset, real AI trials, real Sandbox check
qa/                   test logs, AI trial logs, Sandbox results
docs/                 project story, testing guide, AI/tool disclosure, demo script
```

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
