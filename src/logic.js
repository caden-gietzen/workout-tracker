// Pure logic (no network): Notion page parsing, bootstrap building, payload validation.
import { MUSCLE_GROUPS, EQUIPMENT, EXERCISE_NAME_MAX } from "./exercise-options.js";

export const DAY_TYPE_FALLBACK = [];

const txt = (p) => (p?.rich_text || p?.title || []).map((t) => t.plain_text).join("");

/** Parse raw Notion pages into plain objects. */
export function parseExercise(pg) {
  const p = pg.properties;
  return { id: pg.id, name: txt(p.Name), muscle: p["Muscle Group"]?.select?.name || "", equipment: p.Equipment?.select?.name || "" };
}
export function parseSession(pg) {
  const p = pg.properties;
  const notes = txt(p.Notes);
  // The app writes an "order:<id>,<id>..." line (dashes stripped) because created_time only has minute resolution.
  const m = notes.match(/order:([0-9a-f,]+)/);
  return { id: pg.id, created: pg.created_time || "", name: txt(p.Name), date: p.Date?.date?.start || "", dayType: p["Day Type"]?.select?.name || "", notes, order: m ? m[1].split(",") : null };
}
export function parseSet(pg) {
  const p = pg.properties;
  return {
    id: pg.id, created: pg.created_time || "", name: txt(p.Name), notes: txt(p.Notes),
    sessionId: p.Session?.relation?.[0]?.id || null,
    exerciseId: p.Exercise?.relation?.[0]?.id || null,
    n: p["Set #"]?.number ?? null,
    weight: p["Weight (lb)"]?.number ?? null,
    reps: p.Reps?.number ?? null,
    eachSide: !!p["Each Side"]?.checkbox,
  };
}

export function parseDayTemplate(pg) {
  const p = pg.properties;
  return {
    id: pg.id, name: txt(p.Name), dayType: p["Day Type"]?.select?.name || "",
    exerciseId: p.Exercise?.relation?.[0]?.id || null,
    order: p.Order?.number ?? 1e9,
    targetSets: p["Target Sets"]?.number ?? null,
    targetReps: txt(p["Target Reps"]),
    notes: txt(p.Notes),
  };
}

/** Resize suggested sets to n: truncate, or repeat the last set; no source -> n empty sets. */
export function resizeSets(src, n) {
  const count = Math.max(0, Math.round(Number(n) || 0));
  const out = [];
  for (let i = 0; i < count; i++) {
    const s = src && src.length ? src[Math.min(i, src.length - 1)] : null;
    out.push(s ? { weight: s.weight, reps: s.reps, eachSide: !!s.eachSide } : { weight: null, reps: null, eachSide: false });
  }
  return out;
}

/** Templates from Day Templates rows (grouped by day type, sorted by Order). Day types without rows are absent. */
export function buildDayTemplates(rows, exercises, last) {
  const byId = new Map(exercises.map((e) => [e.id, e]));
  const out = {};
  for (const r of rows) {
    if (!r.dayType || !r.exerciseId) continue;
    (out[r.dayType] ||= []).push(r);
  }
  for (const dt of Object.keys(out)) {
    out[dt] = out[dt].sort((a, b) => a.order - b.order).map((r) => ({
      exerciseId: r.exerciseId, name: byId.get(r.exerciseId)?.name || "?",
      targetSets: r.targetSets, targetReps: r.targetReps || "", notes: r.notes || "",
      sets: resizeSets(last[r.exerciseId]?.sets, r.targetSets ?? last[r.exerciseId]?.sets.length ?? 1),
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plan tab: a plan for one date is stored as rows in the Day Templates database (no schema change):
//   Day Type = "Planned", Name = "Planned YYYY-MM-DD - <exercise>", Order = position, Exercise, Target Sets/Reps,
//   Notes = "plan:YYYY-MM-DD" + "base:<day type to log it as>".
// ---------------------------------------------------------------------------
export const PLAN_TYPE = "Planned";
export const planRowName = (date, exName) => `Planned ${date} - ${exName}`;
export const planNamePrefix = (date) => `Planned ${date} - `;
export const planNotes = (date, base) => `plan:${date}\nbase:${base}`;
const PLAN_DATE_RE = /^Planned (\d{4}-\d{2}-\d{2}) - /;
export const isPlanRow = (r) => r.dayType === PLAN_TYPE;
export const planRowDate = (r) => (r.name.match(PLAN_DATE_RE) || [])[1] || (r.notes.match(/plan:(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
export const planRowBase = (r) => ((r.notes.match(/base:([^\n]+)/) || [])[1] || "").trim();

/** Plans keyed by date from parsed Day Templates rows. Only dates >= minDate when given. Same exercise shape as templates. */
export function buildPlans(rows, exercises, last, minDate = "") {
  const byId = new Map(exercises.map((e) => [e.id, e]));
  const out = {};
  for (const r of rows) {
    if (!isPlanRow(r) || !r.exerciseId) continue;
    const date = planRowDate(r);
    if (!date || date < minDate) continue;
    const p = (out[date] ||= { date, dayType: "", exercises: [] });
    if (!p.dayType) p.dayType = planRowBase(r);
    p.exercises.push(r);
  }
  for (const p of Object.values(out)) {
    p.exercises = p.exercises.sort((a, b) => a.order - b.order).map((r) => ({
      exerciseId: r.exerciseId, name: byId.get(r.exerciseId)?.name || "?",
      targetSets: r.targetSets, targetReps: r.targetReps || "", notes: "",
      sets: resizeSets(last[r.exerciseId]?.sets, r.targetSets ?? last[r.exerciseId]?.sets.length ?? 1),
    }));
  }
  return out;
}

/**
 * Group one session's sets by exercise: [{exerciseId, sets}] in the session's order
 * (explicit "order:" marker wins; otherwise order of first set creation; unknown ids last), sets sorted by Set #.
 */
export function groupSessionSets(se, setList) {
  const list = setList.filter((s) => s.exerciseId).slice().sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : (a.n ?? 0) - (b.n ?? 0)));
  const order = [], map = new Map();
  for (const s of list) {
    if (!map.has(s.exerciseId)) { map.set(s.exerciseId, []); order.push(s.exerciseId); }
    map.get(s.exerciseId).push(s);
  }
  if (se.order) {
    const rank = (id) => { const i = se.order.indexOf(id.replace(/-/g, "")); return i < 0 ? 1e9 : i; };
    order.sort((a, b) => rank(a) - rank(b));
  }
  return order.map((id) => ({ exerciseId: id, sets: map.get(id).sort((a, b) => (a.n ?? 0) - (b.n ?? 0) || (a.created < b.created ? -1 : 1)) }));
}

const est1RM = (w, r) => (w && r ? w * (1 + r / 30) : 0);
const slim = (s) => ({ weight: s.weight, reps: s.reps, eachSide: s.eachSide });
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));

/**
 * Build the bootstrap payload.
 * exercises/sessions/sets are parsed objects; dayTypes is the list of select options.
 */
export function buildBootstrap({ exercises, sessions, sets, dayTypes, dayTemplates = [], planMinDate = "" }) {
  // newest session first (ISO dates sort lexicographically)
  const sess = sessions.filter((s) => s.date).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const bySession = new Map();
  for (const s of sets) {
    if (!s.sessionId || !s.exerciseId) continue;
    if (!bySession.has(s.sessionId)) bySession.set(s.sessionId, []);
    bySession.get(s.sessionId).push(s);
  }
  const grouped = (se) => groupSessionSets(se, bySession.get(se.id) || []);
  const byId = new Map(exercises.map((e) => [e.id, e]));
  const templates = {}, last = {}, history = {}, lastDates = {}, recent = [], summary = {};
  for (const se of sess) {
    const g = grouped(se);
    if (recent.length < 5) recent.push({ id: se.id, name: se.name, date: se.date, dayType: se.dayType, exerciseCount: g.length });
    if (se.dayType && !(se.dayType in lastDates)) lastDates[se.dayType] = se.date;
    if (se.dayType && !templates[se.dayType] && g.length) {
      templates[se.dayType] = g.map((x) => ({ exerciseId: x.exerciseId, name: byId.get(x.exerciseId)?.name || "?", sets: x.sets.map(slim) }));
    }
    for (const x of g) {
      const sm = (summary[x.exerciseId] ||= { lastDate: se.date, bestWeight: 0, sessions: 0, sets: 0 }); // sessions are newest first
      sm.sessions++; sm.sets += x.sets.length;
      for (const s of x.sets) if (s.weight > sm.bestWeight) sm.bestWeight = s.weight;
      if (!last[x.exerciseId]) last[x.exerciseId] = { date: se.date, sets: x.sets.map(slim) };
      const h = (history[x.exerciseId] ||= []);
      if (h.length < 8) {
        let top = null;
        for (const s of x.sets) if (s.weight != null && s.reps != null && (!top || est1RM(s.weight, s.reps) > est1RM(top.weight, top.reps))) top = s;
        h.push({
          date: se.date,
          bestWeight: Math.max(0, ...x.sets.map((s) => s.weight || 0)),
          bestEst1RM: Math.round(Math.max(0, ...x.sets.map((s) => est1RM(s.weight, s.reps)))),
          topSet: top ? `${fmt(top.weight)}x${fmt(top.reps)}` : "",
        });
      }
    }
  }
  // Day Templates rows win; day types without rows keep the last-session template above.
  Object.assign(templates, buildDayTemplates(dayTemplates.filter((r) => !isPlanRow(r)), exercises, last));
  const plans = buildPlans(dayTemplates, exercises, last, planMinDate);
  return { dayTypes, muscleGroups: mergeMuscleGroups(exercises), equipmentOptions: EQUIPMENT, plans, exercises: exercises.map((e) => ({ id: e.id, name: e.name, muscle: e.muscle, equipment: e.equipment })), templates, last, history, lastDates, recent, summary };
}

/**
 * Full history of one exercise: [{date, sessionId, dayType, sets:[{weight,reps,eachSide}]}] ordered by date ascending.
 * sets = parsed Sets rows (any exercise is fine, others are ignored); sessions = parsed Sessions rows.
 */
export function buildHistory(exerciseId, sessions, sets) {
  const sById = new Map(sessions.map((s) => [s.id, s]));
  const per = new Map();
  for (const s of sets) {
    if (s.exerciseId !== exerciseId || !s.sessionId || !sById.has(s.sessionId)) continue;
    if (!per.has(s.sessionId)) per.set(s.sessionId, []);
    per.get(s.sessionId).push(s);
  }
  const out = [];
  for (const [sid, list] of per) {
    const se = sById.get(sid);
    if (!se.date) continue;
    list.sort((a, b) => (a.n ?? 0) - (b.n ?? 0) || (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
    out.push({ date: se.date, sessionId: sid, dayType: se.dayType, sets: list.map(slim) });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.sessionId < b.sessionId ? -1 : 1));
}

/** Validate a POST /api/session body. Returns {ok:true, value} or {ok:false, error}. */
export function validateSession(b, dayTypes = null) {
  const bad = (error) => ({ ok: false, error });
  if (!b || typeof b !== "object") return bad("Body must be a JSON object");
  if (typeof b.dayType !== "string" || !b.dayType) return bad("dayType required");
  if (dayTypes && !dayTypes.includes(b.dayType)) return bad(`Unknown dayType: ${b.dayType}`);
  if (typeof b.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || isNaN(Date.parse(b.date))) return bad("date must be YYYY-MM-DD");
  if (typeof b.clientId !== "string" || !/^[\w-]{6,80}$/.test(b.clientId)) return bad("clientId required (6-80 chars, letters/digits/-/_)");
  if (b.notes != null && (typeof b.notes !== "string" || b.notes.length > 1500)) return bad("notes must be a string up to 1500 chars");
  if (!Array.isArray(b.exercises) || !b.exercises.length) return bad("exercises must be a non-empty array");
  if (b.exercises.length > 40) return bad("Max 40 exercises");
  const num = (v, max, label) => {
    if (v === null || v === undefined || v === "") return { v: null };
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > max) return { err: `${label} must be a number 0-${max}` };
    return { v: n };
  };
  const exercises = [];
  for (const [i, ex] of b.exercises.entries()) {
    if (!ex || typeof ex !== "object") return bad(`exercises[${i}] invalid`);
    const out = {};
    if (ex.exerciseId) {
      if (typeof ex.exerciseId !== "string" || ex.exerciseId.length > 64) return bad(`exercises[${i}].exerciseId invalid`);
      out.exerciseId = ex.exerciseId;
    } else if (ex.newExercise) {
      const n = ex.newExercise;
      if (typeof n.name !== "string" || !n.name.trim() || n.name.length > 100) return bad(`exercises[${i}].newExercise.name required (<=100 chars)`);
      out.newExercise = { name: n.name.trim(), muscle: n.muscle || undefined, equipment: n.equipment || undefined };
    } else return bad(`exercises[${i}] needs exerciseId or newExercise`);
    if (!Array.isArray(ex.sets)) return bad(`exercises[${i}].sets must be an array`);
    if (ex.sets.length > 30) return bad(`exercises[${i}]: max 30 sets`);
    out.sets = [];
    for (const [j, s] of ex.sets.entries()) {
      if (!s || typeof s !== "object") return bad(`exercises[${i}].sets[${j}] invalid`);
      const w = num(s.weight, 2000, `exercises[${i}].sets[${j}].weight`); if (w.err) return bad(w.err);
      const r = num(s.reps, 500, `exercises[${i}].sets[${j}].reps`); if (r.err) return bad(r.err);
      if (w.v == null && r.v == null) continue; // empty sets are ignored
      const notes = typeof s.notes === "string" ? s.notes.slice(0, 500) : undefined;
      out.sets.push({ weight: w.v, reps: r.v, eachSide: !!s.eachSide, notes });
    }
    if (out.sets.length) exercises.push(out);
  }
  if (!exercises.length) return bad("No non-empty sets to save");
  return { ok: true, value: { dayType: b.dayType, date: b.date, notes: b.notes || "", clientId: b.clientId, exercises } };
}

/** "Back & Biceps - Nov 9" */
export function sessionName(dayType, date) {
  const [, m, d] = date.split("-").map(Number);
  return `${dayType} - ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1]} ${d}`;
}

/** Read the four Notion data source ids from Worker vars. Returns {ok:true, ds} or {ok:false, error}. */
export function resolveDataSources(env) {
  const map = { exercises: "EXERCISES_DS", sessions: "SESSIONS_DS", sets: "SETS_DS", dayTemplates: "TEMPLATES_DS" };
  const ds = {}, missing = [];
  for (const [k, name] of Object.entries(map)) {
    const v = typeof env?.[name] === "string" ? env[name].trim() : "";
    if (!v || /^PASTE_/i.test(v)) missing.push(name); else ds[k] = v;
  }
  if (missing.length) {
    return { ok: false, error: `Not configured: set ${missing.join(", ")} in wrangler.toml [vars] (run scripts/setup-notion.mjs to get the ids), then redeploy.` };
  }
  return { ok: true, ds };
}

// ---------------------------------------------------------------------------
// History tab: list, detail, editing (PATCH) logic. All pure; the Worker only does the Notion I/O.
// ---------------------------------------------------------------------------

export const LIMITS = { maxExercises: 40, maxSetsPerExercise: 30, maxWeight: 2000, maxReps: 500, maxNotes: 1500, maxSetNotes: 500 };
const normId = (id) => String(id || "").replace(/-/g, "").toLowerCase();
export const isNotionId = (id) => typeof id === "string" && /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/.test(id);

const CLIENT_RE = /^\s*clientId:\S+\s*$/, ORDER_RE = /^\s*order:[0-9a-f,]*\s*$/;
/** Split raw session Notes into the human part and the machine marker lines (clientId:..., order:...). */
export function splitNotes(raw) {
  const human = [];
  let clientLine = null, orderIds = null;
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (CLIENT_RE.test(line)) { clientLine = clientLine ?? line.trim(); continue; }
    if (ORDER_RE.test(line)) { const v = line.trim().slice(6); orderIds = orderIds ?? (v ? v.split(",") : []); continue; }
    human.push(line);
  }
  return { human: human.join("\n").trim(), clientLine, orderIds };
}
/** Inverse of splitNotes: human text, then the clientId line, then the order line (each only when present). */
export function mergeNotes(human, clientLine, orderIds) {
  const lines = [];
  const h = String(human || "").trim();
  if (h) lines.push(h);
  if (clientLine) lines.push(clientLine);
  if (orderIds) lines.push("order:" + orderIds.join(","));
  return lines.join("\n");
}
/** Notion rich_text segments (each <2000 chars) for a merged notes string. */
export function notesToRichText(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 1900) out.push({ type: "text", text: { content: text.slice(i, i + 1900) } });
  return out;
}

/** Sessions list for the History tab, newest first: [{id,date,dayType,name,setCount,exercises:[names],volume}]. */
export function buildSessionList(sessions, sets, exercises) {
  const nameOf = new Map(exercises.map((e) => [e.id, e.name]));
  const by = new Map();
  for (const s of sets) if (s.sessionId) { if (!by.has(s.sessionId)) by.set(s.sessionId, []); by.get(s.sessionId).push(s); }
  const out = sessions.map((se) => {
    const g = groupSessionSets(se, by.get(se.id) || []);
    let setCount = 0, volume = 0;
    for (const x of g) for (const s of x.sets) { setCount++; volume += (s.weight || 0) * (s.reps || 0); }
    return { id: se.id, date: se.date, dayType: se.dayType, name: se.name, setCount, exercises: g.map((x) => nameOf.get(x.exerciseId) || "?"), volume: Math.round(volume), _c: se.created || "" };
  });
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a._c < b._c ? 1 : a._c > b._c ? -1 : 0));
  return out.map(({ _c, ...rest }) => rest);
}

/** Full session detail with sets grouped by exercise (human notes only). */
export function buildSessionDetail(se, sets, exercises) {
  const nameOf = exercises instanceof Map ? exercises : new Map(exercises.map((e) => [e.id, e.name]));
  return {
    id: se.id, date: se.date, dayType: se.dayType, name: se.name, notes: splitNotes(se.notes).human,
    exercises: groupSessionSets(se, sets).map((x) => ({
      exerciseId: x.exerciseId, name: nameOf.get(x.exerciseId) || "?",
      sets: x.sets.map((s) => ({ id: s.id, n: s.n, weight: s.weight, reps: s.reps, eachSide: !!s.eachSide, notes: s.notes || "" })),
    })),
  };
}

/** Validate a PATCH /api/session body (desired final state). Returns {ok:true,value} or {ok:false,error}. */
export function validateSessionPatch(b, dayTypes = null) {
  const bad = (error) => ({ ok: false, error });
  if (!b || typeof b !== "object" || Array.isArray(b)) return bad("Body must be a JSON object");
  const value = {};
  if (b.date !== undefined) {
    if (typeof b.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || isNaN(Date.parse(b.date))) return bad("date must be YYYY-MM-DD");
    value.date = b.date;
  }
  if (b.dayType !== undefined) {
    if (typeof b.dayType !== "string" || !b.dayType) return bad("dayType must be a non-empty string");
    if (dayTypes && !dayTypes.includes(b.dayType)) return bad(`Unknown dayType: ${b.dayType}`);
    value.dayType = b.dayType;
  }
  if (b.notes !== undefined && b.notes !== null) {
    if (typeof b.notes !== "string" || b.notes.length > LIMITS.maxNotes) return bad(`notes must be a string up to ${LIMITS.maxNotes} chars`);
    value.notes = b.notes;
  }
  if (!Array.isArray(b.exercises)) return bad("exercises must be an array");
  if (b.exercises.length > LIMITS.maxExercises) return bad(`Max ${LIMITS.maxExercises} exercises`);
  const num = (v, max, label) => {
    if (v === null || v === undefined || v === "") return { v: null };
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > max) return { err: `${label} must be a number 0-${max}` };
    return { v: n };
  };
  const seenSets = new Set(), seenEx = new Set(), exercises = [];
  for (const [i, ex] of b.exercises.entries()) {
    if (!ex || typeof ex !== "object") return bad(`exercises[${i}] invalid`);
    const out = {};
    if (ex.exerciseId) {
      if (!isNotionId(ex.exerciseId)) return bad(`exercises[${i}].exerciseId invalid`);
      if (seenEx.has(normId(ex.exerciseId))) return bad(`exercises[${i}]: exercise appears twice`);
      seenEx.add(normId(ex.exerciseId));
      out.exerciseId = ex.exerciseId;
    } else if (ex.newExercise) {
      const n = ex.newExercise;
      if (typeof n !== "object" || typeof n.name !== "string" || !n.name.trim() || n.name.length > 100) return bad(`exercises[${i}].newExercise.name required (<=100 chars)`);
      out.newExercise = { name: n.name.trim(), muscle: n.muscle || undefined, equipment: n.equipment || undefined };
    } else return bad(`exercises[${i}] needs exerciseId or newExercise`);
    if (!Array.isArray(ex.sets)) return bad(`exercises[${i}].sets must be an array`);
    if (ex.sets.length > LIMITS.maxSetsPerExercise) return bad(`exercises[${i}]: max ${LIMITS.maxSetsPerExercise} sets`);
    out.sets = [];
    for (const [j, s] of ex.sets.entries()) {
      if (!s || typeof s !== "object") return bad(`exercises[${i}].sets[${j}] invalid`);
      const w = num(s.weight, LIMITS.maxWeight, `exercises[${i}].sets[${j}].weight`); if (w.err) return bad(w.err);
      const r = num(s.reps, LIMITS.maxReps, `exercises[${i}].sets[${j}].reps`); if (r.err) return bad(r.err);
      if (s.eachSide !== undefined && typeof s.eachSide !== "boolean") return bad(`exercises[${i}].sets[${j}].eachSide must be true/false`);
      if (s.notes != null && (typeof s.notes !== "string" || s.notes.length > LIMITS.maxSetNotes)) return bad(`exercises[${i}].sets[${j}].notes must be a string up to ${LIMITS.maxSetNotes} chars`);
      const set = { weight: w.v, reps: r.v, eachSide: !!s.eachSide };
      if (typeof s.notes === "string") set.notes = s.notes;
      if (s.id !== undefined && s.id !== null && s.id !== "") {
        if (!isNotionId(s.id)) return bad(`exercises[${i}].sets[${j}].id invalid`);
        if (seenSets.has(normId(s.id))) return bad(`exercises[${i}].sets[${j}].id appears twice`);
        seenSets.add(normId(s.id));
        set.id = s.id;
      } else if (w.v == null && r.v == null) continue; // new empty sets are ignored
      out.sets.push(set);
    }
    if (out.sets.length) exercises.push(out); // exercises left with no sets are removed
  }
  if (!exercises.length) return bad("A session needs at least one set (use Delete session to remove it)");
  value.exercises = exercises;
  return { ok: true, value };
}

const sameNum = (a, b) => (a ?? null) === (b ?? null);
/**
 * Diff the desired final state against what Notion has.
 * current: {session: parseSession(...), sets: parseSet(...)[]}; desired: validated PATCH value with every exercise
 * resolved to an exerciseId; nameOf: Map(exerciseId -> name).
 * Returns {ok:true, session:null|{date?,dayType?,name?,notes?}, updates:[{id,changes}], creates:[{exerciseId,n,name,weight,reps,eachSide,notes}], trashes:[ids]}
 * or {ok:false,error}. Sets are matched by id; new sets (no id) adopt an identical unmatched existing set of the same
 * exercise, so re-sending the same body after a partial failure converges instead of duplicating.
 */
export function diffSession(current, desired, nameOf) {
  const se = current.session;
  const mine = current.sets.filter((s) => s.exerciseId);
  const cur = new Map(mine.map((s) => [normId(s.id), s]));
  const matched = new Set();
  const nm = (id) => nameOf.get(id) || nameOf.get(normId(id)) || "?";
  for (const ex of desired.exercises) for (const s of ex.sets) if (s.id) {
    if (!cur.has(normId(s.id))) return { ok: false, error: `Unknown set id ${s.id} (not part of this session)` };
    matched.add(normId(s.id));
  }
  const notesOf = (s) => (s.notes ?? "");
  const updates = [], creates = [];
  for (const ex of desired.exercises) {
    const exKey = normId(ex.exerciseId);
    const free = mine.filter((c) => normId(c.exerciseId) === exKey && !matched.has(normId(c.id))).sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
    ex.sets.forEach((s, i) => {
      const n = i + 1, name = `${nm(ex.exerciseId)} ${n}`;
      let base = s.id ? cur.get(normId(s.id)) : null;
      if (!base) {
        const k = free.findIndex((c) => sameNum(c.weight, s.weight) && sameNum(c.reps, s.reps) && !!c.eachSide === !!s.eachSide && notesOf(c) === (s.notes ?? ""));
        if (k >= 0) { base = free.splice(k, 1)[0]; matched.add(normId(base.id)); }
      }
      if (!base) { creates.push({ exerciseId: ex.exerciseId, n, name, weight: s.weight, reps: s.reps, eachSide: !!s.eachSide, notes: s.notes ?? "" }); return; }
      const ch = {};
      if (normId(base.exerciseId) !== exKey) ch.exerciseId = ex.exerciseId;
      if (base.n !== n) ch.n = n;
      if (base.name !== name) ch.name = name;
      if (!sameNum(base.weight, s.weight)) ch.weight = s.weight;
      if (!sameNum(base.reps, s.reps)) ch.reps = s.reps;
      if (!!base.eachSide !== !!s.eachSide) ch.eachSide = !!s.eachSide;
      if (s.notes !== undefined && notesOf(base) !== s.notes) ch.notes = s.notes;
      if (Object.keys(ch).length) updates.push({ id: base.id, changes: ch });
    });
  }
  const trashes = mine.filter((c) => !matched.has(normId(c.id))).map((c) => c.id);

  // Session row
  const parts = splitNotes(se.notes);
  const curOrder = groupSessionSets(se, current.sets).map((g) => normId(g.exerciseId));
  const newOrder = desired.exercises.map((e) => normId(e.exerciseId));
  const orderChanged = curOrder.join(",") !== newOrder.join(",");
  const newHuman = desired.notes === undefined ? parts.human : splitNotes(desired.notes).human;
  const sc = {};
  const date = desired.date ?? se.date, dayType = desired.dayType ?? se.dayType;
  if (date !== se.date) sc.date = date;
  if (dayType !== se.dayType) sc.dayType = dayType;
  if ((sc.date || sc.dayType) && date) sc.name = sessionName(dayType, date);
  if (newHuman !== parts.human || orderChanged) sc.notes = mergeNotes(newHuman, parts.clientLine, orderChanged ? newOrder : (parts.orderIds ?? null));
  return { ok: true, session: Object.keys(sc).length ? sc : null, updates, creates, trashes };
}

// ---------------------------------------------------------------------------
// Creating an exercise (POST /api/exercise)
// ---------------------------------------------------------------------------
export const MUSCLE_NAME_MAX = 40;
const squash = (v) => String(v).replace(/\s+/g, " ").trim();
const lower = (v) => squash(v).toLowerCase();
/** Muscle groups offered by the app: the fixed shared list first, then custom ones found on existing exercises (A-Z, case-insensitive dedupe). */
export function mergeMuscleGroups(exercises) {
  const seen = new Set(MUSCLE_GROUPS.map(lower)), extra = [];
  for (const e of exercises || []) {
    const m = squash(e.muscle || "");
    if (m && !seen.has(m.toLowerCase())) { seen.add(m.toLowerCase()); extra.push(m); }
  }
  return [...MUSCLE_GROUPS, ...extra.sort((a, b) => a.localeCompare(b))];
}
const MUSCLE_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} &'\/().-]*$/u;
/**
 * Validate a POST /api/exercise body: {name, muscle, equipment?, newMuscle?}.
 * known = muscle groups that already exist (mergeMuscleGroups). With newMuscle:true, `muscle` is a custom group to be created
 * (trimmed, <=40 chars, plain characters, not a case-insensitive duplicate of a known group); otherwise it must be one of `known`.
 * Returns {ok:true,value:{name,muscle,equipment,newMuscle}} or {ok:false,error,conflict?}.
 */
export function validateNewExercise(b, known = MUSCLE_GROUPS) {
  const bad = (error, conflict) => ({ ok: false, error, ...(conflict ? { conflict: true } : {}) });
  if (!b || typeof b !== "object" || Array.isArray(b)) return bad("Body must be a JSON object");
  if (typeof b.name !== "string") return bad("name required");
  const name = squash(b.name);
  if (!name) return bad("name required");
  if (name.length > EXERCISE_NAME_MAX) return bad(`name must be at most ${EXERCISE_NAME_MAX} characters`);
  if (/[\u0000-\u001f\u007f]/.test(name)) return bad("name contains invalid characters");
  if (typeof b.muscle !== "string" || !b.muscle.trim()) return bad("muscle group required");
  let muscle, newMuscle = false;
  if (b.newMuscle === true) {
    muscle = squash(b.muscle);
    if (muscle.length < 2 || muscle.length > MUSCLE_NAME_MAX) return bad(`muscle group name must be 2-${MUSCLE_NAME_MAX} characters`);
    if (!MUSCLE_NAME_RE.test(muscle)) return bad("muscle group name may only contain letters, numbers, spaces and & ' / ( ) . -");
    const dup = known.find((m) => lower(m) === muscle.toLowerCase());
    if (dup) return bad(`The muscle group "${dup}" already exists, choose it from the list`, true);
    newMuscle = true;
  } else {
    if (b.newMuscle != null && b.newMuscle !== false) return bad("newMuscle must be true or false");
    if (!known.includes(b.muscle)) return bad(`Unknown muscle group: ${b.muscle.slice(0, 40)}`);
    muscle = b.muscle;
  }
  let equipment = "";
  if (b.equipment != null && b.equipment !== "") {
    if (typeof b.equipment !== "string" || !EQUIPMENT.includes(b.equipment)) return bad("Unknown equipment");
    equipment = b.equipment;
  }
  return { ok: true, value: { name, muscle, equipment, newMuscle } };
}
/** The library entry whose name equals `name` ignoring case and extra spaces, or undefined. */
export const findDuplicateExercise = (library, name) => library.find((e) => lower(e.name) === lower(name));
