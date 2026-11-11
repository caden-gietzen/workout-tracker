import test from "node:test";
import assert from "node:assert/strict";
import "../public/charts.js";
import { buildBootstrap, buildHistory } from "../src/logic.js";

const C = globalThis.Charts;
const H = (date, sets, sessionId = date) => ({ date, sessionId, sets: sets.map(([weight, reps, eachSide = false]) => ({ weight, reps, eachSide })) });

test("buildSeries orders by date and picks the top set per session", () => {
  const s = C.buildSeries([H("2025-11-09", [[350, 8], [350, 8]]), H("2025-08-04", [[300, 10], [360, 8], [360, 6]])]);
  assert.deepEqual(s.map((p) => p.date), ["2025-08-04", "2025-11-09"]);
  assert.equal(s[0].weight, 360); assert.equal(s[0].reps, 8); // tie on weight -> more reps
  assert.equal(s[0].sets, 3);
});
test("est 1RM = round(w*(1+r/30))", () => {
  assert.equal(C.estOneRM(100, 3), 110);
  assert.equal(C.estOneRM(null, 5), 0);
});
test("est 1RM best set wins", () => {
  const s = C.buildSeries([H("2025-01-01", [[200, 1], [150, 10]])]);
  assert.equal(s[0].est1RM, 207);
});
test("volume is weight*reps and ignores Each Side", () => {
  const s = C.buildSeries([H("2025-01-01", [[50, 10, true], [50, 10, false]])]);
  assert.equal(s[0].volume, 1000);
});
test("PR detection: strictly higher weights, newest first", () => {
  const s = C.buildSeries([H("2025-01-01", [[100, 5]]), H("2025-01-08", [[100, 8]]), H("2025-01-15", [[110, 3]]), H("2025-01-22", [[105, 5]]), H("2025-02-01", [[120, 1]])]);
  const prs = C.detectPRs(s, "weight");
  assert.deepEqual(prs.map((p) => [p.date, p.value, p.gain]), [["2025-02-01", 120, 10], ["2025-01-15", 110, 10], ["2025-01-01", 100, null]]);
});
test("range filtering", () => {
  const s = C.buildSeries([H("2024-10-01", [[1, 1]]), H("2025-06-01", [[1, 1]]), H("2025-09-15", [[1, 1]]), H("2025-11-01", [[1, 1]])]);
  assert.equal(C.filterRange(s, "all", "2025-11-09").length, 4);
  assert.deepEqual(C.filterRange(s, "3m", "2025-11-09").map((p) => p.date), ["2025-09-15", "2025-11-01"]);
  assert.deepEqual(C.filterRange(s, "6m", "2025-11-09").map((p) => p.date), ["2025-06-01", "2025-09-15", "2025-11-01"]);
  assert.deepEqual(C.filterRange(s, "1y", "2025-11-09").map((p) => p.date), ["2025-06-01", "2025-09-15", "2025-11-01"]);
});
test("bodyweight exercises use reps", () => {
  const s = C.buildSeries([H("2025-01-01", [[null, 8], [null, 6]]), H("2025-01-08", [[null, 10]])]);
  assert.ok(C.isBodyweight(s));
  assert.deepEqual(C.metric(s, "bestReps").map((p) => p.v), [8, 10]);
  assert.deepEqual(C.metric(s, "weight"), []);
  assert.deepEqual(C.detectPRs(s, "bestReps").map((p) => p.value), [10, 8]);
  assert.equal(C.summarize(s).bestReps, 10);
});
test("0, 1 and many points", () => {
  assert.deepEqual(C.buildSeries([]), []);
  assert.deepEqual(C.buildSeries([H("2025-01-01", [[null, null]])]), []); // empty sets ignored
  const one = C.buildSeries([H("2025-01-01", [[100, 5]])]);
  assert.equal(C.trend(C.metric(one, "weight")), null);
  assert.equal(C.summarize(one).sessions, 1);
  const { svg } = C.chartSvg(C.metric(one, "weight"), {}); // must not throw
  assert.match(svg, /<svg/);
  const many = C.buildSeries([H("2025-01-01", [[100, 5]]), H("2025-01-08", [[105, 5]]), H("2025-01-15", [[102.5, 5]])]);
  const t = C.trend(C.metric(many, "weight"));
  assert.equal(t.sinceFirst, 2.5); assert.equal(t.sinceFirstDir, "up");
  assert.equal(t.vsPrev, -2.5); assert.equal(t.vsPrevDir, "down");
});
test("flat series: no NaN, ticks span a nonzero range", () => {
  const s = C.metric(C.buildSeries([H("2025-01-01", [[100, 5]]), H("2025-01-08", [[100, 5]])]), "weight");
  const { svg } = C.chartSvg(s, { kind: "line" });
  assert.ok(!/NaN|Infinity/.test(svg));
  const t = C.niceTicks(100, 100);
  assert.ok(t.max > t.min && t.ticks.includes(100) === false || t.ticks.length >= 2);
  assert.equal(C.linear(5, 5, 0, 10)(5), 5);
  assert.ok(!/NaN|Infinity/.test(C.chartSvg(s, { kind: "bar" }).svg));
  assert.ok(!/NaN|Infinity/.test(C.chartSvg([s[0]], {}).svg));
});
test("niceTicks", () => {
  assert.deepEqual(C.niceTicks(0, 100, 4).ticks, [0, 25, 50, 75, 100]);
  const t = C.niceTicks(93, 187, 4);
  assert.ok(t.min <= 93 && t.max >= 187);
  assert.ok(t.ticks.length >= 3 && t.ticks.length <= 8);
  assert.deepEqual(C.niceTicks(0, 1, 4).ticks, [0, 0.25, 0.5, 0.75, 1]);
});
test("timeTicks: months for long ranges, days for short; local dates", () => {
  const d = (s) => C.parseDate(s).getTime();
  const m = C.timeTicks(d("2025-01-10"), d("2025-11-09"));
  assert.ok(m.length >= 2 && m.length <= 5);
  assert.ok(/^[A-Z][a-z]{2}/.test(m[0].label));
  const w = C.timeTicks(d("2025-11-01"), d("2025-11-15"));
  assert.equal(w[0].label, "Nov 1");
  assert.ok(w.length >= 3);
  assert.equal(C.parseDate("2025-03-09").getDate(), 9); // no UTC shift
  assert.equal(C.fmtDate("2025-03-09"), "Mar 9");
});
test("linePath and nearest", () => {
  assert.equal(C.linePath([{ x: 1, y: 2 }, { x: 3.14159, y: 4 }]), "M1.0 2.0 L3.1 4.0");
  assert.equal(C.nearest([10, 50, 90], 60), 1);
});
test("buildHistory: all sessions for the exercise ordered by date, sets by Set #", () => {
  const sessions = [{ id: "s2", date: "2025-11-09", dayType: "Legs" }, { id: "s1", date: "2025-08-04", dayType: "Legs" }, { id: "s3", date: "2025-09-01", dayType: "Push" }];
  const S = (sessionId, exerciseId, n, weight, reps) => ({ sessionId, exerciseId, n, weight, reps, eachSide: false, created: "" });
  const sets = [S("s2", "e1", 2, 350, 8), S("s2", "e1", 1, 350, 8), S("s1", "e1", 1, 360, 8), S("s3", "e2", 1, 50, 5), S("zz", "e1", 1, 1, 1)];
  const h = buildHistory("e1", sessions, sets);
  assert.deepEqual(h.map((x) => x.date), ["2025-08-04", "2025-11-09"]);
  assert.equal(h[1].sets.length, 2); assert.equal(h[0].dayType, "Legs");
});
test("bootstrap summary covers all sessions (not just last 8)", () => {
  const exercises = [{ id: "e1", name: "A", muscle: "Back", equipment: "" }];
  const sessions = Array.from({ length: 12 }, (_, i) => ({ id: "s" + i, name: "n", date: `2025-0${1 + (i % 9)}-${10 + i}`, dayType: "X" }));
  const sets = sessions.map((s, i) => ({ id: "t" + i, sessionId: s.id, exerciseId: "e1", n: 1, weight: 100 + i, reps: 5, eachSide: false, created: "" }));
  const b = buildBootstrap({ exercises, sessions, sets, dayTypes: ["X"] });
  assert.equal(b.summary.e1.sessions, 12); assert.equal(b.summary.e1.bestWeight, 111); assert.equal(b.summary.e1.sets, 12);
  assert.equal(b.history.e1.length, 8);
});
