# AI and tool use

## Inside the app

| What | Model / tool | Role | Limits |
|---|---|---|---|
| Customer assistant | Claude (`claude-sonnet-5-5`) through the locally installed Claude Code CLI, run as `claude -p --tools "" --strict-mcp-config --no-session-persistence` | Reads the mechanic's note and the current quote items; returns a JSON suggestion: selected item IDs, a clarifying question, a short answer, or a hand-off to the shop | No tools, no PayPal access, no app secrets in its environment. Server validates item IDs and dollar amounts. Payment questions get fixed server text. The customer must still press Approve. |
| Payments | PayPal REST APIs, Sandbox | Orders v2 (`AUTHORIZE` intent) and Payments v2 (capture, void, GET) | Sandbox host is fixed in code. |

The model ID observed in CLI metadata for every recorded call was `claude-sonnet-5-5` (see `qa/ai-trials.jsonl`). The CLI uses the developer machine's existing Claude login; no new API key was created for this project.

## Building the project

| Tool | Use |
|---|---|
| Claude Code with Claude Opus 5.5 (`claude-opus-5-5`) | Wrote the application code, tests, scripts and documentation in this repository, and ran the tests, AI trials and Sandbox checks. |
| Earlier research with Claude models (Opus, Fable) | Design reviews before implementation. Their suggestions were checked against the Sandbox evidence; some were rejected (for example "structurally impossible to overcharge"). |
| PayPal Developer Sandbox | Test merchant and buyer accounts. Original probe results are summarized in `qa/EVIDENCE_READ.json`. |

All AI-generated code was run and tested locally. The test numbers in `qa/` are from those runs; no user study was done.
