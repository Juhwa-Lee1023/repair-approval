# Repair Approval — project story

## Inspiration

A car is on the lift for front brake pads. The mechanic notices a cracked radiator hose and a dirty air filter, and texts the customer. The customer replies, "Hose only. Leave the filter for next time." A week later, nobody is sure whether the filter was included or what the new total was. Small independent shops without a shop-management suite handle this by phone and text, and the record of what was agreed is whatever is in the message thread.

## What it does

The shop writes a quote: items, quantities, prices, and a short note in the mechanic's words explaining why. The customer opens a link on their phone, reads the note, and ticks the items to do now. They can type a question or an answer in plain words. The assistant answers from the quote only, or turns "hose only" into a suggested selection the customer can apply with one tap.

The customer reviews the exact list and total, presses Approve, and approves a PayPal hold for that amount. Nothing is charged yet. When the work is done, the shop presses Charge and the server captures exactly the approved amount. If approved work is cancelled before it is done, the shop releases the hold instead.

Each add-on is its own quote version and its own PayPal order. The shop screen shows two statuses side by side: whether the **work** is approved (and which version), and where the **payment** stands: waiting for PayPal, held but not charged, charged, or released.

## How it was built

- **Server:** Node.js with no npm dependencies. SQLite (`node:sqlite`) stores jobs, quote versions, approvals, payments, every PayPal operation and an event history.
- **PayPal:** Orders v2 with `intent: AUTHORIZE`, line items and `custom_id` set to the app's approval ID. Payments v2 for capture (`final_capture: true`), void and GET. Every mutation carries a stable `PayPal-Request-Id` and is reserved in the database before it is sent.
- **Assistant:** Claude through the local Claude Code CLI with all tools disabled. The prompt allows five result types (selection, clarify, answer, handoff, payment question). The server rejects unknown item IDs and any dollar amount that isn't a price or a sum of prices on the quote.
- **UI:** plain HTML, CSS and JavaScript modules. Phone-first customer page, desktop shop page. Built to look like a work order rather than a dashboard.

## Challenges

- **"Completed" doesn't mean charged.** After `authorize`, PayPal reports the *order* as `COMPLETED` while the *authorization* is only `CREATED`. The app reads the authorization and capture objects, not the order status.
- **A successful charge without an amount.** In the first Sandbox run, a capture returned `201 COMPLETED` with only `id`, `status` and `links`. The test script crashed after saving the capture ID. We checked the result with `GET` instead of capturing again. The app now always saves the ID first and confirms status and amount with `GET`.
- **PayPal doesn't stop a larger capture.** PayPal allows a capture to exceed the authorized amount within limits, and its review screen says the amount may change. The rule "charge exactly what the customer approved" is enforced by this server.
- **Timeouts.** If PayPal doesn't answer, the outcome is unknown. The app blocks the button, shows "Checking with PayPal", and resends only with the original request ID after reading PayPal's state.
- **The assistant repeating the customer's numbers.** In the first trial run, 4 of 19 answers correctly passed price requests to the shop but repeated the customer's figure ("your request for $20 off"). The validator rejected them. We changed the prompt so the assistant refers to "your price request" and kept the strict check. The second run passed 19 of 19 on the same fixed expectations.

## What we learned

PayPal's checkout window shows items, but the list is collapsed by default and sits below the payment method. The customer's real decision has to happen on our page, item by item, before PayPal opens. PayPal's job is to hold and move the agreed amount.

## What's next

- Run the full buyer-approval path in the browser and record it (pending in this build).
- Photos on quote items, and SMS delivery of the customer link.
- Handling expired holds and reauthorization; refunds after a charge.
- Testing with a real shop. No user research has been done yet.
