// Pure Plan-tab helpers (no DOM, no dependencies). Plain <script> in the browser (global `Plan`),
// importable in Node tests (also sets globalThis.Plan).
(function (root) {
  /** Add n days to "YYYY-MM-DD" (UTC calendar math, so the phone's timezone never shifts the day). */
  function addDays(iso, n) {
    const [y, m, d] = String(iso).split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  const tomorrow = (today) => addDays(today, 1);

  /** Move item i by dir (-1 up, +1 down) in a copy of the list; out-of-range moves return the list unchanged. */
  function move(list, i, dir) {
    const j = i + dir;
    if (i < 0 || i >= list.length || j < 0 || j >= list.length) return list.slice();
    const out = list.slice();
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  }

  /** Editor rows from a template (boot.templates[type]) or an existing plan's exercises. */
  const fromTemplate = (tpl) => (tpl || []).map((t) => ({ exerciseId: t.exerciseId, name: t.name, targetSets: t.targetSets ?? null, targetReps: t.targetReps || "" }));

  /** Add an exercise unless it is already in the list. */
  function add(list, ex) {
    if (list.some((e) => e.exerciseId === ex.id)) return list.slice();
    return [...list, { exerciseId: ex.id, name: ex.name, targetSets: null, targetReps: "" }];
  }
  const remove = (list, i) => list.filter((_, k) => k !== i);

  /** Body for PUT /api/plan. */
  const toBody = (date, dayType, list) => ({ date, dayType, exercises: list.map((e) => ({ exerciseId: e.exerciseId, targetSets: e.targetSets ?? null, targetReps: e.targetReps || "" })) });

  /** Did the editor change compared with the saved copy ({dayType, exercises})? */
  function dirty(saved, dayType, list) {
    const a = JSON.stringify(toBody("", dayType, list));
    const b = JSON.stringify(toBody("", saved ? saved.dayType : dayType, saved ? fromTemplate(saved.exercises) : []));
    return a !== b;
  }

  /** The plan to offer on the Log tab for `date` from bootstrap.plans, or null. */
  const planFor = (plans, date) => (plans && plans[date] && plans[date].exercises.length ? plans[date] : null);

  root.Plan = { addDays, tomorrow, move, fromTemplate, add, remove, toBody, dirty, planFor };
})(globalThis);
