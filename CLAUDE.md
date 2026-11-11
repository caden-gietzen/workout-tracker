# Workout Tracker: instructions for Claude Code

A Cloudflare Worker (`src/worker.js`) serves a PWA (`public/`) and an `/api` that reads and writes four Notion databases (Exercises, Sessions, Sets, Day Templates). See README.md for the full description. When the user asks you to "set this up", follow SETUP.md (see "Setting this up for a user" below).

## Rules

- Never print, echo, log or commit a secret (Notion token, PIN, Cloudflare tokens). Do not ask the user to paste secrets into chat. Have them save the token to a gitignored file (for example `notion-key.txt` in the repo root) and read it from there.
- Pass secrets via environment variables read from the file, or via stdin: `npx wrangler secret put NOTION_KEY < notion-key.txt` and for the PIN `printf '%s' "$PIN" | npx wrangler secret put APP_PIN`. Tell the user the PIN by having them read the file you saved it in (for example `gym-pin.txt`, gitignored), not in chat output unless they ask.
- Do not `git commit` or `git push` unless the user asks. `wrangler.toml` is created from `wrangler.toml.example` by setup (ids); it is git-ignored.
- After every step, verify with a command and report the evidence (exit code, a count, an HTTP status). Do not claim success without it.
- Do not run `wrangler deploy` or create Cloudflare resources before telling the user what will happen and getting a yes.
- Shell: use the user's OS (ask first). On Windows use Git Bash or PowerShell as appropriate; on macOS/Linux bash or zsh. Node 20+ is required.

## Setting this up for a user

**Read SETUP.md and follow it.** It is written to you: ask the user which operating system they use first, treat the steps as a guide (they were built and tested on Windows only, so adapt to the user's environment), confirm each external action (creating Notion databases, KV namespace, secrets, deploying) with the user before doing it, and never reuse anyone else's ids. The Notion and Cloudflare ids in this repo are placeholders (`wrangler.toml.example`); the user's own `wrangler.toml` is git-ignored.

## File map

- `src/worker.js`: Worker entry. PIN check with KV lockout, Notion calls, `/api/bootstrap`, `/api/history`, `/api/sessions` (GET) and `/api/session` (POST create, GET/PATCH/DELETE by id). Notion data source ids come from env vars.
- `src/plan.js`: Plan tab backend (validation, diff, `/api/plan` GET/PUT/DELETE) written against a small store interface (Notion in the Worker, in-memory in tests). Plans are stored as `Planned` rows in Day Templates (Name `Planned <date> - <exercise>`, Notes `plan:<date>` + `base:<day type>`), no schema change.
- `src/logic.js`: pure functions (Notion parsing, bootstrap building, payload validation, `resolveDataSources`). All unit-tested.
- `public/charts.js`: pure chart logic (series, PRs, ticks, SVG strings), used by the browser and by `test/charts.test.mjs`.
- `public/history.js`: pure History-tab helpers (labels, grouping, change counting), tested in `test/history.test.mjs`.
- `public/plan.js`: pure Plan-tab helpers (dates, reorder, dirty check), tested in `test/plan.test.mjs`.
- `public/`: the PWA (`index.html`, `app.js`, `style.css`, `sw.js` service worker, manifest, icons).
- `scripts/setup-notion.mjs`: creates the four databases and starter data under a parent page; `--write-config`, `--force`, `--no-seed`.
- `test/*.test.mjs`: unit tests (logic, charts, history, plan).
- `wrangler.toml.example`: template. Copy to `wrangler.toml` (git-ignored; `setup-notion.mjs --write-config` does it for you). Worker config: `[vars]` data source ids (non-secret), KV binding `LOCK`. Secrets `NOTION_KEY` and `APP_PIN` are set with `wrangler secret put`, never stored in files that get committed.
- `.dev.vars.example`: template for local `.dev.vars`.

## Testing

- `npm test` (Node built-in runner, no network). Run it after any change to `src/`.
- Notion property names are part of the contract between `scripts/setup-notion.mjs` and `src/logic.js` / `src/worker.js`. If you rename a property, change all three and the README.
- Live checks go against the user's own Notion data: use notes starting with `TEST` and trash the test rows afterwards.
