// Cloudflare Worker: static assets + /api/* proxy to Notion (Notion is only the database).
import { resolveDataSources, parseExercise, parseSession, parseSet, parseDayTemplate, buildBootstrap, validateSession, sessionName, buildHistory, buildSessionList, buildSessionDetail, validateSessionPatch, diffSession, isNotionId, notesToRichText, validateNewExercise, findDuplicateExercise, mergeMuscleGroups, planRowName, planNamePrefix, planNotes, isPlanRow } from "./logic.js";
import { handlePlan } from "./plan.js";

const NOTION = "https://api.notion.com/v1";
// Notion data source ids come from Worker vars (wrangler.toml [vars]); resolved per request in fetch().
let DS = null;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Constant-time string compare (hash-free; pads to the longer length).
function safeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

/** Notion fetch with retry on 429 (honors Retry-After) and transient 5xx. */
async function notion(env, method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(NOTION + path, {
      method,
      headers: { Authorization: `Bearer ${env.NOTION_KEY}`, "Notion-Version": "2025-09-03", "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status >= 502) && attempt < 6) {
      const ra = Number(res.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, (ra > 0 ? ra : 1 + attempt) * 1000));
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`Notion ${res.status}: ${data.message || ""}`), { status: 502, notionStatus: res.status });
    return data;
  }
}

async function queryAll(env, ds, filter) {
  const out = [];
  let cursor;
  do {
    const r = await notion(env, "POST", `/data_sources/${ds}/query`, { page_size: 100, start_cursor: cursor, filter });
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

/** Run async tasks with limited concurrency. */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; results[k] = await fn(items[k], k); }
  }));
  return results;
}

let cache = { at: 0, data: null }; // ~30s in-memory cache of bootstrap
const dayTypesOf = async (env) => {
  const ds = await notion(env, "GET", `/data_sources/${DS.sessions}`);
  return ds.properties["Day Type"].select.options.map((o) => o.name);
};

async function bootstrap(env) {
  if (cache.data && Date.now() - cache.at < 30000) return cache.data;
  const [dayTypes, ex, se, st, dt] = await Promise.all([
    dayTypesOf(env), queryAll(env, DS.exercises), queryAll(env, DS.sessions), queryAll(env, DS.sets), queryAll(env, DS.dayTemplates),
  ]);
  const data = buildBootstrap({ dayTypes, exercises: ex.map(parseExercise), sessions: se.map(parseSession), sets: st.map(parseSet), dayTemplates: dt.map(parseDayTemplate), planMinDate: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10) });
  cache = { at: Date.now(), data };
  return data;
}

// Full history of one exercise: one filtered Sets query + one Sessions query (paginated), cached ~30s per exercise.
const histCache = new Map();
async function history(env, exerciseId) {
  const hit = histCache.get(exerciseId);
  if (hit && Date.now() - hit.at < 30000) return hit.data;
  const [st, se] = await Promise.all([
    queryAll(env, DS.sets, { property: "Exercise", relation: { contains: exerciseId } }),
    queryAll(env, DS.sessions),
  ]);
  const data = { exerciseId, sessions: buildHistory(exerciseId, se.map(parseSession), st.map(parseSet)) };
  if (histCache.size > 100) histCache.clear();
  histCache.set(exerciseId, { at: Date.now(), data });
  return data;
}

// Notion-backed store for the Plan tab (plan rows live in Day Templates, see logic.js).
function planStore(env) {
  const props = (date, base, row, name) => {
    const p = {
      "Day Type": { select: { name: "Planned" } }, Exercise: { relation: [{ id: row.exerciseId }] }, Order: { number: row.order },
      "Target Sets": { number: row.targetSets }, "Target Reps": { rich_text: row.targetReps ? rt(row.targetReps) : [] },
      Notes: { rich_text: rt(planNotes(date, base)) },
    };
    if (name) p.Name = { title: rt(name) };
    return p;
  };
  return {
    dayTypes: () => dayTypesOf(env),
    exercises: async () => (await queryAll(env, DS.exercises)).map(parseExercise),
    // Title prefix only: filtering on the "Planned" select option would fail while that option does not exist yet.
    listRows: async (date) => (await queryAll(env, DS.dayTemplates, { property: "Name", title: { starts_with: planNamePrefix(date) } })).map(parseDayTemplate).filter(isPlanRow),
    create: (date, base, row) => notion(env, "POST", "/pages", { parent: { type: "data_source_id", data_source_id: DS.dayTemplates }, properties: props(date, base, row, planRowName(date, row.name || "exercise")) }),
    update: (id, date, base, row) => notion(env, "PATCH", `/pages/${id}`, { properties: props(date, base, row) }),
    trash: (id) => notion(env, "PATCH", `/pages/${id}`, { in_trash: true }),
    invalidate,
  };
}

const rt = (s) => [{ type: "text", text: { content: s } }];
const normId = (id) => String(id || "").replace(/-/g, "").toLowerCase();
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const invalidate = () => { cache = { at: 0, data: null }; histCache.clear(); };

/**
 * Resolve every exercise entry to an existing exercise id (mutates ex.exerciseId). New exercises are matched by name
 * first (so a retry after a partial failure reuses the page it created), else created. Returns Map(id -> name).
 */
async function resolveExercises(env, exercises) {
  const existing = (await queryAll(env, DS.exercises)).map(parseExercise);
  const nameOf = new Map(existing.map((e) => [e.id, e.name]));
  const byNorm = new Map(existing.map((e) => [normId(e.id), e]));
  for (const ex of exercises) {
    if (ex.exerciseId) {
      const hit = byNorm.get(normId(ex.exerciseId));
      if (!hit) throw httpErr(400, `Unknown exerciseId ${ex.exerciseId}`);
      ex.exerciseId = hit.id; continue;
    }
    const hit = existing.find((e) => e.name.toLowerCase() === ex.newExercise.name.toLowerCase());
    if (hit) { ex.exerciseId = hit.id; continue; }
    const props = { Name: { title: rt(ex.newExercise.name) } };
    if (ex.newExercise.muscle) props["Muscle Group"] = { select: { name: ex.newExercise.muscle } };
    if (ex.newExercise.equipment) props.Equipment = { select: { name: ex.newExercise.equipment } };
    const pg = await notion(env, "POST", "/pages", { parent: { type: "data_source_id", data_source_id: DS.exercises }, properties: props });
    ex.exerciseId = pg.id; nameOf.set(pg.id, ex.newExercise.name);
    const created = { id: pg.id, name: ex.newExercise.name }; existing.push(created); byNorm.set(normId(pg.id), created);
  }
  return nameOf;
}

/** Notion properties for a set from a plain {exerciseId,n,name,weight,reps,eachSide,notes} (only the keys present). */
function setProps(c) {
  const p = {};
  if ("exerciseId" in c) p.Exercise = { relation: [{ id: c.exerciseId }] };
  if ("n" in c) p["Set #"] = { number: c.n };
  if ("name" in c) p.Name = { title: rt(c.name) };
  if ("weight" in c) p["Weight (lb)"] = { number: c.weight };
  if ("reps" in c) p.Reps = { number: c.reps };
  if ("eachSide" in c) p["Each Side"] = { checkbox: c.eachSide };
  if ("notes" in c) p.Notes = { rich_text: c.notes ? rt(c.notes) : [] };
  return p;
}

/** Load a session page (must live in the Sessions data source and not be trashed) plus its sets. */
async function loadSession(env, id) {
  if (!isNotionId(id || "")) throw httpErr(400, "id required");
  let pg;
  try { pg = await notion(env, "GET", `/pages/${id}`); }
  catch (e) { if (e.notionStatus === 404 || e.notionStatus === 400) throw httpErr(404, "Session not found"); throw e; }
  const ds = pg.parent?.data_source_id || pg.parent?.database_id;
  if (pg.in_trash || pg.archived || normId(ds) !== normId(DS.sessions)) throw httpErr(404, "Session not found");
  const rows = await queryAll(env, DS.sets, { property: "Session", relation: { contains: pg.id } });
  return { page: pg, session: parseSession(pg), sets: rows.map(parseSet), setPages: rows };
}

async function listSessions(env) {
  const [se, st, ex] = await Promise.all([queryAll(env, DS.sessions), queryAll(env, DS.sets), queryAll(env, DS.exercises)]);
  return { sessions: buildSessionList(se.map(parseSession), st.map(parseSet), ex.map(parseExercise)) };
}

async function sessionDetail(env, id) {
  const [cur, ex] = await Promise.all([loadSession(env, id), queryAll(env, DS.exercises)]);
  return buildSessionDetail(cur.session, cur.sets, ex.map(parseExercise));
}

async function patchSession(env, id, req) {
  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const v = validateSessionPatch(body, await dayTypesOf(env));
  if (!v.ok) return json({ error: v.error }, 400);
  const desired = v.value;
  const cur = await loadSession(env, id);
  const have = new Set(cur.sets.map((s) => normId(s.id)));
  for (const ex of desired.exercises) for (const s of ex.sets) if (s.id && !have.has(normId(s.id))) return json({ error: `Unknown set id ${s.id} (not part of this session)` }, 400);
  let applied;
  try {
    const nameOf = await resolveExercises(env, desired.exercises);
    const seen = new Set();
    for (const ex of desired.exercises) { if (seen.has(normId(ex.exerciseId))) return json({ error: "The same exercise appears twice" }, 400); seen.add(normId(ex.exerciseId)); }
    const d = diffSession({ session: cur.session, sets: cur.sets }, desired, nameOf);
    if (!d.ok) return json({ error: d.error }, 400);
    // Order: row edits, creates, trashes, then the session row (its order marker). Every step is safe to repeat.
    await pool(d.updates, 3, (u) => notion(env, "PATCH", `/pages/${u.id}`, { properties: setProps(u.changes) }));
    await pool(d.creates, 3, (c) => notion(env, "POST", "/pages", {
      parent: { type: "data_source_id", data_source_id: DS.sets },
      properties: { ...setProps(c), Session: { relation: [{ id: cur.page.id }] } },
    }));
    await pool(d.trashes, 3, (sid) => notion(env, "PATCH", `/pages/${sid}`, { in_trash: true }));
    if (d.session) {
      const c = d.session, props = {};
      if (c.date) props.Date = { date: { start: c.date } };
      if (c.dayType) props["Day Type"] = { select: { name: c.dayType } };
      if (c.name) props.Name = { title: rt(c.name) };
      if ("notes" in c) props.Notes = { rich_text: notesToRichText(c.notes) };
      await notion(env, "PATCH", `/pages/${cur.page.id}`, { properties: props });
    }
    applied = { updated: d.updates.length, created: d.creates.length, trashed: d.trashes.length, session: !!d.session };
  } finally { invalidate(); }
  return json({ ...(await sessionDetail(env, id)), applied });
}

async function deleteSession(env, id) {
  const cur = await loadSession(env, id);
  try {
    await pool(cur.setPages, 3, (pg) => notion(env, "PATCH", `/pages/${pg.id}`, { in_trash: true }));
    await notion(env, "PATCH", `/pages/${cur.page.id}`, { in_trash: true });
  } finally { invalidate(); }
  return json({ deleted: true, sessionId: cur.page.id, setCount: cur.setPages.length });
}

/** POST /api/exercise: add one exercise to the Exercises database (name unique ignoring case). */
async function createExercise(env, req) {
  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const library = (await queryAll(env, DS.exercises)).map(parseExercise);
  const known = mergeMuscleGroups(library);
  const v = validateNewExercise(body, known);
  if (!v.ok) return json({ error: v.error }, v.conflict ? 409 : 400);
  const e = v.value;
  const dup = findDuplicateExercise(library, e.name);
  if (dup) return json({ error: `"${dup.name}" already exists in your library`, exercise: { id: dup.id, name: dup.name, muscle: dup.muscle, equipment: dup.equipment } }, 409);
  // A custom muscle group needs no schema call: Notion creates the select option when a new name is written (same reliance as resolveExercises and the "Planned" day type).
  const props = { Name: { title: rt(e.name) }, "Muscle Group": { select: { name: e.muscle } } };
  if (e.equipment) props.Equipment = { select: { name: e.equipment } };
  let pg;
  try { pg = await notion(env, "POST", "/pages", { parent: { type: "data_source_id", data_source_id: DS.exercises }, properties: props }); }
  finally { invalidate(); }
  return json({ exercise: { id: pg.id, name: e.name, muscle: e.muscle, equipment: e.equipment }, muscleGroups: mergeMuscleGroups([...library, { muscle: e.muscle }]), createdMuscleGroup: e.newMuscle }, 201);
}

async function createSession(env, req) {
  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const v = validateSession(body);
  if (!v.ok) return json({ error: v.error }, 400);
  const p = v.value;
  const expectedSets = p.exercises.reduce((n, e) => n + e.sets.length, 0);
  const marker = `clientId:${p.clientId}`;

  // Idempotency: look for an earlier session carrying this marker.
  const found = await queryAll(env, DS.sessions, { property: "Notes", rich_text: { contains: marker } });
  if (found.length) {
    const have = await queryAll(env, DS.sets, { property: "Session", relation: { contains: found[0].id } });
    if (have.length >= expectedSets) return json({ sessionId: found[0].id, setCount: have.length, duplicate: true });
    // Earlier attempt was cut off midway: trash the partial rows and redo.
    await pool([...have, ...found], 3, (pg) => notion(env, "PATCH", `/pages/${pg.id}`, { in_trash: true }));
  }

  const nameOf = await resolveExercises(env, p.exercises);

  const sess = await notion(env, "POST", "/pages", {
    parent: { type: "data_source_id", data_source_id: DS.sessions },
    properties: {
      Name: { title: rt(sessionName(p.dayType, p.date)) },
      Date: { date: { start: p.date } },
      "Day Type": { select: { name: p.dayType } },
      // Notes = user notes + idempotency marker + exercise order (separate text segments, each <2000 chars)
      Notes: { rich_text: [...(p.notes ? rt(p.notes + "\n") : []), ...rt(marker + "\n"), ...rt("order:" + p.exercises.map((e) => e.exerciseId.replace(/-/g, "")).join(","))] },
    },
  });

  // One Sets page per set, 3 at a time, in order (creation order = exercise order).
  const jobs = [];
  for (const ex of p.exercises) ex.sets.forEach((s, i) => jobs.push({ ex, s, n: i + 1 }));
  const mk = ({ ex, s, n }) => {
    const props = {
      Name: { title: rt(`${nameOf.get(ex.exerciseId)} ${n}`) },
      Session: { relation: [{ id: sess.id }] },
      Exercise: { relation: [{ id: ex.exerciseId }] },
      "Set #": { number: n },
      "Each Side": { checkbox: s.eachSide },
    };
    if (s.weight != null) props["Weight (lb)"] = { number: s.weight };
    if (s.reps != null) props.Reps = { number: s.reps };
    if (s.notes) props.Notes = { rich_text: rt(s.notes) };
    return notion(env, "POST", "/pages", { parent: { type: "data_source_id", data_source_id: DS.sets }, properties: props });
  };
  // Batches of 3 respect the rate limit (exercise order is stored in the session Notes, not inferred).
  for (let i = 0; i < jobs.length; i += 3) await Promise.all(jobs.slice(i, i + 3).map(mk));
  invalidate();
  return json({ sessionId: sess.id, setCount: jobs.length });
}

// PIN check with lockout (KV binding LOCK; skipped when absent, e.g. local dev).
// The lock is checked BEFORE comparing, so a guesser learns nothing while locked.
// Per IP: 5 wrong guesses lock that IP for 15 min. Globally: 100 wrong guesses/hour lock everyone for the hour.
async function checkPin(req, env) {
  const kv = env.LOCK;
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const ipKey = "ip:" + ip;
  if (kv) {
    const [ipN, gN] = await Promise.all([kv.get(ipKey), kv.get("global")]);
    if (Number(ipN || 0) >= 5 || Number(gN || 0) >= 100) {
      return json({ error: "Too many wrong PINs, try again later" }, 429);
    }
  }
  const ok = env.APP_PIN && safeEqual(req.headers.get("X-App-Pin") || "", env.APP_PIN);
  if (ok) return null;
  if (kv) {
    const [ipN, gN] = await Promise.all([kv.get(ipKey), kv.get("global")]);
    await Promise.all([
      kv.put(ipKey, String(Number(ipN || 0) + 1), { expirationTtl: 900 }),
      kv.put("global", String(Number(gN || 0) + 1), { expirationTtl: 3600 }),
    ]);
  }
  return json({ error: "Unauthorized" }, 401);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    const denied = await checkPin(req, env);
    if (denied) return denied;
    const cfg = resolveDataSources(env);
    if (!cfg.ok) return json({ error: cfg.error }, 500);
    DS = cfg.ds;
    try {
      if (url.pathname === "/api/bootstrap" && req.method === "GET") return json(await bootstrap(env));
      if (url.pathname === "/api/history" && req.method === "GET") {
        const id = url.searchParams.get("exerciseId") || "";
        if (!/^[0-9a-fA-F-]{32,40}$/.test(id)) return json({ error: "exerciseId required" }, 400);
        return json(await history(env, id));
      }
      if (url.pathname === "/api/plan") return await handlePlan(req, url, planStore(env));
      if (url.pathname === "/api/exercise" && req.method === "POST") return await createExercise(env, req);
      if (url.pathname === "/api/session" && req.method === "POST") return await createSession(env, req);
      if (url.pathname === "/api/sessions" && req.method === "GET") return json(await listSessions(env));
      if (url.pathname === "/api/session") {
        const id = url.searchParams.get("id") || "";
        if (req.method === "GET") return json(await sessionDetail(env, id));
        if (req.method === "PATCH") return await patchSession(env, id, req);
        if (req.method === "DELETE") return await deleteSession(env, id);
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: e.message || "Server error" }, e.status || 500);
    }
  },
};
