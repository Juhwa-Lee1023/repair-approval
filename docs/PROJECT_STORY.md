# Repair Approval

## Inspiration

“Hose only. Leave the filter for next time.”

A mechanic finds extra work while replacing brake pads. A short text reply can settle the conversation, but the shop still needs an exact list of approved items and a payment for that list. Repair Approval puts those decisions on one page, with a separate PayPal order for each additional quote.

## What it does

The mechanic sends an itemized quote and a note explaining the work. The customer opens a link, reads the note, and chooses what to do now. They can also ask the AI a question or write a reply such as “hose only.” The AI suggests the hose and its labor; the customer checks the selection before approving it.

In the demo, the extra work totals $128. The customer leaves out a $25 filter and approves $103 for the hose and labor. PayPal holds $103. After doing that work, the shop charges the same amount. A separate $25 request shows the other outcome: the shop cancels the work and releases the hold without charging it.

The shop can see **what work was approved** and **whether money is held or charged** side by side. Changing a quote creates a new version that needs a new customer decision. Discounts and questions that the mechanic’s note cannot answer go back to the shop.

## How I built it

I used Node.js, SQLite, and plain HTML, CSS, and JavaScript. The customer page fits a phone; the shop page follows the layout of a work order. There are no npm dependencies.

PayPal Orders v2 creates an order with `intent: AUTHORIZE`, the selected line items, and an ID linking it to the customer’s approval. Payments v2 places the hold, captures it after the shop marks the work done, or releases it when the shop cancels. The server checks the quote version and amount before sending a payment request. It saves the payment ID and checks PayPal’s record before displaying the result.

The AI reads the current quote through a local Claude Code CLI process. It returns item suggestions, answers, clarifying questions, or a message for the shop. The customer approves work on the page; the AI has no payment tools. The repository includes the source and complete local setup instructions. Running the assistant requires a signed-in Claude Code CLI; PayPal requires the reviewer’s own Sandbox app and buyer account.

## Challenges and what I learned

**An order marked completed is not necessarily a charge.** PayPal can report a completed order while the money is only authorized. I separated order, authorization, and capture status in the app.

**A missing response is not a failed payment.** One Sandbox capture succeeded but returned no amount. The app now saves the capture ID first, then reads the result from PayPal instead of sending another charge. Repeated requests reuse the same request ID.

**The approved total needs an app-side check.** PayPal supports capturing more than the authorized amount within limits. Repair Approval recomputes prices from the shop’s quote and restricts the charge to the customer’s approved total.

**The customer needs to see the items before PayPal opens.** PayPal’s item list was collapsed in the checkout I tested. The app therefore shows the selected work, excluded items, and total together before asking the customer to continue.

## What I verified

I ran the customer and shop screens against real PayPal Sandbox accounts: buyer approval, authorization, charging $420 and $103 after marking work done, and releasing a separate $25 hold. The local tests also cover duplicate requests, stale quotes, amount mismatches, and uncertain payment responses. Real AI trials and their failed first run are preserved in the repository.

This is a Sandbox prototype using a fictional repair order. No real payments or customer study were involved. The next step is a shop trial to check whether customers understand the item selection and the difference between a hold and a charge. Photos and message delivery would make that trial easier to run.

## AI and tools

The in-app assistant uses Claude Sonnet 5.5 through Claude Code CLI. Claude Code with Opus 5.5 generated the implementation and tests; OpenAI Codex reviewed the app, edited the interface and documentation, and checked the browser flow. Earlier Opus and Fable discussions informed the design. Details are in `docs/AI_AND_TOOLS_DISCLOSURE.md`.
