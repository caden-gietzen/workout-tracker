// Run: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { buildBootstrap, validateSession, sessionName, parseSet } from "../src/logic.js";

const exercises = [
  { id: "e1", name: "Lat Pulldown", muscle: "Back", equipment: "Cable" },
  { id: "e2", name: "Hammer Curl", muscle: "Biceps", equipment: "Dumbbell" },
  { id: "e3", name: "Bench Press", muscle: "Chest", equipment: "Barbell" },
];
const sessions = [
  { id: "s1", name: "old", date: "2025-10-01", dayType: "Back & Biceps" },
  { id: "s2", name: "new", date: "2025-11-03", dayType: "Back & Biceps" },
  { id: "s3", name: "chest", date: "2025-11-05", dayType: "Chest" },
];
const S = (id, sessionId, exerciseId, n, weight, reps, created, eachSide = false) => ({ id, sessionId, exerciseId, n, weight, reps, created, eachSide });
const sets = [
  S("a", "s1", "e1", 1, 100, 10, "2025-10-01T10:00"),
  S("b", "s2", "e2", 1, 30, 10, "2025-11-03T10:00", true), // hammer curl created first
  S("c", "s2", "e1", 1, 120, 8, "2025-11-03T10:05"),
  S("d", "s2", "e1", 2, 125, 8, "2025-11-03T10:06"),
  S("e", "s3", "e1", 1, 90, 12, "2025-11-05T09:00"), // lat pulldown also done on a Chest day
  S("f", "s3", "e3", 1, null, null, "2025-11-05T09:10"), // bodyweight / no numbers
];
const b = buildBootstrap({ exercises, sessions, sets, dayTypes: ["Back & Biceps", "Chest"] });

test("template = exercises of most recent session of that day type, in creation order", () => {
  assert.deepEqual(b.templates["Back & Biceps"].map((x) => x.name), ["Hammer Curl", "Lat Pulldown"]);
  assert.deepEqual(b.templates["Back & Biceps"][1].sets, [
    { weight: 120, reps: 8, eachSide: false }, { weight: 125, reps: 8, eachSide: false }]);
  assert.equal(b.templates["Back & Biceps"][0].sets[0].eachSide, true);
});
test("last = most recent session across all day types", () => {
  assert.equal(b.last.e1.date, "2025-11-05");
  assert.deepEqual(b.last.e1.sets, [{ weight: 90, reps: 12, eachSide: false }]);
});
test("history is newest-first with best weight, est 1RM and top set", () => {
  const h = b.history.e1;
  assert.deepEqual(h.map((x) => x.date), ["2025-11-05", "2025-11-03", "2025-10-01"]);
  assert.equal(h[1].bestWeight, 125);
  assert.equal(h[1].topSet, "125x8");
  assert.equal(h[1].bestEst1RM, Math.round(125 * (1 + 8 / 30)));
});
test("sets without numbers do not break anything", () => {
  assert.equal(b.history.e3[0].topSet, "");
  assert.equal(b.history.e3[0].bestWeight, 0);
});
test("lastDates and recent", () => {
  assert.equal(b.lastDates["Back & Biceps"], "2025-11-03");
  assert.equal(b.recent[0].id, "s3");
});
test("history capped at 8", () => {
  const ss = [], st = [];
  for (let i = 1; i <= 12; i++) { ss.push({ id: "x" + i, date: `2025-01-${String(i).padStart(2, "0")}`, dayType: "Chest", name: "" }); st.push(S("y" + i, "x" + i, "e3", 1, i, 5, "t")); }
  assert.equal(buildBootstrap({ exercises, sessions: ss, sets: st, dayTypes: [] }).history.e3.length, 8);
});
test("parseSet reads Notion shape", () => {
  const s = parseSet({ id: "p", created_time: "t", properties: { Session: { relation: [{ id: "s" }] }, Exercise: { relation: [{ id: "e" }] }, "Set #": { number: 2 }, "Weight (lb)": { number: 50 }, Reps: { number: null }, "Each Side": { checkbox: true } } });
  assert.deepEqual([s.sessionId, s.exerciseId, s.n, s.weight, s.reps, s.eachSide], ["s", "e", 2, 50, null, true]);
});

const ok = () => ({ dayType: "Back", date: "2025-11-09", clientId: "abc-12345", exercises: [{ exerciseId: "e1", sets: [{ weight: 100, reps: 8 }, { weight: "", reps: "" }] }] });
test("valid payload passes, empty sets dropped", () => {
  const r = validateSession(ok(), ["Back"]);
  assert.ok(r.ok); assert.equal(r.value.exercises[0].sets.length, 1);
});
test("rejections", () => {
  const bad = (mut, dt) => { const p = ok(); mut(p); return validateSession(p, dt); };
  assert.equal(bad((p) => (p.exercises[0].sets[0].weight = 2001)).ok, false);
  assert.equal(bad((p) => (p.exercises[0].sets[0].weight = -1)).ok, false);
  assert.equal(bad((p) => (p.exercises[0].sets[0].reps = 501)).ok, false);
  assert.equal(bad((p) => (p.exercises[0].sets[0].reps = NaN)).ok, false);
  assert.equal(bad((p) => (p.exercises[0].sets[0].weight = "abc")).ok, false);
  assert.equal(bad((p) => (p.date = "11/09/2025")).ok, false);
  assert.equal(bad((p) => delete p.clientId).ok, false);
  assert.equal(bad((p) => (p.dayType = "Nope"), ["Back"]).ok, false);
  assert.equal(bad((p) => (p.exercises = Array(41).fill(p.exercises[0]))).ok, false);
  assert.equal(bad((p) => (p.exercises[0].sets = Array(31).fill({ weight: 1, reps: 1 }))).ok, false);
  assert.equal(bad((p) => (p.exercises = [{ sets: [] }])).ok, false);
  assert.equal(bad((p) => (p.exercises[0].sets = [{}])).ok, false); // all empty -> nothing to save
});
test("new exercise accepted", () => {
  const p = ok(); p.exercises.push({ newExercise: { name: " ZZ Test ", muscle: "Back" }, sets: [{ weight: 5, reps: 5 }] });
  const r = validateSession(p); assert.ok(r.ok); assert.equal(r.value.exercises[1].newExercise.name, "ZZ Test");
});
test("sessionName", () => assert.equal(sessionName("Back & Biceps", "2025-11-09"), "Back & Biceps - Nov 9"));

test("explicit order line in session notes overrides tied creation times", () => {
  const ss = [{ id: "s9", name: "n", date: "2025-12-01", dayType: "Back", notes: "x\nclientId:abc\norder:e2,e1", order: ["e2", "e1"] }];
  const st = [S("p", "s9", "e1", 1, 1, 1, "same"), S("q", "s9", "e2", 1, 1, 1, "same")];
  assert.deepEqual(buildBootstrap({ exercises, sessions: ss, sets: st, dayTypes: [] }).templates.Back.map((x) => x.exerciseId), ["e2", "e1"]);
});

// ---- Day Templates ----
import { buildDayTemplates, resizeSets } from "../src/logic.js";
const R = (dayType, exerciseId, order, targetSets, targetReps, notes = "") => ({ dayType, exerciseId, order, targetSets, targetReps, notes });
test("Day Templates rows: ordered by Order, targets passed through, name from exercises", () => {
  const bb = buildBootstrap({ exercises, sessions, sets, dayTypes: ["Back & Biceps", "Chest"],
    dayTemplates: [R("Back & Biceps", "e2", 2, 2, "8-12", "note"), R("Back & Biceps", "e1", 1, 3, "8-10")] });
  assert.deepEqual(bb.templates["Back & Biceps"].map((x) => x.name), ["Lat Pulldown", "Hammer Curl"]);
  const t = bb.templates["Back & Biceps"][1];
  assert.equal(t.targetSets, 2); assert.equal(t.targetReps, "8-12"); assert.equal(t.notes, "note");
  assert.equal(bb.templates["Back & Biceps"][0].notes, "");
});
test("sets resized from most recent logged sets (any day type): repeat last / truncate", () => {
  const bb = buildBootstrap({ exercises, sessions, sets, dayTypes: [], dayTemplates: [R("X", "e1", 1, 3, "8"), R("X", "e2", 2, 1, "8")] });
  // e1 last = [90x12] (Chest day), grown to 3 by repeating
  assert.deepEqual(bb.templates.X[0].sets, Array(3).fill({ weight: 90, reps: 12, eachSide: false }));
  assert.equal(bb.templates.X[1].sets.length, 1);
  assert.deepEqual(resizeSets([{ weight: 1, reps: 2 }, { weight: 3, reps: 4 }, { weight: 5, reps: 6 }], 2).map((s) => s.weight), [1, 3]);
});
test("never-logged exercise and non-rep target get empty sets of targetSets length", () => {
  const ex = [...exercises, { id: "e9", name: "Stairmaster", muscle: "Cardio", equipment: "" }];
  const t = buildDayTemplates([R("X", "e9", 1, 2, "15 min")], ex, {}).X[0];
  assert.deepEqual(t.sets, [{ weight: null, reps: null, eachSide: false }, { weight: null, reps: null, eachSide: false }]);
  assert.equal(t.targetReps, "15 min");
});
test("day type without Day Templates rows falls back to last-session template", () => {
  const bb = buildBootstrap({ exercises, sessions, sets, dayTypes: ["Back & Biceps", "Chest"], dayTemplates: [R("Back & Biceps", "e1", 1, 3, "8-10")] });
  assert.equal(bb.templates["Back & Biceps"].length, 1);
  assert.deepEqual(bb.templates.Chest.map((x) => x.name), ["Lat Pulldown", "Bench Press"]);
  assert.equal(bb.templates.Chest[0].targetSets, undefined);
});

// ---- Data source configuration ----
import { resolveDataSources } from "../src/logic.js";
test("resolveDataSources: placeholders and empty values are rejected, naming the variables", () => {
  const r = resolveDataSources({ EXERCISES_DS: "a", SESSIONS_DS: "PASTE_ID_HERE", SETS_DS: "", TEMPLATES_DS: undefined });
  assert.equal(r.ok, false);
  assert.match(r.error, /SESSIONS_DS, SETS_DS, TEMPLATES_DS/);
  assert.doesNotMatch(r.error, /EXERCISES_DS/);
  assert.equal(resolveDataSources({}).ok, false);
});
test("resolveDataSources: valid ids map to keys", () => {
  const r = resolveDataSources({ EXERCISES_DS: " e ", SESSIONS_DS: "s", SETS_DS: "t", TEMPLATES_DS: "d" });
  assert.deepEqual(r, { ok: true, ds: { exercises: "e", sessions: "s", sets: "t", dayTemplates: "d" } });
});
