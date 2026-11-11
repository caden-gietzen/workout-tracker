// Plan tab backend: validation, diffing and the /api/plan routes, written against a small storage interface
// so tests can use an in-memory store and the Worker uses Notion (Day Templates rows, see logic.js).
//
// store = {
//   dayTypes(): Promise<string[]>                       day types a plan may be logged as
//   exercises(): Promise<{id,name}[]>                   the exercise library
//   listRows(date): Promise<row[]>                      parsed Day Templates rows of that plan (id, exerciseId, order, targetSets, targetReps, notes)
//   create(date, base, row) / update(id, date, base, row) / trash(id)
//   invalidate(): void                                  drop caches after writes
// }
import { planRowBase, isNotionId } from "./logic.js";

export const PLAN_LIMITS = { maxExercises: 40, maxTargetSets: 30, maxTargetReps: 40 };
const norm = (id) => String(id || "").replace(/-/g, "").toLowerCase();
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
export const validDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d)) && new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d;

/** Validate a PUT /api/plan body. Empty `exercises` is allowed and means "no plan" (the rows are removed). */
export function validatePlan(b, dayTypes = null) {
  const bad = (error) => ({ ok: false, error });
  if (!b || typeof b !== "object") return bad("Body must be a JSON object");
  if (!validDate(b.date)) return bad("date must be YYYY-MM-DD");
  if (!Array.isArray(b.exercises)) return bad("exercises must be an array");
  if (b.exercises.length > PLAN_LIMITS.maxExercises) return bad(`Max ${PLAN_LIMITS.maxExercises} exercises`);
  if (b.exercises.length && (typeof b.dayType !== "string" || !b.dayType)) return bad("dayType required");
  if (b.dayType != null && b.exercises.length && dayTypes && !dayTypes.includes(b.dayType)) return bad(`Unknown dayType: ${b.dayType}`);
  const seen = new Set(), exercises = [];
  for (const [i, ex] of b.exercises.entries()) {
    if (!ex || typeof ex !== "object" || !isNotionId(ex.exerciseId)) return bad(`exercises[${i}].exerciseId required`);
    const k = norm(ex.exerciseId);
    if (seen.has(k)) return bad("The same exercise appears twice");
    seen.add(k);
    let ts = ex.targetSets;
    if (ts === "" || ts === undefined) ts = null;
    if (ts !== null && (!Number.isInteger(ts) || ts < 1 || ts > PLAN_LIMITS.maxTargetSets)) return bad(`exercises[${i}].targetSets must be a whole number 1-${PLAN_LIMITS.maxTargetSets}`);
    const tr = ex.targetReps == null ? "" : ex.targetReps;
    if (typeof tr !== "string" || tr.length > PLAN_LIMITS.maxTargetReps) return bad(`exercises[${i}].targetReps must be text up to ${PLAN_LIMITS.maxTargetReps} chars`);
    exercises.push({ exerciseId: ex.exerciseId, targetSets: ts, targetReps: tr.trim() });
  }
  return { ok: true, value: { date: b.date, dayType: b.exercises.length ? b.dayType : "", exercises } };
}

/**
 * Diff stored rows against the desired plan. Rows are matched by exercise; the result is the minimum set of writes:
 * {creates:[{exerciseId,order,targetSets,targetReps}], updates:[{id,changes}], trashes:[id]}. Re-running it is safe.
 */
export function diffPlan(rows, desired) {
  const byEx = new Map();
  const trashes = [];
  for (const r of rows) {
    const k = norm(r.exerciseId);
    if (!r.exerciseId || byEx.has(k)) trashes.push(r.id); else byEx.set(k, r); // rows without exercise or duplicates go
  }
  const want = new Set(desired.exercises.map((e) => norm(e.exerciseId)));
  for (const [k, r] of byEx) if (!want.has(k)) { trashes.push(r.id); byEx.delete(k); }
  const creates = [], updates = [];
  desired.exercises.forEach((e, i) => {
    const row = { exerciseId: e.exerciseId, order: i + 1, targetSets: e.targetSets, targetReps: e.targetReps };
    const r = byEx.get(norm(e.exerciseId));
    if (!r) return creates.push(row);
    const changes = {};
    if (r.order !== row.order) changes.order = row.order;
    if ((r.targetSets ?? null) !== row.targetSets) changes.targetSets = row.targetSets;
    if ((r.targetReps || "") !== row.targetReps) changes.targetReps = row.targetReps;
    if (planRowBase(r) !== desired.dayType) changes.base = desired.dayType;
    if (Object.keys(changes).length) updates.push({ id: r.id, row, changes });
  });
  return { creates, updates, trashes };
}

async function view(store, date) {
  const [rows, ex] = await Promise.all([store.listRows(date), store.exercises()]);
  const names = new Map(ex.map((e) => [norm(e.id), e.name]));
  const sorted = rows.filter((r) => r.exerciseId).sort((a, b) => a.order - b.order);
  return {
    date, exists: sorted.length > 0, dayType: sorted.length ? planRowBase(sorted[0]) : "",
    exercises: sorted.map((r) => ({ exerciseId: r.exerciseId, name: names.get(norm(r.exerciseId)) || "?", targetSets: r.targetSets, targetReps: r.targetReps || "" })),
  };
}

async function save(store, req) {
  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const v = validatePlan(body, await store.dayTypes());
  if (!v.ok) return json({ error: v.error }, 400);
  const desired = v.value;
  const lib = await store.exercises();
  const known = new Set(lib.map((e) => norm(e.id))), nameOf = new Map(lib.map((e) => [norm(e.id), e.name]));
  for (const e of desired.exercises) if (!known.has(norm(e.exerciseId))) return json({ error: `Unknown exerciseId ${e.exerciseId}` }, 400);
  const d = diffPlan(await store.listRows(desired.date), desired);
  try {
    for (const c of d.creates) await store.create(desired.date, desired.dayType, { ...c, name: nameOf.get(norm(c.exerciseId)) });
    for (const u of d.updates) await store.update(u.id, desired.date, desired.dayType, u.row);
    for (const id of d.trashes) await store.trash(id);
  } finally { store.invalidate(); }
  return json({ ...(await view(store, desired.date)), applied: { created: d.creates.length, updated: d.updates.length, trashed: d.trashes.length } });
}

/** Handle /api/plan (GET ?date=, PUT body, DELETE ?date=). Returns a Response. */
export async function handlePlan(req, url, store) {
  try {
    if (req.method === "PUT") return await save(store, req);
    const date = url.searchParams.get("date") || "";
    if (!validDate(date)) return json({ error: "date must be YYYY-MM-DD" }, 400);
    if (req.method === "GET") return json(await view(store, date));
    if (req.method === "DELETE") {
      const rows = await store.listRows(date);
      try { for (const r of rows) await store.trash(r.id); } finally { store.invalidate(); }
      return json({ deleted: true, date, rowCount: rows.length });
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: e.message || "Server error" }, e.status || 500);
  }
}
