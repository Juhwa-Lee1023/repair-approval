# Testing instructions

Everything runs locally against PayPal Sandbox. You need Node.js 22.13+, a PayPal Developer Sandbox REST app (client ID and secret), and a Sandbox **personal** (buyer) account to approve payments. The assistant needs the Claude Code CLI signed in; without it, set `AI_PROVIDER=off`, and the rest still works.

## 1. Start

```bash
cd app
mkdir -p ../private && cp .env.example ../private/paypal-sandbox.env   # add your Sandbox client ID and secret
npm run reset      # fresh sample job + shop key; prints the shop sign-in link
npm start          # http://127.0.0.1:8879
```

Open the printed `http://127.0.0.1:8879/shop/login#key=…` link. You are now on the shop screen for repair order RO-1042 (2017 Honda Civic).

## 2. Main walkthrough

1. **Shop:** quote 1, *Front brake pads* ($420.00), is already sent. On quote 2, *Found during the brake job*, press **Send to customer**.
2. **Shop:** press **Create customer link**, then **Open customer view**. Use a phone-sized window if you like.
3. **Customer:** quote 2 is first. Type `Hose only. Leave the filter for next time.` and press **Ask**. The assistant suggests the hose and its labor ($103.00). Press **Select these items**, then **Review $103.00 of work**.
4. **Customer:** check the list and the "Not included: Engine air filter" line, then press **Approve $103.00 and continue to PayPal**.
5. **PayPal (Sandbox):** sign in with your Sandbox buyer account. Open *Order details* to see the two items. Approve.
6. **Customer:** you return to the app. It reads "PayPal is holding $103.00. You are not charged until the shop finishes the work."
7. **Shop:** reload. Quote 2 shows *Work: Approved · v1 · 2 of 3 items · $103.00* and *Payment: Held, not charged*. Press **Mark work done**, then **Charge $103.00**. The status becomes *Charged*. Open *PayPal record* to see the order, authorization and capture IDs and each request ID.
8. Repeat steps 3–7 for quote 1 ($420.00) if you want a second charge.

## 3. Cancel after approval (release the hold)

1. **Shop:** on quote 3, *Air filter (you called back)*, press **Send to customer**.
2. **Customer:** reload, select the filter, approve $25.00 and approve in PayPal.
3. **Shop:** press **Cancel work and release hold**, enter a reason, confirm. The payment becomes *Hold released, not charged*. History shows the void. A charge is never sent.

## 4. Other paths to try

| Try this | Expected |
|---|---|
| Customer presses **Decline all** | Work: declined. No PayPal order, no hold, nothing to release. |
| Customer approves, then uses *Return to merchant* / cancel in PayPal | "You left PayPal without approving. Nothing is held or charged." Shop sees "Do not start yet". |
| Ask `Can you knock $20 off?` or `I need to check with my wife` | Assistant hands off; shop history shows the customer's question. Nothing is approved. |
| Ask `Have I been charged?` | Fixed text that matches the real payment state. |
| Shop edits a quote (**Edit quote** → change a price → **Save as v2**) while the customer page is open | Customer's old selection is cleared; approving from the old tab fails with "The shop updated this quote". |
| Double-click **Charge** or reload the PayPal return page | Still one capture (see *PayPal record*). |
| Open the customer link after 7 days, or with a changed token | "This link has expired" / "This link is not valid". |

## 5. Automated checks

```bash
cd app
npm test             # 20 local tests, mock PayPal + mock assistant
npm run ai-trials    # 19 real assistant calls via the Claude CLI; writes qa/ai-trials*.json*
npm run sandbox-check  # with the server running: creates 3 real Sandbox orders through the app API
```

`npm run sandbox-check` stops before buyer approval and writes the approval links to `handoff/sandbox-approval-links.json` (git-ignored). Approve them in a browser to continue with step 7 above.
