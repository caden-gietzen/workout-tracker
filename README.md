# Workout Tracker

A phone-first web app (PWA) for logging gym workouts set by set. It runs on a free Cloudflare Worker and stores everything in your own Notion workspace, so you own your data and can look at it, chart it or edit it in Notion any time.

What it does:

- Log each set (weight, reps, "each side" flag) with big tap targets, built for one hand in the gym.
- Pre-fills each day's lineup from a **Day Templates** table in Notion (exercise order, target sets, target reps), using the weights and reps from your last time.
- Shows progression hints (last sessions, best weight, estimated 1RM).
- Works offline: sets are queued on the phone and saved when you are back online.
- Installs on the home screen like an app. Page zoom is blocked so taps do not zoom by accident.
- Protected by a PIN, with a lockout against guessing.

## How it works

```
 Phone (PWA, installed from the browser)
        |  HTTPS, header X-App-Pin
        v
 Cloudflare Worker  ---- serves the static UI (public/)
        |            ---- /api/bootstrap, /api/session
        |  checks PIN, lockout counters live in Workers KV (binding LOCK)
        |  Notion API (token kept as a Worker secret)
        v
 Notion workspace: 4 databases
   Exercises <---- Sets ----> Sessions
   Exercises <---- Day Templates
```

The four Notion databases:

| Database | Purpose |
| --- | --- |
| Exercises | Name, Muscle Group (select, see `src/exercise-options.js`), Equipment (select), Notes |
| Sessions | One row per workout: Name, Date, Day Type, Notes |
| Sets | One row per set: Session, Exercise, Set #, Weight (lb), Reps, Each Side, plus formulas Volume and Est. 1RM |
| Day Templates | The planned lineup per day type: Day Type, Exercise, Order, Target Sets, Target Reps, Notes |

You do not create these by hand: a script does it.

## Prerequisites

- Node.js 20 or newer (`node -v`)
- A free [Notion](https://www.notion.so) account
- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account
- Git

## Setup

1. **Clone and install**

   ```
   git clone <this repo's url> workout-tracker
   cd workout-tracker
   npm install
   ```

2. **Create a Notion connection (API token) and share a page with it**
   - Go to <https://www.notion.so/profile/integrations> and create a new **internal** connection (any name, e.g. "Workout Tracker"). Copy its token ("Internal Integration Secret").
   - In Notion, create an empty page called e.g. "Workout Tracker". Open it, click the `...` menu at the top right, **Connections**, and add your connection. The databases will be created inside this page.
   - Copy the page's URL (Share > Copy link).
   - Save the token in a file that git ignores, for example `notion-key.txt` in the repo folder (the first line is the token). Never paste it into chat, issues or commits.

3. **Create the databases**

   ```
   # macOS / Linux / Git Bash
   NOTION_KEY="$(cat notion-key.txt)" node scripts/setup-notion.mjs "<page url>" --write-config

   # Windows PowerShell
   $env:NOTION_KEY = (Get-Content notion-key.txt -Raw).Trim()
   node scripts/setup-notion.mjs "<page url>" --write-config
   ```

   This creates the four databases, about 40 starter exercises and a sample Push / Pull / Legs lineup. If it fails midway it prints what was already created. If the page already contains databases with these names it refuses to run again (use `--force` to override). Add `--no-seed` for empty databases.

4. **Your `wrangler.toml`.** It is git-ignored; `--write-config` creates it from `wrangler.toml.example` and fills in the ids. Otherwise run `cp wrangler.toml.example wrangler.toml` and copy the four `EXERCISES_DS`, `SESSIONS_DS`, `SETS_DS`, `TEMPLATES_DS` lines that the script prints into the `[vars]` section. These ids are not secret.

5. **Log in to Cloudflare and create the KV namespace**

   ```
   npx wrangler login
   npx wrangler kv namespace create LOCK
   ```

   Paste the printed `id` into your `wrangler.toml`, replacing `PASTE_KV_ID_HERE`. (The namespace stores the wrong-PIN counters.) If wrangler asks you to register a workers.dev subdomain, do that once in the browser.

6. **Set the two secrets**

   ```
   npx wrangler secret put NOTION_KEY     # paste the Notion token when prompted
   npx wrangler secret put APP_PIN        # choose a PIN, e.g. a random 8-digit number
   ```

   A random PIN: `node -e "console.log(String(crypto.getRandomValues(new Uint32Array(1))[0]).padStart(8,'0').slice(-8))"`. Wrangler prompts for the value, so it never ends up in your shell history.

7. **Deploy**

   ```
   npx wrangler deploy
   ```

   It prints your URL, like `https://workout-tracker.<your-subdomain>.workers.dev`. A brand-new address can take a few minutes before HTTPS works.

8. **Use it on your phone.** Open the URL, enter the PIN, then use the browser's **Add to Home Screen** (Safari: Share > Add to Home Screen; Chrome: menu > Install app).

## Customizing

Open the **Day Templates** database in Notion. Each row is one exercise on one day type: set `Day Type`, pick the `Exercise`, give it an `Order` (1, 2, 3...), `Target Sets` and `Target Reps` (text such as `8-12` or `15 min`). Day types without any rows fall back to the exercises of your last session of that type.

Day type names come from the options of the `Day Type` select on the **Sessions** database. Add or rename options there (and use the same names in Day Templates). Add exercises in the Exercises database or directly from the app. Changes appear within about 30 seconds (the Worker caches Notion data that long); reopen the app to reload.

## Creating exercises in the app

Both the Log tab (while logging) and the Plan tab (while planning) have **+ Add exercise**, and the picker starts with **+ New exercise**. The form asks for a name (required, at most 100 characters, must not match an existing exercise ignoring case) and a muscle group (required), plus an optional equipment choice. Saving writes the exercise to the Exercises database and adds it straight into the current workout or plan, with no reload. A brand-new exercise has no history, so the Log tab shows no targets or "last time", you enter sets, reps and weight as you log it, and after the first saved session it behaves like any other exercise (Progress, History).

The muscle groups are one fixed list in `src/exercise-options.js` (chest, upper chest, lats, upper back, traps, lower back, front/side/rear delts, biceps, triceps, forearms, quads, hamstrings, glutes, adductors, abductors, calves, abs, obliques, hip flexors, neck, full body, cardio). The same constant validates the API, fills the dropdown (delivered in `/api/bootstrap` as `muscleGroups`) and creates the select options in `scripts/setup-notion.mjs`. The dropdown also offers **Create new muscle group...**: a custom name (2-40 characters, letters, numbers, spaces and `& ' / ( ) . -`, no case-insensitive duplicate of an existing group) is added the first time an exercise is saved with it (Notion creates the select option when a new value is written) and is listed after the fixed groups from then on, because `muscleGroups` in `/api/bootstrap` is the fixed list plus every other group found on existing exercises. Muscle groups already used by older exercises (for example Back, Shoulders, Core from the first version of the starter data) stay valid and are offered too.

API: `POST /api/exercise` (`{name, muscle, equipment?, newMuscle?}`; `newMuscle: true` means `muscle` is a new custom group). Returns 201 `{exercise:{id,name,muscle,equipment}, muscleGroups, createdMuscleGroup}`; 400 for invalid input (bad name, unknown muscle group or equipment); 409 when the name or the new muscle group already exists. Same PIN and lockout as the other routes.

## Plan tab

The **Plan** tab lets you plan a future day while resting between sets today. Pick a date (default tomorrow), optionally start from a day template (or blank), add exercises from your library, reorder them with the up/down buttons, set target sets and reps, choose the day type to log it as, and **Save plan**. A saved plan is stored in the **Day Templates** database as rows with `Day Type` = `Planned`, `Name` = `Planned <date> - <exercise>`, `Order`, `Target Sets`, `Target Reps` and Notes `plan:<date>` / `base:<day type>`. No new database or property is needed (a fresh `setup-notion.mjs` run adds a `Planned` option to Day Templates' Day Type select; on an older database Notion adds that option automatically the first time a plan is saved; delete the option or the rows in Notion to undo it). On the planned date, the Log tab shows **Planned** as the first, preselected choice, which starts your session with those exercises in that order, logged under the plan's day type.

API: `GET /api/plan?date=YYYY-MM-DD`, `PUT /api/plan` (`{date, dayType, exercises:[{exerciseId, targetSets?, targetReps?}]}`; an empty list clears the plan; resending the same body changes nothing), `DELETE /api/plan?date=...`. `/api/bootstrap` also carries `plans` keyed by date.

## Progress tab

The bottom tab bar switches between **Log** (the normal flow), **Plan**, **Progress** and **History**. Switching tabs never touches a session you are logging; the draft stays on the phone.

- The Progress list shows every exercise grouped by muscle group with its best weight and last done date (searchable). Exercises you never logged are hidden behind a "Show never logged" button.
- Tap an exercise for its detail screen: best weight, best est. 1RM, total sets, last done, sessions, a range toggle (3 months, 6 months, 1 year, All) and charts for top set weight, estimated 1RM (weight x (1 + reps/30)) and volume (weight x reps per session, Each Side ignored), plus a list of personal records. Tap a chart to read the value for a session. Bodyweight lifts (no weight) chart best reps and total reps instead.
- The charts are inline SVG made by plain JS (`public/charts.js`, unit tested in `test/charts.test.mjs`); there are no external libraries.
- `GET /api/history?exerciseId=<id>` returns all sessions for one exercise (same PIN and lockout as the rest, cached about 30 seconds). `/api/bootstrap` also carries a per-exercise `summary` for the list. Exercise history is saved in localStorage, so an exercise you opened before still shows when offline (with an "Offline, showing saved data" note).

## History tab

The third tab, **History**, lists every past session (newest first, grouped by month, with day type chips and a search box). Tap a session to open the editor: change the date, day type and notes, edit any set's weight and reps (same -/+ steppers and typed input as the Log tab), toggle Each Side, delete or add sets, delete or add exercises, then tap **Save changes** (the sticky bar shows how many edits are pending; Discard throws them away, and leaving with unsaved changes asks first). **Delete session** at the bottom needs two taps and moves the session and its sets to Notion's trash (recoverable there). Editing needs a connection: offline you get a message instead of a queue, and the list shows the last saved copy.

API (same PIN and lockout as the rest):

- `GET /api/sessions` lists sessions: `[{id, date, dayType, name, setCount, exercises, volume}]`.
- `GET /api/session?id=<id>` returns one session with its sets grouped by exercise (notes are the human part only; the `clientId:` and `order:` marker lines the app stores in Notes are hidden and preserved).
- `PATCH /api/session?id=<id>` takes the desired final state (`date?`, `dayType?`, `notes?`, `exercises:[{exerciseId | newExercise, sets:[{id?, weight, reps, eachSide, notes?}]}]`). The Worker diffs it against Notion and only touches changed rows: updates changed sets, creates sets without an `id`, trashes sets that are gone, renumbers `Set #` 1..n and refreshes set names. Re-sending the same body after a failure converges (sets are matched by id; a new set identical to one already created is adopted, not duplicated). Limits: weight 0-2000, reps 0-500, 40 exercises, 30 sets per exercise. The response is the fresh detail plus `applied` counts.
- `DELETE /api/session?id=<id>` trashes the session and all its sets.

Writes clear the Worker's bootstrap and per-exercise history caches, so Log and Progress reflect edits immediately. Pure logic lives in `src/logic.js` and `public/history.js` (tests: `test/history.test.mjs`).

## Local development

```
cp .dev.vars.example .dev.vars     # then fill in NOTION_KEY and a test APP_PIN
npm run dev                        # http://localhost:8787
```

`.dev.vars` is git-ignored. Local dev talks to your real Notion databases, so use test notes or trash test rows afterwards.

## Tests

```
npm test
```

Runs unit tests for the pure logic (`src/logic.js`) with Node's built-in test runner. No network needed.

## Security notes

- The Notion token lives only in a Cloudflare Worker secret (and your local, git-ignored files). It is never sent to the phone.
- Every `/api` call needs the PIN in the `X-App-Pin` header. After 5 wrong PINs from one IP that IP is locked out for 15 minutes; after 100 wrong PINs per hour across all IPs everyone is locked out for that hour. The lock is checked before the PIN is compared.
- Use a PIN that is long enough to resist guessing (8 digits or more). The PIN is stored on the phone once entered.
- Clear a lockout: `npx wrangler kv key list --binding LOCK --remote` then `npx wrangler kv key delete --binding LOCK --remote "global"` (or `"ip:<address>"`). Lock entries also expire on their own.
- Rotate the Notion token: create a new token in the Notion connection settings, run `npx wrangler secret put NOTION_KEY` again, and revoke the old token. Change the PIN with `npx wrangler secret put APP_PIN`.
- The repo should stay free of secrets; `.gitignore` covers `wrangler.toml` (your own config), `.dev.vars`, `.env`, `*.key`, `notion-key.txt`, `gym-pin.txt`.

## Troubleshooting

- **`npx wrangler deploy` says the workers.dev subdomain is not registered**: run `npx wrangler login`, open <https://dash.cloudflare.com> > Workers & Pages, and register a subdomain once; then deploy again.
- **"name unavailable" / name already taken**: change `name` at the top of `wrangler.toml` to something unique, and deploy again.
- **The new URL does not load right after deploy**: a new address can take a few minutes for TLS to work. Wait and retry.
- **401 Unauthorized** from the app: wrong PIN. **429 Too many wrong PINs**: you are locked out; wait it out or clear it (see Security notes).
- **500 "Not configured: set EXERCISES_DS..."**: a placeholder is still in `wrangler.toml [vars]`; fill in the ids and redeploy.
- **Setup script: `404 object_not_found`**: the parent page is not shared with your Notion connection. Page `...` menu > Connections > add it.
- **Setup script: "page already contains database(s)"**: the databases exist already. Reuse them or trash them in Notion and rerun.
- **A day shows no exercises**: add rows for that Day Type in Day Templates, or log one session first.

## Set it up with Claude

If you use [Claude Code](https://claude.com/claude-code), open it in this repo folder and paste:

> Read SETUP.md and CLAUDE.md in this repo and set this app up for me end to end. Ask me which operating system I use first. Ask me for anything only I can do (Notion connection, Cloudflare login) and confirm before you create anything. Never ask me to paste secrets into chat; have me save them to a file.

`SETUP.md` contains the step-by-step guide written for Claude, including which steps only you can do. It was built and tested on Windows, so Claude treats it as a guide and adapts it to your system.

## License

MIT licensed. See the [LICENSE](LICENSE) file.
