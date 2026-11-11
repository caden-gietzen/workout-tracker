import test from "node:test";
import assert from "node:assert/strict";
import "../public/charts.js";
import "../public/plan.js";
import { readFileSync } from "node:fs";
import worker from "../src/worker.js";
import { MUSCLE_GROUPS, EQUIPMENT } from "../src/exercise-options.js";
import { validateNewExercise, findDuplicateExercise, mergeMuscleGroups, parseExercise } from "../src/logic.js";

const C = globalThis.Charts, P = globalThis.Plan;
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const plain = (arr) => arr.map((t) => ({ plain_text: t.text.content }));
const conv = (props) => Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v.title ? { title: plain(v.title) } : v.rich_text ? { rich_text: plain(v.rich_text) } : v]));

// Fake Notion with one in-memory table per data source (enough filters for the routes under test).
function fakeNotion() {
  const tables = { EXERCISES: [], SESSIONS: [], SETS: [], TEMPLATES: [] }; let seq = 900; const calls = [];
  tables.EXERCISES.push({ id: id(1), properties: { Name: { title: [{ plain_text: "Lat Pulldown" }] }, "Muscle Group": { select: { name: "Back" } } } });
  const ok = (o) => new Response(JSON.stringify(o), { status: 200 });
  const text = (pg, k) => ((pg.properties[k]?.rich_text || pg.properties[k]?.title || []).map((t) => t.plain_text).join(""));
  const fetchFn = async (url, init) => {
    const u = new URL(url), method = init.method, body = init.body ? JSON.parse(init.body) : {};
    calls.push(`${method} ${u.pathname}`);
    if (method === "GET" && u.pathname === "/v1/data_sources/SESSIONS") return ok({ properties: { "Day Type": { select: { options: [{ name: "Back" }] } } } });
    const q = u.pathname.match(/^\/v1\/data_sources\/(\w+)\/query$/);
    if (method === "POST" && q) {
      let res = tables[q[1]].filter((p) => !p.in_trash);
      const f = body.filter;
      if (f?.property === "Notes") res = res.filter((p) => text(p, "Notes").includes(f.rich_text.contains));
      if (f?.property === "Name") res = res.filter((p) => text(p, "Name").startsWith(f.title.starts_with));
      if (f?.property === "Session") res = res.filter((p) => p.properties.Session.relation[0].id === f.relation.contains);
      if (f?.property === "Exercise") res = res.filter((p) => p.properties.Exercise.relation[0].id === f.relation.contains);
      return ok({ results: res, has_more: false });
    }
    if (method === "POST" && u.pathname === "/v1/pages") {
      const pg = { id: id(seq++), created_time: new Date(Date.now() + seq * 1000).toISOString(), properties: conv(body.properties) };
      tables[body.parent.data_source_id].push(pg); return ok(pg);
    }
    return new Response(JSON.stringify({ message: "unexpected " + method + " " + u.pathname }), { status: 404 });
  };
  return { tables, calls, fetchFn };
}
const env = { NOTION_KEY: "k", APP_PIN: "1234", EXERCISES_DS: "EXERCISES", SESSIONS_DS: "SESSIONS", SETS_DS: "SETS", TEMPLATES_DS: "TEMPLATES", ASSETS: { fetch: async () => new Response("asset") } };
const w = (method, path, body, pin = "1234") => worker.fetch(new Request("http://x" + path, { method, headers: { "X-App-Pin": pin }, body: body ? JSON.stringify(body) : undefined }), env);
async function withFake(fn) {
  const fake = fakeNotion(), real = globalThis.fetch; globalThis.fetch = fake.fetchFn;
  try { await fn(fake); } finally { globalThis.fetch = real; }
}

test("shared muscle group list covers every required group and has no duplicates", () => {
  for (const m of ["Chest", "Upper Chest", "Lats", "Upper Back", "Traps", "Lower Back", "Front Delts", "Side Delts", "Rear Delts", "Biceps", "Triceps", "Forearms", "Quads", "Hamstrings", "Glutes", "Adductors", "Abductors", "Calves", "Abs", "Obliques", "Hip Flexors", "Neck", "Full Body", "Cardio"]) assert.ok(MUSCLE_GROUPS.includes(m), m);
  assert.equal(new Set(MUSCLE_GROUPS).size, MUSCLE_GROUPS.length);
});
test("setup script uses the shared constant (no private muscle list)", () => {
  const src = readFileSync(new URL("../scripts/setup-notion.mjs", import.meta.url), "utf8");
  assert.match(src, /from "\.\.\/src\/exercise-options\.js"/);
  assert.match(src, /opts\(MUSCLE_GROUPS\)/);
  assert.doesNotMatch(src, /const MUSCLES\s*=/);
  for (const m of src.matchAll(/\["[^"]+", "([A-Za-z ]+)", "(?:Barbell|Dumbbell|Cable|Machine|Bodyweight)"\]/g)) assert.ok(MUSCLE_GROUPS.includes(m[1]), m[1]);
});

test("validateNewExercise trims, collapses spaces and whitelists", () => {
  assert.deepEqual(validateNewExercise({ name: "  Cable   Lateral Raise ", muscle: "Side Delts", equipment: "Cable" }).value, { name: "Cable Lateral Raise", muscle: "Side Delts", equipment: "Cable", newMuscle: false });
  assert.equal(validateNewExercise({ name: "X", muscle: "Neck" }).value.equipment, "");
  const bad = (b, known) => validateNewExercise(b, known).error;
  assert.match(bad(null), /JSON object/);
  assert.match(bad({ muscle: "Neck" }), /name required/);
  assert.match(bad({ name: "   ", muscle: "Neck" }), /name required/);
  assert.match(bad({ name: "x".repeat(101), muscle: "Neck" }), /at most 100/);
  assert.match(bad({ name: "a\u0007b", muscle: "Neck" }), /invalid characters/);
  assert.match(bad({ name: "A" }), /muscle group required/);
  assert.match(bad({ name: "A", muscle: "Pecs" }), /Unknown muscle group/);
  assert.match(bad({ name: "A", muscle: "lats" }), /Unknown muscle group/);
  assert.match(bad({ name: "A", muscle: "Neck", equipment: "Rope" }), /Unknown equipment/);
  assert.match(bad({ name: 5, muscle: "Neck" }), /name required/);
  assert.equal(findDuplicateExercise([{ name: "Lat  Pulldown" }], " lat pulldown ").name, "Lat  Pulldown");
});

test("custom muscle group validation: trimmed, limited, plain characters, no case-insensitive duplicates", () => {
  const ok = validateNewExercise({ name: "A", muscle: "  Serratus   Anterior ", newMuscle: true });
  assert.deepEqual(ok.value, { name: "A", muscle: "Serratus Anterior", equipment: "", newMuscle: true });
  const bad = (muscle, known) => validateNewExercise({ name: "A", muscle, newMuscle: true }, known);
  assert.match(bad("x").error, /2-40/);
  assert.match(bad("x".repeat(41)).error, /2-40/);
  assert.match(bad("   ").error, /muscle group required/);
  assert.match(bad("<b>hi</b>").error, /may only contain/);
  assert.match(bad("-Lats").error, /may only contain/);
  assert.match(bad("Rib\u0000s").error, /may only contain/);
  const dup = bad("  upper   CHEST ");
  assert.equal(dup.ok, false); assert.equal(dup.conflict, true); assert.match(dup.error, /"Upper Chest" already exists/);
  assert.equal(bad("Serratus", [...MUSCLE_GROUPS, "SERRATUS"]).conflict, true);
  assert.equal(validateNewExercise({ name: "A", muscle: "Neck", newMuscle: "yes" }).ok, false);
});
test("mergeMuscleGroups keeps the fixed list first and adds custom ones once", () => {
  const m = mergeMuscleGroups([{ muscle: "Serratus" }, { muscle: "serratus" }, { muscle: "chest" }, { muscle: "Back" }, { muscle: "" }, {}]);
  assert.deepEqual(m.slice(0, MUSCLE_GROUPS.length), MUSCLE_GROUPS);
  assert.deepEqual(m.slice(MUSCLE_GROUPS.length), ["Back", "Serratus"]);
});

test("POST /api/exercise: success writes the Notion row and the exercise shows up in bootstrap", async () => {
  await withFake(async (fake) => {
    const res = await w("POST", "/api/exercise", { name: "  Cable Lateral Raise ", muscle: "Side Delts", equipment: "Cable" });
    assert.equal(res.status, 201);
    const { exercise } = await res.json();
    assert.equal(exercise.name, "Cable Lateral Raise"); assert.equal(exercise.muscle, "Side Delts"); assert.equal(exercise.equipment, "Cable");
    assert.equal(fake.tables.EXERCISES.length, 2);
    const props = fake.tables.EXERCISES[1].properties;
    assert.equal(props.Name.title[0].plain_text, "Cable Lateral Raise");
    assert.equal(props["Muscle Group"].select.name, "Side Delts");
    assert.equal(props.Equipment.select.name, "Cable");
    const boot = await (await w("GET", "/api/bootstrap")).json();
    assert.deepEqual(boot.exercises.find((e) => e.id === exercise.id), exercise);
    assert.deepEqual(boot.muscleGroups.slice(0, MUSCLE_GROUPS.length), MUSCLE_GROUPS); assert.deepEqual(boot.equipmentOptions, EQUIPMENT);
    // a second create is visible immediately too (bootstrap cache is dropped by each write)
    const r2 = await (await w("POST", "/api/exercise", { name: "Neck Curl", muscle: "Neck" })).json();
    assert.equal(r2.exercise.equipment, "");
    assert.ok((await (await w("GET", "/api/bootstrap")).json()).exercises.some((e) => e.id === r2.exercise.id));
    assert.equal(parseExercise(fake.tables.EXERCISES[2]).muscle, "Neck");
  });
});

test("POST /api/exercise: duplicates are rejected case-insensitively with a clear message", async () => {
  await withFake(async (fake) => {
    for (const name of ["Lat Pulldown", "lat pulldown", "  LAT   PULLDOWN  "]) {
      const res = await w("POST", "/api/exercise", { name, muscle: "Lats" });
      assert.equal(res.status, 409);
      assert.match((await res.json()).error, /"Lat Pulldown" already exists/);
    }
    assert.equal(fake.tables.EXERCISES.length, 1, "nothing was written");
    assert.equal((await w("POST", "/api/exercise", { name: "Row", muscle: "Lats" })).status, 201);
    assert.equal((await w("POST", "/api/exercise", { name: "ROW", muscle: "Lats" })).status, 409);
  });
});

test("POST /api/exercise: invalid input is a 400 and writes nothing", async () => {
  await withFake(async (fake) => {
    for (const body of [{ name: "A", muscle: "Pecs" }, { name: "A" }, { name: "", muscle: "Neck" }, { name: "A", muscle: "Neck", equipment: "Rope" }, { name: "x".repeat(101), muscle: "Neck" }, { name: "A", muscle: "<script>", newMuscle: true }]) {
      const res = await w("POST", "/api/exercise", body);
      assert.equal(res.status, 400, JSON.stringify(body)); assert.ok((await res.json()).error);
    }
    const res = await worker.fetch(new Request("http://x/api/exercise", { method: "POST", headers: { "X-App-Pin": "1234" }, body: "{nope" }), env);
    assert.equal(res.status, 400);
    assert.equal(fake.tables.EXERCISES.length, 1);
  });
});

test("POST /api/exercise: PIN required, no Notion traffic without it", async () => {
  await withFake(async (fake) => {
    assert.equal((await w("POST", "/api/exercise", { name: "A", muscle: "Neck" }, "wrong")).status, 401);
    assert.equal((await w("POST", "/api/exercise", { name: "A", muscle: "Neck" }, "")).status, 401);
    assert.equal(fake.calls.length, 0);
  });
});

test("custom muscle group: created with the first exercise, persists in bootstrap, usable again, duplicates rejected", async () => {
  await withFake(async (fake) => {
    const res = await w("POST", "/api/exercise", { name: "Serratus Push-Up", muscle: " Serratus  Anterior ", newMuscle: true });
    assert.equal(res.status, 201);
    const d = await res.json();
    assert.equal(d.exercise.muscle, "Serratus Anterior"); assert.equal(d.createdMuscleGroup, true);
    assert.ok(d.muscleGroups.includes("Serratus Anterior"));
    assert.equal(fake.tables.EXERCISES[1].properties["Muscle Group"].select.name, "Serratus Anterior", "written as a select value (Notion adds the option)");
    // persists: a fresh bootstrap lists it after the fixed groups, and the exercise carries it (filtering/grouping/Progress use e.muscle)
    const boot = await (await w("GET", "/api/bootstrap")).json();
    assert.deepEqual(boot.muscleGroups.slice(0, MUSCLE_GROUPS.length), MUSCLE_GROUPS);
    assert.ok(boot.muscleGroups.includes("Serratus Anterior"));
    assert.equal(boot.exercises.find((e) => e.id === d.exercise.id).muscle, "Serratus Anterior");
    // now it is a normal group: selectable without newMuscle
    const again = await w("POST", "/api/exercise", { name: "Serratus Wall Slide", muscle: "Serratus Anterior" });
    assert.equal(again.status, 201); assert.equal((await again.json()).createdMuscleGroup, false);
    // duplicates (case-insensitive) rejected, for custom and fixed groups, nothing written
    const n = fake.tables.EXERCISES.length;
    for (const m of ["serratus anterior", "SERRATUS   ANTERIOR", "lats", "Upper Chest"]) {
      const r = await w("POST", "/api/exercise", { name: "Other " + m, muscle: m, newMuscle: true });
      assert.equal(r.status, 409, m); assert.match((await r.json()).error, /already exists/);
    }
    assert.equal(fake.tables.EXERCISES.length, n);
    // an unknown group without the newMuscle flag is still refused
    assert.equal((await w("POST", "/api/exercise", { name: "Q", muscle: "Rib Cage" })).status, 400);
  });
});

test("brand-new exercise: no history anywhere, then a normal exercise after its first session", async () => {
  await withFake(async (fake) => {
    const { exercise } = await (await w("POST", "/api/exercise", { name: "Neck Curl", muscle: "Neck" })).json();
    // Log tab data: no last/summary/history, the app starts it with one blank set
    let boot = await (await w("GET", "/api/bootstrap")).json();
    assert.equal(boot.last[exercise.id], undefined); assert.equal(boot.summary[exercise.id], undefined); assert.equal(boot.history[exercise.id], undefined);
    // Progress tab: the history route answers with an empty list and the chart code copes
    const h = await (await w("GET", "/api/history?exerciseId=" + exercise.id)).json();
    assert.deepEqual(h.sessions, []);
    assert.deepEqual(C.buildSeries(h.sessions), []);
    // Plan tab: a plan may carry target sets/reps for it, weight comes later
    const put = await w("PUT", "/api/plan", { date: "2026-11-12", dayType: "Back", exercises: [{ exerciseId: exercise.id, targetSets: 3, targetReps: "12-15" }] });
    assert.equal(put.status, 200);
    const planned = (await put.json()).exercises[0];
    assert.deepEqual([planned.name, planned.targetSets, planned.targetReps], ["Neck Curl", 3, "12-15"]);
    assert.deepEqual(P.add([], exercise), [{ exerciseId: exercise.id, name: "Neck Curl", targetSets: null, targetReps: "" }]);
    // first logged session
    const save = await w("POST", "/api/session", { dayType: "Back", date: "2026-11-10", clientId: "client-0001", exercises: [{ exerciseId: exercise.id, sets: [{ weight: 25, reps: 12 }, { weight: 30, reps: 10 }] }] });
    assert.equal(save.status, 200);
    boot = await (await w("GET", "/api/bootstrap")).json();
    assert.equal(boot.summary[exercise.id].sessions, 1); assert.equal(boot.summary[exercise.id].bestWeight, 30);
    assert.equal(boot.last[exercise.id].sets.length, 2);
    const h2 = await (await w("GET", "/api/history?exerciseId=" + exercise.id)).json();
    assert.equal(h2.sessions.length, 1);
    assert.equal(C.buildSeries(h2.sessions)[0].weight, 30);
    const list = await (await w("GET", "/api/sessions")).json();
    assert.deepEqual(list.sessions[0].exercises, ["Neck Curl"]);
  });
});
