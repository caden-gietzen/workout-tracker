import test from "node:test";
import assert from "node:assert/strict";
import "../public/history.js";
import {
  splitNotes, mergeNotes, notesToRichText, buildSessionList, buildSessionDetail, groupSessionSets,
  validateSessionPatch, diffSession, parseSession, parseSet, LIMITS,
} from "../src/logic.js";

const H = globalThis.Hist;
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const E1 = id(101), E2 = id(102), E3 = id(103);
const exercises = [{ id: E1, name: "Lat Pulldown" }, { id: E2, name: "Hammer Curl" }, { id: E3, name: "Bench Press" }];
const nameOf = new Map(exercises.map((e) => [e.id, e.name]));
const compact = (x) => x.replace(/-/g, "");
const S = (n, sessionId, exerciseId, setNo, weight, reps, created, extra = {}) => ({
  id: id(n), sessionId, exerciseId, n: setNo, weight, reps, created, eachSide: false, notes: "",
  name: `${nameOf.get(exerciseId)} ${setNo}`, ...extra,
});
const SES = (sid, date, dayType, notes = "", created = "2025-01-01T00:00", order = null) => ({ id: sid, name: `${dayType} - x`, date, dayType, notes, created, order });

// ---- notes markers ----
test("splitNotes separates human text from clientId/order markers", () => {
  const p = splitNotes("Felt strong\nsecond line\nclientId:abc-123\norder:aa11,bb22");
  assert.equal(p.human, "Felt strong\nsecond line");
  assert.equal(p.clientLine, "clientId:abc-123");
  assert.deepEqual(p.orderIds, ["aa11", "bb22"]);
  assert.deepEqual(splitNotes(""), { human: "", clientLine: null, orderIds: null });
  assert.equal(splitNotes("just text").human, "just text");
});
test("notes split/merge round trip keeps markers byte for byte", () => {
  for (const raw of ["TEST\nclientId:c-1234\norder:aa,bb", "clientId:c-1234\norder:aa", "hello", "", "a\nb\nclientId:zzzzzz"]) {
    const p = splitNotes(raw);
    assert.equal(mergeNotes(p.human, p.clientLine, p.orderIds), raw);
  }
  assert.equal(mergeNotes("new", "clientId:k-123456", ["x1", "y2"]), "new\nclientId:k-123456\norder:x1,y2");
  assert.equal(mergeNotes("", null, null), "");
});
test("notesToRichText chunks below the 2000 char Notion limit", () => {
  const rt = notesToRichText("a".repeat(4000));
  assert.equal(rt.length, 3);
  assert.ok(rt.every((r) => r.text.content.length < 2000));
  assert.equal(rt.map((r) => r.text.content).join("").length, 4000);
});

// ---- list / detail ----
test("buildSessionList: newest first, counts, exercise names in order, volume", () => {
  const sessions = [SES("s1", "2025-11-03", "Back"), SES("s2", "2025-11-09", "Chest", "", "2025-11-09T10:00"), SES("s3", "2025-11-09", "Arms", "", "2025-11-09T18:00"), SES("s4", "", "Odd")];
  const sets = [
    S(1, "s1", E1, 1, 100, 10, "t1"), S(2, "s1", E1, 2, 100, 8, "t2"),
    S(3, "s2", E3, 1, 50, 10, "t3"), S(4, "s2", E2, 1, 20, 10, "t4"),
  ];
  const l = buildSessionList(sessions, sets, exercises);
  assert.deepEqual(l.map((x) => x.id), ["s3", "s2", "s1", "s4"]); // same day: later created first; undated last
  assert.deepEqual(l[1].exercises, ["Bench Press", "Hammer Curl"]);
  assert.equal(l[1].setCount, 2); assert.equal(l[1].volume, 700);
  assert.equal(l[2].volume, 1800); assert.equal(l[0].setCount, 0);
  assert.ok(!("_c" in l[0]));
});
test("detail groups by order marker, falls back to first appearance, sorts by Set #", () => {
  const sets = [S(1, "s", E1, 2, 105, 8, "t1"), S(2, "s", E2, 1, 30, 10, "t2"), S(3, "s", E1, 1, 100, 10, "t3")];
  const noMarker = buildSessionDetail(parseSession2(SES("s", "2025-11-09", "Back", "hi")), sets, exercises);
  assert.deepEqual(noMarker.exercises.map((e) => e.name), ["Lat Pulldown", "Hammer Curl"]);
  assert.deepEqual(noMarker.exercises[0].sets.map((s) => s.n), [1, 2]);
  assert.equal(noMarker.notes, "hi");
  const withMarker = buildSessionDetail({ ...SES("s", "2025-11-09", "Back", `x\nclientId:abcdef\norder:${compact(E2)},${compact(E1)}`), order: [compact(E2), compact(E1)] }, sets, exercises);
  assert.deepEqual(withMarker.exercises.map((e) => e.name), ["Hammer Curl", "Lat Pulldown"]);
  assert.equal(withMarker.notes, "x"); // markers hidden
  assert.deepEqual(groupSessionSets({ order: [compact(E2)] }, sets).map((g) => g.exerciseId), [E2, E1]);
});
function parseSession2(s) { return s; }

// ---- validation ----
const okSet = (o = {}) => ({ weight: 100, reps: 10, eachSide: false, ...o });
const body = (o = {}) => ({ date: "2025-11-09", dayType: "Back", exercises: [{ exerciseId: E1, sets: [okSet()] }], ...o });
test("validateSessionPatch accepts a good body and normalizes", () => {
  const r = validateSessionPatch(body({ notes: "x" }), ["Back"]);
  assert.ok(r.ok); assert.equal(r.value.exercises[0].sets[0].weight, 100);
});
test("validateSessionPatch limits and clear errors", () => {
  const bad = (b, re, dt = ["Back"]) => { const r = validateSessionPatch(b, dt); assert.equal(r.ok, false); assert.match(r.error, re); };
  bad(null, /JSON object/);
  bad(body({ date: "11/09/2025" }), /date/);
  bad(body({ dayType: "Nope" }), /Unknown dayType/);
  bad(body({ notes: "x".repeat(LIMITS.maxNotes + 1) }), /notes/);
  bad(body({ exercises: "x" }), /array/);
  bad(body({ exercises: [{ exerciseId: E1, sets: [okSet({ weight: 2001 })] }] }), /weight/);
  bad(body({ exercises: [{ exerciseId: E1, sets: [okSet({ weight: -1 })] }] }), /weight/);
  bad(body({ exercises: [{ exerciseId: E1, sets: [okSet({ reps: 501 })] }] }), /reps/);
  bad(body({ exercises: [{ exerciseId: E1, sets: [okSet({ reps: "abc" })] }] }), /reps/);
  bad(body({ exercises: [{ exerciseId: E1, sets: Array.from({ length: 31 }, () => okSet()) }] }), /max 30 sets/);
  bad(body({ exercises: Array.from({ length: 41 }, (_, i) => ({ exerciseId: id(500 + i), sets: [okSet()] })) }), /Max 40/);
  bad(body({ exercises: [{ exerciseId: "nope", sets: [okSet()] }] }), /exerciseId/);
  bad(body({ exercises: [{ exerciseId: E1, sets: [okSet({ id: "bad" })] }] }), /id invalid/);
  bad(body({ exercises: [{ exerciseId: E1, sets: [okSet({ id: id(1) }), okSet({ id: id(1) })] }] }), /twice/);
  bad(body({ exercises: [{ exerciseId: E1, sets: [okSet()] }, { exerciseId: E1, sets: [okSet()] }] }), /twice/);
  bad(body({ exercises: [{ exerciseId: E1, sets: [okSet({ eachSide: "yes" })] }] }), /eachSide/);
  bad(body({ exercises: [{ exerciseId: E1, sets: [{ weight: null, reps: null }] }] }), /at least one set/);
  assert.ok(validateSessionPatch(body({ exercises: [{ exerciseId: E1, sets: Array.from({ length: 30 }, () => okSet()) }] }), ["Back"]).ok);
  assert.ok(validateSessionPatch(body({ exercises: [{ newExercise: { name: " Dips " }, sets: [okSet()] }] }), ["Back"]).value.exercises[0].newExercise.name === "Dips");
});
test("validate drops new empty sets and empty exercises but keeps existing sets", () => {
  const r = validateSessionPatch(body({ exercises: [
    { exerciseId: E1, sets: [okSet(), { weight: null, reps: null }, { id: id(9), weight: null, reps: null }] },
    { exerciseId: E2, sets: [] },
  ] }), ["Back"]);
  assert.equal(r.value.exercises.length, 1);
  assert.equal(r.value.exercises[0].sets.length, 2);
});

// ---- diff ----
const rawNotes = `TEST note\nclientId:cid-123456\norder:${compact(E1)},${compact(E2)}`;
function fixture() {
  const session = { ...SES("s", "2025-11-09", "Back", rawNotes), name: "Back - Nov 9", order: [compact(E1), compact(E2)] };
  const sets = [
    S(1, "s", E1, 1, 100, 10, "t1"), S(2, "s", E1, 2, 100, 8, "t2"), S(3, "s", E1, 3, 90, 8, "t3"),
    S(4, "s", E2, 1, 30, 10, "t4"),
  ];
  return { session, sets };
}
const desiredFrom = (cur, edit) => {
  const d = { exercises: [{ exerciseId: E1, sets: cur.sets.filter((s) => s.exerciseId === E1).map((s) => ({ id: s.id, weight: s.weight, reps: s.reps, eachSide: s.eachSide })) },
    { exerciseId: E2, sets: [{ id: id(4), weight: 30, reps: 10, eachSide: false }] }] };
  return edit ? edit(d) || d : d;
};
test("diff: identical state makes zero writes", () => {
  const cur = fixture();
  const d = diffSession(cur, { ...desiredFrom(cur), date: "2025-11-09", dayType: "Back", notes: "TEST note" }, nameOf);
  assert.ok(d.ok);
  assert.deepEqual([d.session, d.updates, d.creates, d.trashes], [null, [], [], []]);
});
test("diff: edits only the changed set", () => {
  const cur = fixture();
  const d = diffSession(cur, desiredFrom(cur, (x) => { x.exercises[0].sets[1].weight = 105; }), nameOf);
  assert.deepEqual(d.updates, [{ id: id(2), changes: { weight: 105 } }]);
  assert.equal(d.creates.length, 0); assert.equal(d.trashes.length, 0); assert.equal(d.session, null);
});
test("diff: remove a middle set renumbers the following ones and refreshes names", () => {
  const cur = fixture();
  const d = diffSession(cur, desiredFrom(cur, (x) => { x.exercises[0].sets.splice(0, 1); }), nameOf);
  assert.deepEqual(d.trashes, [id(1)]);
  assert.deepEqual(d.updates, [
    { id: id(2), changes: { n: 1, name: "Lat Pulldown 1" } },
    { id: id(3), changes: { n: 2, name: "Lat Pulldown 2" } },
  ]);
});
test("diff: new set (no id) is created with n, name and values; new exercise appended updates the order marker", () => {
  const cur = fixture();
  const d = diffSession(cur, desiredFrom(cur, (x) => {
    x.exercises[0].sets.push({ weight: 85, reps: 12, eachSide: true });
    x.exercises.push({ exerciseId: E3, sets: [{ weight: 135, reps: 5, eachSide: false }] });
  }), nameOf);
  assert.deepEqual(d.creates, [
    { exerciseId: E1, n: 4, name: "Lat Pulldown 4", weight: 85, reps: 12, eachSide: true, notes: "" },
    { exerciseId: E3, n: 1, name: "Bench Press 1", weight: 135, reps: 5, eachSide: false, notes: "" },
  ]);
  assert.equal(d.session.notes, `TEST note\nclientId:cid-123456\norder:${compact(E1)},${compact(E2)},${compact(E3)}`);
});
test("diff: removing an exercise trashes its sets and rewrites order; reordering rewrites order only", () => {
  const cur = fixture();
  const rm = diffSession(cur, { exercises: [desiredFrom(cur).exercises[0]] }, nameOf);
  assert.deepEqual(rm.trashes, [id(4)]);
  assert.equal(rm.session.notes, `TEST note\nclientId:cid-123456\norder:${compact(E1)}`);
  const re = diffSession(cur, { exercises: desiredFrom(cur).exercises.reverse() }, nameOf);
  assert.deepEqual([re.updates, re.creates, re.trashes], [[], [], []]);
  assert.equal(re.session.notes, `TEST note\nclientId:cid-123456\norder:${compact(E2)},${compact(E1)}`);
});
test("diff: date/day type change refreshes the session name; notes edits keep markers", () => {
  const cur = fixture();
  const d = diffSession(cur, { ...desiredFrom(cur), date: "2025-11-10", dayType: "Legs", notes: "edited\nclientId:evil-999" }, nameOf);
  assert.deepEqual({ ...d.session, notes: undefined }, { date: "2025-11-10", dayType: "Legs", name: "Legs - Nov 10", notes: undefined });
  assert.equal(d.session.notes, `edited\nclientId:cid-123456\norder:${compact(E1)},${compact(E2)}`); // typed marker line stripped, real one kept
  const only = diffSession(cur, { ...desiredFrom(cur), notes: "" }, nameOf);
  assert.equal(only.session.notes, `clientId:cid-123456\norder:${compact(E1)},${compact(E2)}`);
  assert.equal(Object.keys(only.session).join(), "notes");
});
test("diff: old session without markers stays marker-free unless the order changes", () => {
  const cur = fixture(); cur.session = { ...cur.session, notes: "plain", order: null };
  const d = diffSession(cur, { ...desiredFrom(cur), notes: "plain2" }, nameOf);
  assert.equal(d.session.notes, "plain2");
});
test("diff: unknown set id is an error", () => {
  const cur = fixture();
  const r = diffSession(cur, { exercises: [{ exerciseId: E1, sets: [{ id: id(99), weight: 1, reps: 1, eachSide: false }] }] }, nameOf);
  assert.equal(r.ok, false); assert.match(r.error, /Unknown set id/);
});
test("diff retry converges: a re-sent body adopts sets created by the failed first attempt", () => {
  const cur = fixture();
  const edit = (x) => { x.exercises[0].sets.push({ weight: 85, reps: 12, eachSide: false }); x.exercises[0].sets.splice(0, 1); };
  const first = diffSession(cur, desiredFrom(cur, edit), nameOf);
  // simulate: attempt 1 created the new set and renumbered some rows, then died before trashing
  const after = { ...cur, sets: [...cur.sets, S(50, "s", E1, 4, 85, 12, "t9")] };
  const retry = diffSession(after, desiredFrom(cur, edit), nameOf);
  assert.equal(first.creates.length, 1);
  assert.equal(retry.creates.length, 0);   // adopted, not duplicated
  assert.deepEqual(retry.trashes, [id(1)]);
  assert.deepEqual(retry.updates.find((u) => u.id === id(50)).changes, { n: 3, name: "Lat Pulldown 3" });
});
test("diff: moving a set id to another exercise updates its relation", () => {
  const cur = fixture();
  const d = diffSession(cur, { exercises: [{ exerciseId: E2, sets: [{ id: id(4), weight: 30, reps: 10, eachSide: false }, { id: id(3), weight: 90, reps: 8, eachSide: false }] }, { exerciseId: E1, sets: [{ id: id(1), weight: 100, reps: 10, eachSide: false }] }] }, nameOf);
  const moved = d.updates.find((u) => u.id === id(3));
  assert.deepEqual(moved.changes, { exerciseId: E2, n: 2, name: "Hammer Curl 2" });
  assert.deepEqual(d.trashes, [id(2)]);
});

// ---- browser helpers ----
test("Hist labels and month grouping", () => {
  assert.equal(H.dateLabel("2025-11-09"), "Sun Nov 9");
  assert.equal(H.monthLabel("2025-11-09"), "November 2025");
  const g = H.groupByMonth([{ date: "2025-11-09" }, { date: "2025-11-01" }, { date: "2025-10-30" }]);
  assert.deepEqual(g.map((x) => [x.label, x.items.length]), [["November 2025", 2], ["October 2025", 1]]);
  assert.equal(H.exerciseSummary(["a", "b", "c", "d", "e"]), "a, b, c +2");
});
test("Hist.filterList by day type and text", () => {
  const l = [{ dayType: "Back", name: "n", date: "2025-11-09", exercises: ["Lat Pulldown"] }, { dayType: "Chest", name: "n", date: "2025-11-08", exercises: ["Bench Press"] }];
  assert.equal(H.filterList(l, "", "Back").length, 1);
  assert.equal(H.filterList(l, "bench", null).length, 1);
  assert.equal(H.filterList(l, "", null).length, 2);
});
test("Hist.countChanges counts edits and ignores blank new sets", () => {
  const orig = { date: "2025-11-09", dayType: "Back", notes: "n", exercises: [{ exerciseId: E1, sets: [{ id: id(1), weight: 100, reps: 10, eachSide: false, notes: "" }, { id: id(2), weight: 100, reps: 8, eachSide: false, notes: "" }] }, { exerciseId: E2, sets: [{ id: id(4), weight: 30, reps: 10, eachSide: false, notes: "" }] }] };
  const clone = () => JSON.parse(JSON.stringify(orig));
  assert.equal(H.countChanges(orig, clone()), 0);
  let c = clone(); c.exercises[0].sets[0].weight = 105; c.date = "2025-11-10"; assert.equal(H.countChanges(orig, c), 2);
  c = clone(); c.exercises[0].sets.push({ weight: null, reps: null, eachSide: false }); assert.equal(H.countChanges(orig, c), 0);
  c = clone(); c.exercises[0].sets.push({ weight: 1, reps: 1, eachSide: false }); assert.equal(H.countChanges(orig, c), 1);
  c = clone(); c.exercises.splice(1, 1); assert.equal(H.countChanges(orig, c), 1);
  c = clone(); c.exercises.reverse(); assert.equal(H.countChanges(orig, c), 1);
  c = clone(); c.exercises[0].sets[0].weight = 105; c.exercises[0].sets[0].weight = 100; assert.equal(H.countChanges(orig, c), 0);
});
test("Hist.toPatchBody keeps ids, drops blank new sets", () => {
  const b = H.toPatchBody({ date: "d", dayType: "t", notes: "n", exercises: [{ exerciseId: E1, sets: [{ id: id(1), weight: 1, reps: 2, eachSide: true, notes: "x" }, { weight: null, reps: null }, { weight: 5, reps: 5 }] }] });
  assert.deepEqual(b.exercises[0].sets, [{ id: id(1), weight: 1, reps: 2, eachSide: true, notes: "x" }, { weight: 5, reps: 5, eachSide: false, notes: "" }]);
  assert.ok(H.summaryFromDetail({ id: "i", date: "d", dayType: "t", name: "n", exercises: [{ name: "A", sets: [{ weight: 10, reps: 3 }] }] }).volume === 30);
});
