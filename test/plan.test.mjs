import test from "node:test";
import assert from "node:assert/strict";
import "../public/plan.js";
import { validatePlan, diffPlan, handlePlan } from "../src/plan.js";
import { buildBootstrap, buildPlans, parseDayTemplate, planRowName, planNotes, planRowDate, planRowBase } from "../src/logic.js";
import worker from "../src/worker.js";

const P = globalThis.Plan;
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const E1 = id(1), E2 = id(2), E3 = id(3);
const LIB = [{ id: E1, name: "Lat Pulldown", muscle: "Back", equipment: "" }, { id: E2, name: "Hammer Curl", muscle: "Biceps", equipment: "" }, { id: E3, name: "Bench Press", muscle: "Chest", equipment: "" }];
const DAY_TYPES = ["Back", "Chest"];

// ---- in-memory plan store (the storage abstraction) ----
function memStore() {
  let seq = 100;
  const rows = [];
  const s = {
    rows, calls: [], invalidated: 0,
    dayTypes: async () => DAY_TYPES,
    exercises: async () => LIB,
    listRows: async (date) => rows.filter((r) => r.date === date && !r.trashed).map((r) => ({ ...r, name: planRowName(r.date, "x"), notes: planNotes(r.date, r.base) })),
    create: async (date, base, row) => { s.calls.push("create"); rows.push({ id: id(seq++), date, base, dayType: "Planned", ...row }); },
    update: async (rid, date, base, row) => { s.calls.push("update"); Object.assign(rows.find((r) => r.id === rid), { base, ...row }); },
    trash: async (rid) => { s.calls.push("trash"); rows.find((r) => r.id === rid).trashed = true; },
    invalidate: () => { s.invalidated++; },
  };
  return s;
}
const call = (store, method, path, body) =>
  handlePlan(new Request("http://x" + path, { method, body: body ? JSON.stringify(body) : undefined }), new URL("http://x" + path), store).then(async (r) => ({ status: r.status, body: await r.json() }));
const ex = (...ids) => ids.map((e) => ({ exerciseId: e }));

test("validatePlan accepts a good plan and normalizes it", () => {
  const v = validatePlan({ date: "2026-11-12", dayType: "Back", exercises: [{ exerciseId: E1, targetSets: 3, targetReps: " 8-12 " }, { exerciseId: E2 }] }, DAY_TYPES);
  assert.equal(v.ok, true);
  assert.deepEqual(v.value.exercises, [{ exerciseId: E1, targetSets: 3, targetReps: "8-12" }, { exerciseId: E2, targetSets: null, targetReps: "" }]);
});
test("validatePlan rejects bad input with a message", () => {
  const bad = (b) => validatePlan(b, DAY_TYPES);
  assert.match(bad(null).error, /JSON object/);
  assert.match(bad({ date: "2026-13-40", exercises: [] }).error, /date/);
  assert.match(bad({ date: "2026-02-30", exercises: [] }).error, /date/);
  assert.match(bad({ date: "2026-11-12" }).error, /exercises/);
  assert.match(bad({ date: "2026-11-12", exercises: ex(E1) }).error, /dayType required/);
  assert.match(bad({ date: "2026-11-12", dayType: "Nope", exercises: ex(E1) }).error, /Unknown dayType/);
  assert.match(bad({ date: "2026-11-12", dayType: "Back", exercises: [{ exerciseId: "zzz" }] }).error, /exerciseId/);
  assert.match(bad({ date: "2026-11-12", dayType: "Back", exercises: ex(E1, E1) }).error, /twice/);
  assert.match(bad({ date: "2026-11-12", dayType: "Back", exercises: [{ exerciseId: E1, targetSets: 0 }] }).error, /targetSets/);
  assert.match(bad({ date: "2026-11-12", dayType: "Back", exercises: [{ exerciseId: E1, targetSets: 2.5 }] }).error, /targetSets/);
  assert.match(bad({ date: "2026-11-12", dayType: "Back", exercises: [{ exerciseId: E1, targetReps: "x".repeat(41) }] }).error, /targetReps/);
  assert.match(bad({ date: "2026-11-12", dayType: "Back", exercises: Array.from({ length: 41 }, (_, i) => ({ exerciseId: id(i + 1) })) }).error, /Max 40/);
});
test("validatePlan: empty exercises means no plan and needs no dayType", () => {
  const v = validatePlan({ date: "2026-11-12", exercises: [] }, DAY_TYPES);
  assert.equal(v.ok, true); assert.equal(v.value.dayType, "");
});

test("diffPlan: create, reorder, remove and idempotence", () => {
  const rows = [
    { id: "r1", exerciseId: E1, order: 1, targetSets: 3, targetReps: "", notes: planNotes("2026-11-12", "Back") },
    { id: "r2", exerciseId: E2, order: 2, targetSets: null, targetReps: "", notes: planNotes("2026-11-12", "Back") },
  ];
  const d = diffPlan(rows, { dayType: "Back", exercises: [{ exerciseId: E3, targetSets: 4, targetReps: "5" }, { exerciseId: E1, targetSets: 3, targetReps: "" }] });
  assert.deepEqual(d.creates.map((c) => [c.exerciseId, c.order]), [[E3, 1]]);
  assert.deepEqual(d.updates.map((u) => [u.id, u.changes]), [["r1", { order: 2 }]]);
  assert.deepEqual(d.trashes, ["r2"]);
  const same = diffPlan(rows, { dayType: "Back", exercises: [{ exerciseId: E1, targetSets: 3, targetReps: "" }, { exerciseId: E2, targetSets: null, targetReps: "" }] });
  assert.deepEqual(same, { creates: [], updates: [], trashes: [] });
  const dup = diffPlan([...rows, { id: "r3", exerciseId: E1, order: 9, notes: "" }], { dayType: "Back", exercises: [{ exerciseId: E1, targetSets: 3, targetReps: "" }] });
  assert.deepEqual(dup.trashes.sort(), ["r2", "r3"]);
  const base = diffPlan(rows, { dayType: "Chest", exercises: [{ exerciseId: E1, targetSets: 3, targetReps: "" }] });
  assert.equal(base.updates[0].changes.base, "Chest");
});

test("row naming and parsing helpers", () => {
  const r = { name: planRowName("2026-11-12", "Hammer Curl"), notes: planNotes("2026-11-12", "Back & Biceps") };
  assert.equal(planRowDate(r), "2026-11-12"); assert.equal(planRowBase(r), "Back & Biceps");
  assert.equal(planRowDate({ name: "x", notes: "plan:2026-01-02" }), "2026-01-02");
});

test("PUT/GET/DELETE /api/plan round trip on the in-memory store", async () => {
  const s = memStore();
  assert.deepEqual((await call(s, "GET", "/api/plan?date=2026-11-12")).body, { date: "2026-11-12", exists: false, dayType: "", exercises: [] });
  const put = await call(s, "PUT", "/api/plan", { date: "2026-11-12", dayType: "Back", exercises: [{ exerciseId: E2, targetSets: 3, targetReps: "10" }, { exerciseId: E1 }] });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.exercises.map((e) => e.name), ["Hammer Curl", "Lat Pulldown"]);
  assert.equal(put.body.dayType, "Back"); assert.equal(put.body.exists, true);
  assert.deepEqual(put.body.applied, { created: 2, updated: 0, trashed: 0 });
  // reorder + drop one + add one
  const put2 = await call(s, "PUT", "/api/plan", { date: "2026-11-12", dayType: "Back", exercises: [{ exerciseId: E1 }, { exerciseId: E3, targetSets: 5 }] });
  assert.deepEqual(put2.body.exercises.map((e) => e.name), ["Lat Pulldown", "Bench Press"]);
  assert.deepEqual(put2.body.applied, { created: 1, updated: 1, trashed: 1 });
  // same body again changes nothing
  const put3 = await call(s, "PUT", "/api/plan", { date: "2026-11-12", dayType: "Back", exercises: [{ exerciseId: E1 }, { exerciseId: E3, targetSets: 5 }] });
  assert.deepEqual(put3.body.applied, { created: 0, updated: 0, trashed: 0 });
  // a different date is independent
  assert.equal((await call(s, "GET", "/api/plan?date=2026-11-13")).body.exists, false);
  const del = await call(s, "DELETE", "/api/plan?date=2026-11-12");
  assert.deepEqual([del.body.deleted, del.body.rowCount], [true, 2]);
  assert.equal((await call(s, "GET", "/api/plan?date=2026-11-12")).body.exists, false);
  assert.ok(s.invalidated >= 3);
});
test("PUT with empty exercises clears the plan", async () => {
  const s = memStore();
  await call(s, "PUT", "/api/plan", { date: "2026-11-12", dayType: "Back", exercises: ex(E1) });
  const r = await call(s, "PUT", "/api/plan", { date: "2026-11-12", exercises: [] });
  assert.equal(r.body.exists, false); assert.equal(r.body.applied.trashed, 1);
});
test("/api/plan errors: bad json, bad date, unknown exercise, bad method", async () => {
  const s = memStore();
  const raw = await handlePlan(new Request("http://x/api/plan", { method: "PUT", body: "{nope" }), new URL("http://x/api/plan"), s);
  assert.equal(raw.status, 400);
  assert.equal((await call(s, "GET", "/api/plan?date=tomorrow")).status, 400);
  assert.equal((await call(s, "GET", "/api/plan")).status, 400);
  const unk = await call(s, "PUT", "/api/plan", { date: "2026-11-12", dayType: "Back", exercises: ex(id(999)) });
  assert.equal(unk.status, 400); assert.match(unk.body.error, /Unknown exerciseId/);
  assert.equal(s.rows.length, 0);
  assert.equal((await call(s, "POST", "/api/plan?date=2026-11-12")).status, 405);
});
test("store failures surface as errors with their status", async () => {
  const s = memStore(); s.create = async () => { throw Object.assign(new Error("Notion 500"), { status: 502 }); };
  const r = await call(s, "PUT", "/api/plan", { date: "2026-11-12", dayType: "Back", exercises: ex(E1) });
  assert.equal(r.status, 502); assert.equal(s.invalidated, 1);
});

// ---- bootstrap integration ----
const tplRow = (n, dayType, name, exerciseId, order, notes = "", targetSets = 3) => ({ id: id(n), name, dayType, exerciseId, order, targetSets, targetReps: "", notes });
const rows = [
  tplRow(10, "Back", "Back - Lat", E1, 1),
  tplRow(11, "Planned", planRowName("2026-11-12", "Hammer Curl"), E2, 2, planNotes("2026-11-12", "Back")),
  tplRow(12, "Planned", planRowName("2026-11-12", "Lat Pulldown"), E1, 1, planNotes("2026-11-12", "Back")),
  tplRow(13, "Planned", planRowName("2026-11-01", "Bench"), E3, 1, planNotes("2026-11-01", "Chest")),
];
test("buildBootstrap: plans are separate from templates, sorted, old ones pruned", () => {
  const b = buildBootstrap({ exercises: LIB, sessions: [], sets: [], dayTypes: DAY_TYPES, dayTemplates: rows, planMinDate: "2026-11-10" });
  assert.deepEqual(Object.keys(b.templates), ["Back"]);
  assert.deepEqual(Object.keys(b.plans), ["2026-11-12"]);
  assert.deepEqual(b.plans["2026-11-12"].exercises.map((e) => e.name), ["Lat Pulldown", "Hammer Curl"]);
  assert.equal(b.plans["2026-11-12"].dayType, "Back");
  assert.equal(b.plans["2026-11-12"].exercises[0].sets.length, 3);
});
test("buildPlans without minDate keeps everything; planFor ignores empty plans", () => {
  assert.deepEqual(Object.keys(buildPlans(rows, LIB, {})).sort(), ["2026-11-01", "2026-11-12"]);
  assert.equal(P.planFor({ "2026-11-12": { exercises: [] } }, "2026-11-12"), null);
  assert.equal(P.planFor({}, "2026-11-12"), null);
  assert.ok(P.planFor({ "2026-11-12": { exercises: [{}] } }, "2026-11-12"));
});

// ---- client helpers ----
test("Plan helpers: dates, move, add, remove, body, dirty", () => {
  assert.equal(P.tomorrow("2026-11-30"), "2026-12-01"); assert.equal(P.addDays("2026-12-31", 1), "2027-01-01");
  const l = [{ exerciseId: "a" }, { exerciseId: "b" }, { exerciseId: "c" }];
  assert.deepEqual(P.move(l, 2, -1).map((x) => x.exerciseId), ["a", "c", "b"]);
  assert.deepEqual(P.move(l, 0, -1).map((x) => x.exerciseId), ["a", "b", "c"]);
  assert.deepEqual(P.move(l, 2, 1).map((x) => x.exerciseId), ["a", "b", "c"]);
  assert.deepEqual(l.map((x) => x.exerciseId), ["a", "b", "c"], "input is not mutated");
  assert.deepEqual(P.remove(l, 1).map((x) => x.exerciseId), ["a", "c"]);
  assert.equal(P.add(l, { id: "b", name: "B" }).length, 3);
  assert.equal(P.add(l, { id: "d", name: "D" })[3].name, "D");
  const body = P.toBody("2026-11-12", "Back", P.fromTemplate([{ exerciseId: E1, name: "Lat", targetSets: 3, targetReps: "8" }, { exerciseId: E2, name: "Curl" }]));
  assert.deepEqual(body, { date: "2026-11-12", dayType: "Back", exercises: [{ exerciseId: E1, targetSets: 3, targetReps: "8" }, { exerciseId: E2, targetSets: null, targetReps: "" }] });
  const saved = { dayType: "Back", exercises: [{ exerciseId: E1, name: "Lat", targetSets: 3, targetReps: "8" }] };
  assert.equal(P.dirty(saved, "Back", P.fromTemplate(saved.exercises)), false);
  assert.equal(P.dirty(saved, "Chest", P.fromTemplate(saved.exercises)), true);
  assert.equal(P.dirty(null, "Back", []), false);
  assert.equal(P.dirty(null, "Back", P.fromTemplate(saved.exercises)), true);
});

// ---- the real Worker against a fake Notion (auth, routing, Notion row format) ----
function fakeNotion() {
  const pages = []; let seq = 500;
  const plain = (arr) => arr.map((t) => ({ plain_text: t.text.content }));
  const conv = (props) => Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v.title ? { title: plain(v.title) } : v.rich_text ? { rich_text: plain(v.rich_text) } : v]));
  const lib = LIB.map((e) => ({ id: e.id, properties: { Name: { title: [{ plain_text: e.name }] } } }));
  const calls = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url), method = init.method, body = init.body ? JSON.parse(init.body) : {};
    calls.push(`${method} ${u.pathname}`);
    const ok = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (method === "GET" && u.pathname === "/v1/data_sources/SESSIONS") return ok({ properties: { "Day Type": { select: { options: DAY_TYPES.map((name) => ({ name })) } } } });
    if (method === "POST" && u.pathname === "/v1/data_sources/EXERCISES/query") return ok({ results: lib, has_more: false });
    if (method === "POST" && u.pathname.endsWith("/query")) {
      let res = u.pathname.includes("TEMPLATES") ? pages.filter((p) => !p.in_trash) : [];
      for (const f of body.filter?.and || (body.filter ? [body.filter] : [])) {
        if (f.property === "Name") res = res.filter((p) => p.properties.Name.title[0].plain_text.startsWith(f.title.starts_with));
        if (f.property === "Day Type") res = res.filter((p) => p.properties["Day Type"].select.name === f.select.equals);
      }
      return ok({ results: res, has_more: false });
    }
    if (method === "POST" && u.pathname === "/v1/pages") {
      assert.equal(body.parent.data_source_id, "TEMPLATES");
      const pg = { id: id(seq++), in_trash: false, properties: conv(body.properties) }; pages.push(pg); return ok(pg);
    }
    if (method === "PATCH" && u.pathname.startsWith("/v1/pages/")) {
      const pg = pages.find((p) => p.id === u.pathname.split("/").pop());
      if (body.in_trash) pg.in_trash = true; else Object.assign(pg.properties, conv(body.properties));
      return ok(pg);
    }
    return new Response(JSON.stringify({ message: "unexpected " + method + " " + u.pathname }), { status: 404 });
  };
  return { pages, calls, fetchFn };
}
const env = { NOTION_KEY: "k", APP_PIN: "1234", EXERCISES_DS: "EXERCISES", SESSIONS_DS: "SESSIONS", SETS_DS: "SETS", TEMPLATES_DS: "TEMPLATES", ASSETS: { fetch: async () => new Response("asset") } };
const w = (method, path, body, pin = "1234") => worker.fetch(new Request("http://x" + path, { method, headers: { "X-App-Pin": pin }, body: body ? JSON.stringify(body) : undefined }), env);

test("Worker /api/plan: PIN required, Notion rows written in the Day Templates format", async () => {
  const fake = fakeNotion(), real = globalThis.fetch; globalThis.fetch = fake.fetchFn;
  try {
    assert.equal((await w("GET", "/api/plan?date=2026-11-12", null, "wrong")).status, 401);
    assert.equal(fake.calls.length, 0, "no Notion traffic without the PIN");
    assert.equal((await w("PUT", "/api/plan", { date: "bad", exercises: [] })).status, 400);
    const put = await w("PUT", "/api/plan", { date: "2026-11-12", dayType: "Back", exercises: [{ exerciseId: E2, targetSets: 3, targetReps: "10" }, { exerciseId: E1 }] });
    assert.equal(put.status, 200);
    const body = await put.json();
    assert.deepEqual(body.exercises.map((e) => [e.name, e.targetSets, e.targetReps]), [["Hammer Curl", 3, "10"], ["Lat Pulldown", null, ""]]);
    const first = fake.pages[0].properties;
    assert.equal(first["Day Type"].select.name, "Planned");
    assert.equal(first.Name.title[0].plain_text, "Planned 2026-11-12 - Hammer Curl");
    assert.equal(first.Notes.rich_text[0].plain_text, "plan:2026-11-12\nbase:Back");
    assert.equal(first.Order.number, 1);
    const got = await (await w("GET", "/api/plan?date=2026-11-12")).json();
    assert.equal(got.exists, true); assert.equal(got.exercises.length, 2);
    const boot = await w("GET", "/api/bootstrap");
    assert.equal(boot.status, 200);
    assert.ok("plans" in (await boot.json()), "bootstrap carries plans");
    const del = await (await w("DELETE", "/api/plan?date=2026-11-12")).json();
    assert.equal(del.rowCount, 2);
    assert.ok(fake.pages.every((p) => p.in_trash));
  } finally { globalThis.fetch = real; }
});
