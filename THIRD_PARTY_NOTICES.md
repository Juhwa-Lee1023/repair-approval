# Third-party notices

The app has **no npm dependencies**. `app/package-lock.json` lists no packages.

| Component | How it is used | License / terms |
|---|---|---|
| Node.js runtime (incl. built-in `node:sqlite`, `node:http`, `node:test`) | Runs the server, database and tests. Not bundled. | MIT and bundled third-party licenses: https://github.com/nodejs/node/blob/main/LICENSE |
| PayPal REST APIs (Orders v2, Payments v2), Sandbox environment | Called over HTTPS from the server. No PayPal SDK or code is included. | PayPal developer terms. "PayPal" is a trademark of PayPal, Inc.; this project is not affiliated with or endorsed by PayPal. |
| Claude Code CLI (Anthropic) | Optional local process the server starts for the customer assistant. Not bundled. | Anthropic terms: https://www.anthropic.com/legal |

No fonts, images, icons, audio or other third-party assets are included. The UI uses the device's system fonts.
