// Pure History-tab helpers (no DOM, no dependencies). Plain <script> in the browser (global `Hist`),
// importable in Node tests (also sets globalThis.Hist).
(function (root) {
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const parts = (iso) => String(iso || "").split("-").map(Number);

  /** "2025-11-09" -> "Sun Nov 9" (calendar math in UTC, so the phone's timezone never shifts the day). */
  function dateLabel(iso) {
    const [y, m, d] = parts(iso);
    if (!y || !m || !d) return iso || "No date";
    return `${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${MON[m - 1]} ${d}`;
  }
  /** "2025-11-09" -> "November 2025" */
  function monthLabel(iso) {
    const [y, m] = parts(iso);
    return y && m ? `${MONTH[m - 1]} ${y}` : "No date";
  }
  /** Sessions (already newest first) -> [{label, items}] keeping order. */
  function groupByMonth(list) {
    const out = [];
    for (const it of list) {
      const label = monthLabel(it.date);
      if (!out.length || out[out.length - 1].label !== label) out.push({ label, items: [] });
      out[out.length - 1].items.push(it);
    }
    return out;
  }
  /** Filter by day type chip (null = all) and free text (day type, name, exercise names, date label). */
  function filterList(list, q, dayType) {
    const t = String(q || "").trim().toLowerCase();
    return list.filter((s) => (!dayType || s.dayType === dayType)
      && (!t || [s.dayType, s.name, dateLabel(s.date), ...s.exercises].join(" ").toLowerCase().includes(t)));
  }
  /** "Lat Pulldown, Row, Curl +2" */
  function exerciseSummary(names, max = 3) {
    if (names.length <= max) return names.join(", ");
    return `${names.slice(0, max).join(", ")} +${names.length - max}`;
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  const blank = (s) => s.weight == null && s.reps == null;
  const exKey = (e) => e.exerciseId || "new:" + (e.newExercise ? e.newExercise.name.toLowerCase() : "");
  const same = (a, b) => (a.weight ?? null) === (b.weight ?? null) && (a.reps ?? null) === (b.reps ?? null)
    && !!a.eachSide === !!b.eachSide && (a.notes || "") === (b.notes || "");

  /**
   * Number of edits between the loaded session (orig) and the edited copy (cur):
   * date, day type, notes, each changed/added/removed set, and a changed exercise order. 0 = nothing to save.
   * New sets that are still blank do not count (the server ignores them).
   */
  function countChanges(orig, cur) {
    let n = 0;
    if (cur.date !== orig.date) n++;
    if (cur.dayType !== orig.dayType) n++;
    if ((cur.notes || "").trim() !== (orig.notes || "").trim()) n++;
    const origSets = new Map();
    for (const e of orig.exercises) for (const s of e.sets) origSets.set(s.id, { s, ex: e.exerciseId });
    const keep = new Set();
    for (const e of cur.exercises) {
      for (const s of e.sets) {
        if (s.id && origSets.has(s.id)) {
          keep.add(s.id);
          const o = origSets.get(s.id);
          if (!same(o.s, s) || o.ex !== e.exerciseId) n++;
        } else if (!blank(s)) n++;
      }
    }
    for (const id of origSets.keys()) if (!keep.has(id)) n++;
    const kept = (e) => e.sets.some((s) => !blank(s) || s.id);
    const before = orig.exercises.map(exKey), after = cur.exercises.filter(kept).map(exKey);
    const common = after.filter((k) => before.includes(k));
    if (common.join() !== before.filter((k) => after.includes(k)).join()) n++;
    return n;
  }
  /** PATCH /api/session body from the edited copy. */
  function toPatchBody(cur) {
    return {
      date: cur.date, dayType: cur.dayType, notes: cur.notes,
      exercises: cur.exercises.map((e) => ({
        ...(e.exerciseId ? { exerciseId: e.exerciseId } : { newExercise: e.newExercise }),
        sets: e.sets.filter((s) => s.id || !blank(s)).map((s) => ({ ...(s.id ? { id: s.id } : {}), weight: s.weight, reps: s.reps, eachSide: !!s.eachSide, notes: s.notes || "" })),
      })),
    };
  }
  /** List row from a session detail (to update the cached list right after a save). */
  function summaryFromDetail(d) {
    let setCount = 0, volume = 0;
    for (const e of d.exercises) for (const s of e.sets) { setCount++; volume += (s.weight || 0) * (s.reps || 0); }
    return { id: d.id, date: d.date, dayType: d.dayType, name: d.name, setCount, exercises: d.exercises.map((e) => e.name), volume: Math.round(volume) };
  }
  function sortList(list) {
    return list.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  root.Hist = { dateLabel, monthLabel, groupByMonth, filterList, exerciseSummary, plural, countChanges, toPatchBody, summaryFromDetail, sortList };
})(globalThis);
