#!/usr/bin/env node
// Creates the four Notion databases the Worker expects (plus starter data) under a parent page.
//
// Usage:
//   NOTION_KEY=secret_xxx node scripts/setup-notion.mjs <parentPageIdOrUrl> [--write-config] [--force] [--no-seed]
//
//   --write-config  fill the four ids into wrangler.toml [vars] in place
//   --force         continue even if databases with these names already exist under the parent page
//   --no-seed       create empty databases (no starter exercises / day templates)
//
// No dependencies; needs Node 20+ (global fetch). Uses Notion API version 2025-09-03.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MUSCLE_GROUPS, EQUIPMENT } from "../src/exercise-options.js"; // shared with the Worker validation and the app dropdowns

const NOTION = "https://api.notion.com/v1";
const VERSION = "2025-09-03";
const KEY = process.env.NOTION_KEY;
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

function die(msg) { console.error("\nERROR: " + msg); process.exit(1); }

if (!KEY) die("NOTION_KEY is not set. Run:  NOTION_KEY=<your token> node scripts/setup-notion.mjs <parentPageIdOrUrl>");
if (!positional[0]) die("Missing parent page. Pass the id or URL of a Notion page that is shared with your connection.");

// A page id is 32 hex chars, optionally with dashes, usually at the end of the URL.
function parseId(s) {
  const clean = s.split("?")[0].replace(/-/g, "");
  const m = clean.match(/[0-9a-fA-F]{32}(?![0-9a-fA-F])/);
  if (!m) die(`Could not find a 32-character page id in "${s}".`);
  const h = m[0].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const PARENT = parseId(positional[0]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(NOTION + path, {
      method,
      headers: { Authorization: `Bearer ${KEY}`, "Notion-Version": VERSION, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status >= 502) && attempt < 6) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep((ra > 0 ? ra : 1 + attempt) * 1000);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const hint = data.code === "object_not_found"
        ? " (the parent page is probably not shared with your connection: open the page in Notion, ... menu > Connections > add your connection)"
        : data.code === "unauthorized" ? " (the token is invalid)" : "";
      throw new Error(`Notion ${res.status} ${data.code || ""}: ${data.message || ""}${hint}`);
    }
    return data;
  }
}

// ---------- schema ----------
const opts = (names) => ({ select: { options: names.map((name) => ({ name })) } });
const DAY_TYPES = ["Push", "Pull", "Legs", "Upper", "Lower", "Full Body", "Arms"];

const created = []; // what exists so far, reported on failure
async function createDb(title, properties) {
  const db = await api("POST", "/databases", {
    parent: { type: "page_id", page_id: PARENT },
    title: [{ type: "text", text: { content: title } }],
    initial_data_source: { properties },
  });
  const ds = db.data_sources?.[0]?.id;
  if (!ds) throw new Error(`Database "${title}" was created (${db.id}) but no data source id was returned.`);
  created.push({ title, database: db.id, dataSource: ds });
  console.log(`  created ${title}: database ${db.id}, data source ${ds}`);
  return ds;
}

const rt = (s) => [{ type: "text", text: { content: s } }];
const SEED_EXERCISES = [
  ["Barbell Bench Press", "Chest", "Barbell"], ["Dumbbell Bench Press", "Chest", "Dumbbell"], ["Incline Dumbbell Press", "Upper Chest", "Dumbbell"],
  ["Cable Fly", "Chest", "Cable"], ["Chest Press Machine", "Chest", "Machine"], ["Push-Up", "Chest", "Bodyweight"],
  ["Pull-Up", "Lats", "Bodyweight"], ["Lat Pulldown", "Lats", "Cable"], ["Barbell Row", "Upper Back", "Barbell"], ["Seated Cable Row", "Upper Back", "Cable"],
  ["One-Arm Dumbbell Row", "Lats", "Dumbbell"], ["Face Pull", "Rear Delts", "Cable"], ["Deadlift", "Lower Back", "Barbell"],
  ["Overhead Press", "Front Delts", "Barbell"], ["Dumbbell Shoulder Press", "Front Delts", "Dumbbell"], ["Lateral Raise", "Side Delts", "Dumbbell"], ["Rear Delt Fly", "Rear Delts", "Machine"],
  ["Barbell Curl", "Biceps", "Barbell"], ["Dumbbell Curl", "Biceps", "Dumbbell"], ["Hammer Curl", "Biceps", "Dumbbell"], ["Cable Curl", "Biceps", "Cable"],
  ["Triceps Pushdown", "Triceps", "Cable"], ["Overhead Triceps Extension", "Triceps", "Cable"], ["Skull Crusher", "Triceps", "Barbell"], ["Dip", "Triceps", "Bodyweight"],
  ["Back Squat", "Quads", "Barbell"], ["Front Squat", "Quads", "Barbell"], ["Leg Press", "Quads", "Machine"], ["Leg Extension", "Quads", "Machine"],
  ["Bulgarian Split Squat", "Quads", "Dumbbell"], ["Walking Lunge", "Quads", "Dumbbell"],
  ["Romanian Deadlift", "Hamstrings", "Barbell"], ["Leg Curl", "Hamstrings", "Machine"],
  ["Hip Thrust", "Glutes", "Barbell"], ["Glute Bridge", "Glutes", "Bodyweight"],
  ["Standing Calf Raise", "Calves", "Machine"], ["Seated Calf Raise", "Calves", "Machine"],
  ["Plank", "Abs", "Bodyweight"], ["Hanging Leg Raise", "Abs", "Bodyweight"], ["Cable Crunch", "Abs", "Cable"],
  ["Treadmill Run", "Cardio", "Machine"], ["Rowing Machine", "Cardio", "Machine"], ["Wrist Curl", "Forearms", "Dumbbell"],
];
// [exercise, target sets, target reps]
const SEED_TEMPLATES = {
  Push: [["Barbell Bench Press", 4, "5-8"], ["Incline Dumbbell Press", 3, "8-10"], ["Overhead Press", 3, "6-10"], ["Lateral Raise", 3, "12-15"],
    ["Cable Fly", 3, "12-15"], ["Triceps Pushdown", 3, "10-12"], ["Overhead Triceps Extension", 3, "10-12"]],
  Pull: [["Pull-Up", 4, "6-10"], ["Barbell Row", 3, "8-10"], ["Lat Pulldown", 3, "10-12"], ["Seated Cable Row", 3, "10-12"],
    ["Face Pull", 3, "12-15"], ["Barbell Curl", 3, "8-12"], ["Hammer Curl", 3, "10-12"]],
  Legs: [["Back Squat", 4, "5-8"], ["Romanian Deadlift", 3, "8-10"], ["Leg Press", 3, "10-12"], ["Leg Curl", 3, "10-12"],
    ["Leg Extension", 3, "12-15"], ["Standing Calf Raise", 4, "10-15"], ["Hanging Leg Raise", 3, "10-15"]],
};

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k]); }
  }));
}

// ---------- main ----------
async function existingDatabaseTitles() {
  const titles = [];
  let cursor;
  do {
    const r = await api("GET", `/blocks/${PARENT}/children?page_size=100${cursor ? "&start_cursor=" + cursor : ""}`);
    for (const b of r.results) if (b.type === "child_database") titles.push(b.child_database.title);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return titles;
}

async function main() {
  console.log(`Parent page: ${PARENT}`);
  await api("GET", `/pages/${PARENT}`); // fails early with a clear hint if the page is not shared

  const have = (await existingDatabaseTitles()).filter((t) => ["Exercises", "Sessions", "Sets", "Day Templates"].includes(t));
  if (have.length && !flags.has("--force")) {
    die(`This page already contains database(s) named: ${have.join(", ")}.\nRunning again would create duplicates. If setup already worked, reuse the existing databases.\nTo create a second set anyway, re-run with --force.`);
  }

  console.log("Creating databases...");
  const exercisesDs = await createDb("Exercises", {
    Name: { title: {} },
    "Muscle Group": opts(MUSCLE_GROUPS),
    Equipment: opts(EQUIPMENT),
    Notes: { rich_text: {} },
  });
  const sessionsDs = await createDb("Sessions", {
    Name: { title: {} },
    Date: { date: {} },
    "Day Type": opts(DAY_TYPES),
    Notes: { rich_text: {} },
  });
  const setsDs = await createDb("Sets", {
    Name: { title: {} },
    Session: { relation: { data_source_id: sessionsDs, dual_property: { synced_property_name: "Sets" } } },
    Exercise: { relation: { data_source_id: exercisesDs, dual_property: { synced_property_name: "Sets" } } },
    "Set #": { number: { format: "number" } },
    "Weight (lb)": { number: { format: "number" } },
    Reps: { number: { format: "number" } },
    "Each Side": { checkbox: {} },
    Notes: { rich_text: {} },
    Volume: { formula: { expression: 'prop("Weight (lb)") * prop("Reps")' } },
    "Est. 1RM": { formula: { expression: 'round(prop("Weight (lb)") * (1 + prop("Reps") / 30))' } },
  });
  const templatesDs = await createDb("Day Templates", {
    Name: { title: {} },
    "Day Type": opts([...DAY_TYPES, "Planned"]), // "Planned" rows hold the Plan tab's saved plans (not a real day type)
    Exercise: { relation: { data_source_id: exercisesDs, dual_property: { synced_property_name: "Day Templates" } } },
    Order: { number: { format: "number" } },
    "Target Sets": { number: { format: "number" } },
    "Target Reps": { rich_text: {} },
    Notes: { rich_text: {} },
  });

  if (!flags.has("--no-seed")) {
    console.log(`Seeding ${SEED_EXERCISES.length} starter exercises...`);
    const idByName = new Map();
    await pool(SEED_EXERCISES, 3, async ([name, muscle, equip]) => {
      const pg = await api("POST", "/pages", {
        parent: { type: "data_source_id", data_source_id: exercisesDs },
        properties: { Name: { title: rt(name) }, "Muscle Group": { select: { name: muscle } }, Equipment: { select: { name: equip } } },
      });
      idByName.set(name, pg.id);
    });
    const rows = [];
    for (const [day, list] of Object.entries(SEED_TEMPLATES)) list.forEach(([ex, sets, reps], i) => rows.push({ day, ex, sets, reps, order: i + 1 }));
    console.log(`Seeding ${rows.length} Day Templates rows (Push, Pull, Legs)...`);
    await pool(rows, 3, async (r) => {
      await api("POST", "/pages", {
        parent: { type: "data_source_id", data_source_id: templatesDs },
        properties: {
          Name: { title: rt(`${r.day} - ${r.ex}`) },
          "Day Type": { select: { name: r.day } },
          Exercise: { relation: [{ id: idByName.get(r.ex) }] },
          Order: { number: r.order },
          "Target Sets": { number: r.sets },
          "Target Reps": { rich_text: rt(r.reps) },
        },
      });
    });
  }

  const lines = [
    "[vars]",
    `EXERCISES_DS = "${exercisesDs}"`,
    `SESSIONS_DS = "${sessionsDs}"`,
    `SETS_DS = "${setsDs}"`,
    `TEMPLATES_DS = "${templatesDs}"`,
  ];
  console.log("\nDone. Put these lines in wrangler.toml (replacing the existing [vars] block):\n");
  console.log(lines.join("\n"));

  if (flags.has("--write-config")) {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const file = join(root, "wrangler.toml");
    // wrangler.toml is your own (git-ignored) config; create it from the committed template on first run.
    if (!existsSync(file) && existsSync(join(root, "wrangler.toml.example"))) copyFileSync(join(root, "wrangler.toml.example"), file);
    if (!existsSync(file)) die("wrangler.toml not found; copy wrangler.toml.example to wrangler.toml and paste the lines above by hand.");
    let toml = readFileSync(file, "utf8");
    const set = (name, val) => {
      const re = new RegExp(`^${name}\\s*=.*$`, "m");
      if (!re.test(toml)) throw new Error(`${name} not found in wrangler.toml`);
      toml = toml.replace(re, `${name} = "${val}"`);
    };
    set("EXERCISES_DS", exercisesDs); set("SESSIONS_DS", sessionsDs); set("SETS_DS", setsDs); set("TEMPLATES_DS", templatesDs);
    writeFileSync(file, toml);
    console.log("\nwrangler.toml updated.");
  }
}

main().catch((e) => {
  console.error("\nERROR: " + e.message);
  if (created.length) {
    console.error("\nSetup stopped part-way. These were already created under the parent page (delete them in Notion before re-running, or re-run with --force):");
    for (const c of created) console.error(`  ${c.title}: database ${c.database}, data source ${c.dataSource}`);
  } else console.error("Nothing was created.");
  process.exit(1);
});
