// Workout Log front end: vanilla JS, no build. State lives in localStorage so nothing is lost.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LS = {
  get: (k, d = null) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  del: (k) => localStorage.removeItem(k),
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const fmt = (n) => (n == null || n === "" ? "" : String(Math.round(n * 10) / 10));
const fmtSet = (s) => `${fmt(s.weight) || "BW"}x${fmt(s.reps) || "?"}${s.eachSide ? "/side" : ""}`;
const blankSet = () => ({ weight: null, reps: null, eachSide: false, done: false });

let boot = LS.get("boot", { dayTypes: [], exercises: [], templates: {}, plans: {}, last: {}, history: {}, lastDates: {}, recent: [] });
let draft = LS.get("draft");       // in-progress session
let view = draft ? "session" : "home";
let selDay = null, picker = null;  // picker: null | {q, adding}
let tab = "log";                   // "log" | "plan" | "progress" | "history" (switching tabs never touches `draft`)
const prog = { q: "", showAll: false, ex: null, range: "all", sel: {}, scroll: 0, loading: false, err: "", offline: false };
const histMem = {};                // exerciseId -> {sessions} (also saved in localStorage as "hist:<id>")
const saveDraft = () => (draft ? LS.set("draft", draft) : LS.del("draft"));

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "X-App-Pin": LS.get("pin", ""), "content-type": "application/json" } });
  if (res.status === 401) { LS.del("pin"); render(); throw Object.assign(new Error("Wrong PIN"), { auth: true }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}
async function loadBootstrap() {
  try { boot = await api("/api/bootstrap"); LS.set("boot", boot); render(); } catch (e) { if (!e.auth) banner("Offline: using last saved data", ""); }
}

// ---------- sync queue ----------
let syncing = false;
async function flushQueue() {
  if (syncing || !LS.get("pin")) return;
  syncing = true;
  try {
    for (;;) {
      const item = LS.get("queue", []).find((x) => !x.rejected);
      if (!item) break;
      const id = item.payload.clientId;
      try {
        await api("/api/session", { method: "POST", body: JSON.stringify(item.payload) });
        LS.set("queue", LS.get("queue", []).filter((x) => x.payload.clientId !== id));
        banner("Synced to Notion", "ok", 4000);
        loadBootstrap();
      } catch (e) {
        if (e.auth) break;
        if (e.status === 400) { // server says payload is invalid: keep it on the phone, stop retrying, tell the user
          item.rejected = e.message;
          LS.set("queue", LS.get("queue", []).map((x) => (x.payload.clientId === id ? item : x)));
          continue;
        }
        break; // network/server error: retry later
      }
    }
  } finally { syncing = false; if (!$("#banner").classList.contains("ok")) showQueueBanner(); }
}
function showQueueBanner() {
  const q = LS.get("queue", []);
  const bad = q.filter((x) => x.rejected), wait = q.length - bad.length;
  if (bad.length) banner(`${bad.length} session(s) rejected by server, kept on phone: ${bad[0].rejected}`, "err");
  else if (wait) banner(`Saved on phone, will sync (${wait} waiting)`, "");
  else $("#banner").hidden = true;
}
let bt;
function banner(msg, cls, ms) {
  const b = $("#banner"); b.textContent = msg; b.className = cls || ""; b.hidden = false;
  clearTimeout(bt); if (ms) bt = setTimeout(showQueueBanner, ms);
}

// ---------- session logic ----------
function startSession(dayType) {
  let tpl = boot.templates[dayType] || [];
  if (dayType === "Planned") { // today's saved plan: its exercises in the planned order, logged under the plan's day type
    const p = Plan.planFor(boot.plans, today());
    tpl = p ? p.exercises : [];
    dayType = (p && boot.dayTypes.includes(p.dayType) && p.dayType) || boot.dayTypes[0] || "Planned";
  }
  draft = {
    clientId: uid(), dayType, date: today(), notes: "",
    exercises: tpl.map((t) => ({ key: uid(), exerciseId: t.exerciseId, name: t.name, sets: t.sets.map((s) => ({ ...s, done: false })),
      ...(t.targetSets != null || t.targetReps ? { targetSets: t.targetSets, targetReps: t.targetReps } : {}), ...(t.notes ? { tplNotes: t.notes } : {}) })),
  };
  saveDraft(); view = "session"; render();
}
function addExercise(ex) {
  const last = boot.last[ex.id];
  const sets = last ? last.sets.map((s) => ({ ...s, done: false })) : [blankSet()];
  draft.exercises.push({ key: uid(), exerciseId: ex.id, name: ex.name, sets });
}
// Only sets the user confirmed (Done) or edited are saved; untouched prefilled sets are ignored.
function payload() {
  return {
    dayType: draft.dayType, date: draft.date, notes: draft.notes, clientId: draft.clientId,
    exercises: draft.exercises.map((e) => ({
      ...(e.exerciseId ? { exerciseId: e.exerciseId } : { newExercise: e.newExercise }),
      sets: e.sets.filter((s) => s.done && (s.weight != null || s.reps != null)).map((s) => ({ weight: s.weight, reps: s.reps, eachSide: !!s.eachSide })),
    })).filter((e) => e.sets.length),
  };
}
function finish() {
  const p = payload();
  if (!p.exercises.length) return alert("No sets to save. Tap Done on a set (or edit it) to include it.");
  const q = LS.get("queue", []); q.push({ payload: p, at: Date.now() }); LS.set("queue", q); // queue first: never lose data
  draft = null; saveDraft(); view = "home"; render();
  banner("Saved on phone, syncing...", ""); flushQueue();
}

// ---------- views ----------
function render() {
  const app = $("#app");
  const hasPin = !!LS.get("pin");
  $("#tabs").hidden = !hasPin;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.v === tab));
  document.body.classList.toggle("has-tabs", hasPin);
  if (hasPin && tab === "plan") return renderPlan(app);
  if (hasPin && tab === "progress") return renderProgress(app);
  if (hasPin && tab === "history") return renderHistory(app);
  if (!hasPin) { app.innerHTML = `<h1>Workout Log</h1><div class="card"><div class="hint">Enter PIN</div><input id="pin" type="password" inputmode="numeric" autocomplete="off"><div style="height:8px"></div><button class="pri" style="width:100%" data-a="pin">Unlock</button></div>`; return; }
  if (view === "session" && draft) return picker ? renderPicker(app, picker) : renderSession(app);
  renderHome(app);
}
function renderHome(app) {
  const types = [...boot.dayTypes].sort((a, b) => (boot.lastDates[b] || "").localeCompare(boot.lastDates[a] || ""));
  const plan = Plan.planFor(boot.plans, today());
  if (!selDay || !(types.includes(selDay) || (selDay === "Planned" && plan))) selDay = plan ? "Planned" : types[0];
  app.innerHTML = `<h1>Workout Log</h1>
    ${LS.get("draft") ? `<div class="card row sb"><span>Session in progress</span><button class="pri" data-a="resume">Resume</button></div>` : ""}
    <h2>Day type</h2>
    <div class="chips">${plan ? `<button class="chip ${selDay === "Planned" ? "sel" : ""}" data-a="sel" data-v="Planned">Planned<small>${plan.exercises.length} exercises${plan.dayType ? " · " + esc(plan.dayType) : ""}</small></button>` : ""}${types.map((t) => `<button class="chip ${t === selDay ? "sel" : ""}" data-a="sel" data-v="${esc(t)}">${esc(t)}<small>${esc(boot.lastDates[t] || "never")}</small></button>`).join("")}</div>
    <div style="height:12px"></div>
    <button class="pri" style="width:100%;min-height:60px;font-size:20px" data-a="start" ${selDay ? "" : "disabled"}>Start ${esc(selDay || "")}</button>
    <h2>Recent</h2><div class="recent">${boot.recent.map((r) => `<div>${esc(r.name)} <small>${esc(r.date)} · ${r.exerciseCount} exercises</small></div>`).join("") || "<small>No data yet</small>"}</div>`;
}
function stepper(ei, si, field, val, step, pre = "") {
  const at = `data-e="${ei}" data-s="${si}" data-f="${field}"`;
  return `<div class="step"><button data-a="${pre}step" ${at} data-d="-${step}" aria-label="minus">−</button>
    <input inputmode="decimal" data-a="${pre}num" ${at} value="${fmt(val)}" placeholder="${field === "weight" ? "lb" : "reps"}">
    <button data-a="${pre}step" ${at} data-d="${step}" aria-label="plus">+</button></div>`;
}
function renderSession(app) {
  app.innerHTML = `<div class="row sb"><h1>${esc(draft.dayType)}</h1><button class="ghost" data-a="discard">Discard</button></div>
    <div class="hint">${esc(draft.date)}</div>
    ${draft.exercises.map((e, ei) => {
      const last = e.exerciseId && boot.last[e.exerciseId];
      const hist = (e.exerciseId && boot.history[e.exerciseId]) || [];
      return `<div class="card"><div class="row sb"><span class="name">${esc(e.name)}</span><button class="ghost danger" data-a="rmex" data-e="${ei}">✕</button></div>
        ${e.targetSets != null || e.targetReps ? `<div class="hint">Target: ${[e.targetSets, e.targetReps].filter((x) => x != null && x !== "").map(esc).join(" x ")}</div>` : ""}
        ${e.tplNotes ? `<div class="hint"><small>${esc(e.tplNotes)}</small></div>` : ""}
        ${last ? `<div class="hint">Last time (${esc(last.date)}): ${last.sets.map(fmtSet).join(", ")}</div>` : ""}
        ${hist.length ? `<div class="hint">Top sets: ${hist.slice(0, 3).map((h) => esc(h.topSet || "-")).join(" ← ")}${hist[0].bestEst1RM ? ` · est 1RM ${hist[0].bestEst1RM}` : ""}</div>` : ""}
        ${e.sets.map((s, si) => `<div class="set ${s.done ? "done" : ""}">
          <div>${stepper(ei, si, "weight", s.weight, 5)}<span class="lbl">weight (lb)</span></div>
          <div>${stepper(ei, si, "reps", s.reps, 1)}<span class="lbl">reps</span></div>
          <div class="tools"><button data-a="done" class="${s.done ? "on" : ""}" data-e="${ei}" data-s="${si}">${s.done ? "✓ Done" : "Done?"}</button>
          <button class="${s.eachSide ? "on" : ""}" data-a="side" data-e="${ei}" data-s="${si}">Each side</button>
          <button class="danger" data-a="rmset" data-e="${ei}" data-s="${si}">Delete</button></div></div>`).join("")}
        <div style="height:10px"></div><button data-a="addset" data-e="${ei}" style="width:100%">+ Add set</button></div>`;
    }).join("")}
    <button data-a="picker" style="width:100%">+ Add exercise</button>
    <div style="height:10px"></div><input id="notes" placeholder="Session notes (optional)" value="${esc(draft.notes)}">
    <div class="bar"><div class="in"><button class="pri" data-a="finish">Finish &amp; save</button></div></div>`;
}
function renderPicker(app, picker, pre = "") {
  if (picker.adding) {
    app.innerHTML = `<h1>New exercise</h1><input id="nx-name" placeholder="Name" value="${esc(picker.q)}"><div style="height:8px"></div>
      <select id="nx-muscle"><option value="">Muscle group (optional)</option>${["Chest","Back","Biceps","Triceps","Shoulders","Forearms","Quads","Glutes","Hamstrings","Calves","Core","Cardio"].map((m) => `<option>${m}</option>`).join("")}</select>
      <div style="height:12px"></div><button class="pri" style="width:100%" data-a="${pre}nx-save">Add</button><div style="height:8px"></div><button style="width:100%" data-a="${pre}pick-close">Cancel</button>`;
    return;
  }
  const q = picker.q.toLowerCase();
  const list = boot.exercises.filter((e) => e.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  app.innerHTML = `<div class="row"><input id="pq" placeholder="Search exercises" value="${esc(picker.q)}"><button data-a="${pre}pick-close">Close</button></div>
    <div class="list" style="margin-top:8px">${picker.noNew ? "" : `<button class="pri" data-a="${pre}nx-open">+ New exercise</button>`}
    ${list.map((e) => `<button data-a="${pre}pick" data-v="${esc(e.id)}">${esc(e.name)} <small>${esc(e.muscle)}</small></button>`).join("")}</div>`;
  const pq = $("#pq"); pq.focus(); pq.setSelectionRange(pq.value.length, pq.value.length);
}

// ---------- plan tab ----------
// Plan a future day: pick a date, build the exercise list (optionally from a template), reorder with up/down, save.
// Saved plans show on the Log tab on that date as "Planned". State survives tab switches (in memory only).
const pl = { date: null, dayType: "", list: [], saved: null, loading: false, err: "", saving: false, msg: "", picker: null, offline: false, init: false };
const planDirty = () => pl.init && !pl.loading && Plan.dirty(pl.saved, pl.dayType, pl.list);
const defaultDayType = () => (boot.dayTypes.includes(pl.dayType) && pl.dayType) || boot.dayTypes[0] || "";
function applyPlan(p) { // p: {dayType, exercises} or null -> editor state
  pl.saved = p && p.exercises.length ? { dayType: p.dayType, exercises: p.exercises } : null;
  pl.list = Plan.fromTemplate(p ? p.exercises : []);
  pl.dayType = (p && boot.dayTypes.includes(p.dayType) && p.dayType) || defaultDayType();
  pl.saved && (pl.saved.dayType = pl.dayType);
}
async function loadPlan(date) {
  pl.date = date; pl.loading = true; pl.err = ""; pl.msg = ""; pl.offline = false; render();
  try {
    const d = await api("/api/plan?date=" + encodeURIComponent(date));
    if (pl.date !== date) return;
    applyPlan(d.exists ? d : null);
  } catch (e) {
    if (e.auth || pl.date !== date) return;
    if (!navigator.onLine || !e.status) { pl.offline = true; applyPlan(Plan.planFor(boot.plans, date)); }
    else pl.err = "Could not load the plan. " + (e.message || "");
  }
  pl.loading = false; if (tab === "plan") render();
}
function renderPlan(app) {
  if (pl.picker) return renderPicker(app, pl.picker, "pl");
  if (!pl.init) { pl.init = true; return void loadPlan(Plan.tomorrow(today())); }
  const upcoming = Object.values(boot.plans || {}).filter((p) => p.date >= today() && p.exercises.length).sort((a, b) => (a.date < b.date ? -1 : 1));
  const head = `<h1>Plan</h1><div class="card"><label class="lbl" for="pldate">Date</label><input id="pldate" type="date" value="${esc(pl.date)}" min="${esc(today())}">
    ${upcoming.length ? `<div class="fchips">${upcoming.map((p) => `<button class="${p.date === pl.date ? "on" : ""}" data-a="pldate" data-v="${esc(p.date)}">${esc(Hist.dateLabel(p.date))}</button>`).join("")}</div>` : ""}</div>`;
  if (pl.loading) { app.innerHTML = head + `<div class="card hint">Loading...</div>`; return; }
  if (pl.err) { app.innerHTML = head + `<div class="card">${esc(pl.err)}<div style="height:8px"></div><button class="pri" data-a="plretry" style="width:100%">Retry</button></div>`; return; }
  const n = pl.list.length, dirty = planDirty();
  app.innerHTML = head + `${pl.offline ? `<div class="note">Offline, showing the last saved copy. Saving needs a connection.</div>` : ""}
    <div class="card">
      <label class="lbl" for="plday">Log it as (day type)</label>
      <select id="plday">${boot.dayTypes.map((t) => `<option ${t === pl.dayType ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
      <div style="height:8px"></div><label class="lbl" for="pltpl">Start from</label>
      <select id="pltpl"><option value="">Choose a template (replaces the list)...</option><option value="__blank">Blank</option>${Object.keys(boot.templates).sort().map((t) => `<option>${esc(t)}</option>`).join("")}</select>
    </div>
    ${pl.list.map((e, i) => `<div class="card"><div class="row sb"><span class="name">${esc(e.name)}</span>
        <span class="row"><button data-a="plup" data-e="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button><button data-a="pldown" data-e="${i}" ${i === n - 1 ? "disabled" : ""} aria-label="Move down">↓</button><button class="ghost danger" data-a="plrm" data-e="${i}" aria-label="Remove">✕</button></span></div>
        <div class="row" style="margin-top:8px"><div style="flex:1"><input inputmode="numeric" data-a="plsets" data-e="${i}" value="${e.targetSets ?? ""}" placeholder="sets"><span class="lbl">target sets</span></div>
        <div style="flex:1"><input data-a="plreps" data-e="${i}" value="${esc(e.targetReps)}" placeholder="e.g. 8-12" maxlength="40"><span class="lbl">target reps</span></div></div></div>`).join("") || `<div class="hint" style="padding:12px 4px">No exercises planned for this day yet.</div>`}
    <button data-a="plpicker" style="width:100%">+ Add exercise</button>
    <div style="height:12px"></div>
    ${pl.saved ? `<button class="delbtn" data-a="pldelete" style="width:100%" ${pl.saving ? "disabled" : ""}>Delete this plan</button>` : ""}
    <div class="bar"><div class="in">${pl.msg ? `<div class="msg">${esc(pl.msg)}</div>` : ""}<button class="pri" data-a="plsave" ${dirty && n && !pl.saving ? "" : "disabled"}>${pl.saving ? "Saving..." : pl.saved && !dirty ? "Saved" : "Save plan"}</button></div></div>`;
}
async function savePlan() {
  if (pl.saving || !pl.list.length) return;
  if (!navigator.onLine) { pl.msg = "You're offline, saving a plan needs a connection."; return render(); }
  pl.saving = true; pl.msg = ""; render();
  const date = pl.date;
  try {
    const d = await api("/api/plan", { method: "PUT", body: JSON.stringify(Plan.toBody(date, pl.dayType, pl.list)) });
    if (pl.date === date) applyPlan(d.exists ? d : null);
    boot.plans = { ...(boot.plans || {}) };
    if (d.exists) boot.plans[date] = { date, dayType: d.dayType, exercises: d.exercises.map((e) => ({ ...e, sets: [] })) }; else delete boot.plans[date];
    toast("Plan saved to Notion", "ok"); loadBootstrap();
  } catch (e) {
    if (e.auth) return;
    pl.msg = e.status === 400 ? e.message : "Could not save (" + (e.message || "network error") + "). Your plan is still here, tap Save to retry.";
  }
  pl.saving = false; if (tab === "plan") render();
}
async function deletePlan() {
  if (pl.saving || !pl.saved || !confirm("Delete the plan for " + Hist.dateLabel(pl.date) + "? It can be restored from Notion's trash.")) return;
  if (!navigator.onLine) { pl.msg = "You're offline, deleting a plan needs a connection."; return render(); }
  pl.saving = true; pl.msg = ""; render();
  const date = pl.date;
  try {
    await api("/api/plan?date=" + encodeURIComponent(date), { method: "DELETE" });
    boot.plans = { ...(boot.plans || {}) }; delete boot.plans[date];
    if (pl.date === date) applyPlan(null);
    toast("Plan deleted", "ok"); loadBootstrap();
  } catch (e) { if (e.auth) return; pl.msg = "Could not delete (" + (e.message || "network error") + ")."; }
  pl.saving = false; if (tab === "plan") render();
}
/** Click handler for Plan actions (all prefixed "pl"). Returns true when handled. */
function planClick(a, t) {
  if (a === "plpick-close") { pl.picker = null; render(); return true; }
  if (a === "plpick") {
    const ex = boot.exercises.find((e) => e.id === t.dataset.v); pl.picker = null;
    if (ex && pl.list.some((e) => e.exerciseId === ex.id)) toast(ex.name + " is already planned"); else if (ex) pl.list = Plan.add(pl.list, ex);
    render(); window.scrollTo(0, document.body.scrollHeight); return true;
  }
  const sv = window.scrollY;
  if (a === "pldate") { if (planDirty() && !confirm("Discard your unsaved changes to this plan?")) return true; loadPlan(t.dataset.v); return true; }
  if (a === "plretry") { loadPlan(pl.date); return true; }
  if (a === "plpicker") { pl.picker = { q: "", noNew: true }; render(); window.scrollTo(0, 0); return true; }
  if (a === "plsave") { savePlan(); return true; }
  if (a === "pldelete") { deletePlan(); return true; }
  if (a === "plup" || a === "pldown") pl.list = Plan.move(pl.list, +t.dataset.e, a === "plup" ? -1 : 1);
  else if (a === "plrm") pl.list = Plan.remove(pl.list, +t.dataset.e);
  else return false;
  pl.msg = ""; render(); window.scrollTo(0, sv); return true;
}
/** Input handler for Plan fields. Returns true when handled. */
function planInput(t) {
  if (tab !== "plan") return false;
  if (t.id === "pldate") {
    if (!t.value) return true;
    if (planDirty() && !confirm("Discard your unsaved changes to this plan?")) { t.value = pl.date; return true; }
    loadPlan(t.value); return true;
  }
  if (t.id === "plday") { pl.dayType = t.value; pl.msg = ""; render(); return true; }
  if (t.id === "pltpl") {
    const v = t.value; if (!v) return true;
    if (pl.list.length && !confirm("Replace the current list?")) { t.value = ""; return true; }
    pl.list = v === "__blank" ? [] : Plan.fromTemplate(boot.templates[v]);
    if (boot.dayTypes.includes(v)) pl.dayType = v;
    pl.msg = ""; render(); return true;
  }
  if (t.id === "pq" && pl.picker) { pl.picker.q = t.value; render(); return true; }
  if (t.dataset.a === "plsets") { const v = t.value.trim(); pl.list[+t.dataset.e].targetSets = /^\d+$/.test(v) ? Math.min(30, Math.max(1, +v)) : null; }
  else if (t.dataset.a === "plreps") pl.list[+t.dataset.e].targetReps = t.value;
  else return false;
  pl.msg = "";
  const b = document.querySelector("[data-a=plsave]"); if (b && pl.list.length && !pl.saving) { b.disabled = false; b.textContent = "Save plan"; }
  return true;
}

// ---------- progress tab ----------
const RANGES = [["3m", "3 months"], ["6m", "6 months"], ["1y", "1 year"], ["all", "All"]];
const dateLbl = (s) => Charts.fmtDate(s, !!s && s.slice(0, 4) !== today().slice(0, 4));
const signed = (n, unit = "") => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Charts.fmtNum(Math.abs(n))}${unit ? " " + unit : ""}`;

/** Per-exercise summary for the list (bootstrap.summary, with a fallback for older cached data). */
function summaryOf(e) {
  const s = boot.summary && boot.summary[e.id];
  if (s) return s;
  const l = boot.last[e.id], h = boot.history[e.id] || [];
  return l ? { lastDate: l.date, bestWeight: Math.max(0, ...h.map((x) => x.bestWeight || 0)), sessions: h.length, sets: 0 } : null;
}
function listHtml() {
  const q = prog.q.trim().toLowerCase();
  const rows = boot.exercises.filter((e) => !q || e.name.toLowerCase().includes(q)).map((e) => ({ e, s: summaryOf(e) }));
  const logged = rows.filter((r) => r.s), never = rows.filter((r) => !r.s).sort((a, b) => a.e.name.localeCompare(b.e.name));
  const groups = {};
  for (const r of logged) (groups[r.e.muscle || "Other"] ||= []).push(r);
  const row = (r, dim) => `<button class="xrow${dim ? " dim" : ""}" data-a="pex" data-v="${esc(r.e.id)}"><span class="xn">${esc(r.e.name)}</span>
    <span class="xs">${r.s ? `<b>${r.s.bestWeight ? fmt(r.s.bestWeight) + " lb" : "BW"}</b><small>${esc(dateLbl(r.s.lastDate))}</small>` : "<small>never logged</small>"}</span></button>`;
  let h = Object.keys(groups).sort((a, b) => (a === "Other") - (b === "Other") || a.localeCompare(b)).map((g) =>
    `<h2>${esc(g)}</h2>` + groups[g].sort((a, b) => (b.s.lastDate || "").localeCompare(a.s.lastDate || "") || a.e.name.localeCompare(b.e.name)).map((r) => row(r)).join("")).join("");
  if (never.length) {
    if (prog.showAll || q) h += `<h2>Never logged</h2>` + never.map((r) => row(r, true)).join("");
    else h += `<button class="ghost" style="width:100%;margin-top:16px" data-a="pshow">Show ${never.length} never logged</button>`;
  }
  return h || `<div class="hint" style="padding:20px 4px">${logged.length + never.length ? "No matches" : "No exercises yet"}</div>`;
}
function renderProgress(app) {
  if (!prog.ex) {
    app.innerHTML = `<h1>Progress</h1><input id="pfind" type="search" placeholder="Search exercises" value="${esc(prog.q)}" autocomplete="off"><div class="list" id="plist">${listHtml()}</div>`;
    window.scrollTo(0, prog.scroll || 0);
    return;
  }
  const ex = boot.exercises.find((e) => e.id === prog.ex);
  const hist = histMem[prog.ex];
  const head = `<div class="row dhead"><button data-a="pback" aria-label="Back">‹ Back</button><div><div class="name">${esc(ex ? ex.name : "Exercise")}</div><div class="hint">${esc(ex ? [ex.muscle, ex.equipment].filter(Boolean).join(" · ") : "")}</div></div></div>`;
  if (!hist) {
    app.innerHTML = head + (prog.err ? `<div class="card">${esc(prog.err)}<div style="height:8px"></div><button class="pri" data-a="pretry" style="width:100%">Retry</button></div>` : `<div class="card hint">Loading...</div>`);
    return;
  }
  const all = Charts.buildSeries(hist.sessions);
  if (!all.length) { app.innerHTML = head + `<div class="card hint">No sets logged for this exercise yet.</div>`; return; }
  const sm = Charts.summarize(all), bw = sm.bodyweight;
  const pts = Charts.filterRange(all, prog.range, today());
  const stat = (l, v) => `<div class="stat"><b>${esc(v)}</b><small>${esc(l)}</small></div>`;
  const stats = [bw ? stat("Best reps", sm.bestReps) : stat("Best weight", fmt(sm.bestWeight) + " lb"), bw ? stat("Total reps", all.reduce((a, p) => a + p.totalReps, 0)) : stat("Best est. 1RM", sm.bestEst1RM ? sm.bestEst1RM + " lb" : "-"),
    stat("Total sets", sm.totalSets), stat("Last done", dateLbl(sm.lastDate)), stat("Sessions", sm.sessions)].join("");
  const defs = bw
    ? [["reps", "Best reps per session", "bestReps", "line", "reps"], ["vol", "Total reps per session", "totalReps", "bar", "reps"]]
    : [["w", "Top set weight", "weight", "line", "lb"], ["e", "Estimated 1RM", "est1RM", "line", "lb"], ["v", "Volume per session", "volume", "bar", "lb"]];
  prog.charts = {};
  const charts = defs.map(([k, title, key, kind, unit]) => { prog.charts[k] = { title, key, kind, unit, series: Charts.metric(pts, key) }; return `<div class="card"><div class="name sm">${esc(title)}</div><div class="cc" data-k="${k}">${chartInner(k)}</div></div>`; }).join("");
  const prKey = bw ? "bestReps" : "weight", prs = Charts.detectPRs(all, prKey);
  const prHtml = prs.slice(0, 10).map((p) => `<div class="pr"><span>${esc(dateLbl(p.date))}</span><b>${bw ? fmt(p.value) + " reps" : fmt(p.value) + " lb x " + fmt(p.reps)}</b><small class="${p.gain ? "up" : ""}">${p.gain ? signed(p.gain) : "first"}</small></div>`).join("");
  app.innerHTML = head + (prog.offline ? `<div class="note">Offline, showing saved data</div>` : "") + `<div class="stats">${stats}</div>
    <div class="seg">${RANGES.map(([v, l]) => `<button data-a="prange" data-v="${v}" class="${prog.range === v ? "on" : ""}">${l}</button>`).join("")}</div>
    ${charts}<div class="card"><div class="name sm">${bw ? "Rep records" : "Personal records"}</div>${prHtml}${prs.length > 10 ? `<div class="hint">+${prs.length - 10} older</div>` : ""}</div>`;
}
/** Inner HTML of one chart card: trend line, svg, info line for the selected (default: latest) point. */
function chartInner(k) {
  const c = prog.charts[k], sr = c.series;
  if (sr.length < 2) {
    const one = sr[0];
    return `<div class="empty">Not enough data yet${prog.range !== "all" && !sr.length ? " in this range" : ""}</div>${one ? `<div class="info">${esc(infoText(c, one))}</div>` : ""}`;
  }
  const i = prog.sel[k] != null && prog.sel[k] < sr.length ? prog.sel[k] : sr.length - 1;
  const tr = c.kind === "bar" ? null : Charts.trend(sr);
  const since = prog.range === "all" ? "since first logged" : `since ${dateLbl(tr && tr.firstDate)}`;
  const chart = Charts.chartSvg(sr, { kind: c.kind, selected: i, label: c.title });
  c.xs = chart.xs; c.w = chart.width;
  return `${tr ? `<div class="trend"><b class="${tr.sinceFirstDir}">${signed(tr.sinceFirst, c.unit)}</b> ${esc(since)} <span class="sep">·</span> <span class="${tr.vsPrevDir}">${signed(tr.vsPrev)} vs previous</span></div>` : ""}
    <div class="plot" data-a="chart" data-k="${k}">${chart.svg}</div><div class="info">${esc(infoText(c, sr[i]))}</div>`;
}
function infoText(c, pt) {
  const p = pt.p, d = dateLbl(pt.date);
  if (c.key === "weight") return `${d}: ${fmt(p.weight)} lb x ${fmt(p.reps)}${p.sets > 1 ? ` (${p.sets} sets)` : ""}`;
  if (c.key === "est1RM") return `${d}: est. 1RM ${p.est1RM} lb${p.weight ? ` (top set ${fmt(p.weight)} x ${fmt(p.reps)})` : ""}`;
  if (c.key === "volume") return `${d}: ${p.volume.toLocaleString("en-US")} lb total, ${p.sets} sets`;
  if (c.key === "bestReps") return `${d}: best set ${p.bestReps} reps (${p.sets} sets)`;
  return `${d}: ${p.totalReps} reps in ${p.sets} sets`;
}
async function openExercise(id) {
  prog.scroll = window.scrollY; prog.ex = id; prog.sel = {}; prog.err = ""; prog.offline = false;
  const cached = histMem[id] || LS.get("hist:" + id);
  if (cached) histMem[id] = cached;
  render(); window.scrollTo(0, 0);
  try {
    const d = await api("/api/history?exerciseId=" + encodeURIComponent(id));
    histMem[id] = d; try { LS.set("hist:" + id, d); } catch (e) { /* storage full: ignore */ }
    prog.offline = false;
  } catch (e) {
    if (e.auth) return;
    if (cached) prog.offline = true; else prog.err = "Could not load history (offline?). " + (e.message || "");
  }
  if (prog.ex === id && tab === "progress") render();
}

// ---------- history tab ----------
const hist = { list: LS.get("hlist", null), q: "", day: null, err: "", offline: false, scroll: 0 };
let ed = null; // session editor: {id, loading, err, orig, cur, saving, msg, picker, confirmDel, deleting}
const OFFLINE_MSG = "You're offline, editing needs a connection.";
const editorDirty = () => !!(ed && ed.cur && ed.orig && Hist.countChanges(ed.orig, ed.cur) > 0);

let toastTimer;
function toast(msg, cls = "") {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = msg; el.className = "show " + cls;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = ""; }, 3000);
}

async function loadHistoryList() {
  try {
    const d = await api("/api/sessions");
    hist.list = d.sessions; hist.err = ""; hist.offline = false;
    try { LS.set("hlist", hist.list); } catch (e) { /* storage full: ignore */ }
  } catch (e) {
    if (e.auth) return;
    if (hist.list) hist.offline = true; else hist.err = "Could not load sessions. " + (e.message || "");
  }
  if (tab === "history" && !ed) refreshHistBody();
}
function refreshHistBody() {
  const b = $("#hbody");
  if (b) b.innerHTML = histBody(); else render();
}
function histBody() {
  if (!hist.list) return hist.err ? `<div class="card">${esc(hist.err)}<div style="height:8px"></div><button class="pri" data-a="hretry" style="width:100%">Retry</button></div>` : `<div class="card hint">Loading...</div>`;
  const types = [...new Set(hist.list.map((s) => s.dayType).filter(Boolean))];
  const shown = Hist.filterList(hist.list, hist.q, hist.day);
  const note = hist.offline || !navigator.onLine ? `<div class="note">Offline, showing the last saved list. Editing needs a connection.</div>` : "";
  const chips = types.length > 1 ? `<div class="fchips"><button class="${hist.day ? "" : "on"}" data-a="hday" data-v="">All</button>${types.map((t) => `<button class="${hist.day === t ? "on" : ""}" data-a="hday" data-v="${esc(t)}">${esc(t)}</button>`).join("")}</div>` : "";
  const groups = Hist.groupByMonth(shown).map((g) => `<h2>${esc(g.label)}</h2>` + g.items.map((s) => `<button class="hrow" data-a="hopen" data-v="${esc(s.id)}">
      <span class="hr1"><b>${esc(Hist.dateLabel(s.date))}</b><span class="hday">${esc(s.dayType || "-")}</span></span>
      <span class="hr2">${Hist.plural(s.exercises.length, "exercise")}, ${Hist.plural(s.setCount, "set")}${s.volume ? ` · ${s.volume.toLocaleString("en-US")} lb` : ""}</span>
      <span class="hr3">${esc(Hist.exerciseSummary(s.exercises))}</span></button>`).join("")).join("");
  return note + chips + (groups || `<div class="hint" style="padding:20px 4px">${hist.list.length ? "No matches" : "No sessions yet"}</div>`);
}
function renderHistory(app) {
  if (ed) return renderEditor(app);
  app.innerHTML = `<h1>History</h1><input id="hfind" type="search" placeholder="Search day type or exercise" value="${esc(hist.q)}" autocomplete="off"><div id="hbody">${histBody()}</div>`;
  window.scrollTo(0, hist.scroll || 0);
  if (!hist.list && !hist.err) loadHistoryList();
}

// ---- session editor ----
const cloneSets = (sets) => sets.map((s) => ({ key: uid(), id: s.id, weight: s.weight, reps: s.reps, eachSide: !!s.eachSide, notes: s.notes || "" }));
function resetEdit() {
  const o = ed.orig;
  ed.cur = { date: o.date, dayType: o.dayType, notes: o.notes, exercises: o.exercises.map((e) => ({ key: uid(), exerciseId: e.exerciseId, name: e.name, sets: cloneSets(e.sets) })) };
}
async function openSession(id) {
  hist.scroll = window.scrollY;
  ed = { id, loading: true, err: "", orig: null, cur: null, saving: false, msg: "", picker: null, confirmDel: false, deleting: false };
  render(); window.scrollTo(0, 0);
  await loadSessionDetail();
}
async function loadSessionDetail() {
  const mine = ed; if (!mine) return;
  mine.loading = true; mine.err = "";
  if (!navigator.onLine) { mine.loading = false; mine.err = OFFLINE_MSG; return render(); }
  try {
    mine.orig = await api("/api/session?id=" + encodeURIComponent(mine.id));
    resetEdit();
  } catch (e) {
    if (e.auth) return;
    mine.err = e.status === 404 ? "This session no longer exists." : "Could not load this session. " + (e.message || "");
  }
  mine.loading = false;
  if (ed === mine && tab === "history") render();
}
function closeEditor() {
  if (editorDirty() && !confirm("Leave without saving your changes?")) return;
  ed = null; render();
}
const edHead = (title) => `<div class="row dhead"><button data-a="hback" aria-label="Back">‹ Back</button><div><div class="name">${esc(title)}</div></div></div>`;
function renderEditor(app) {
  if (ed.picker) return renderPicker(app, ed.picker, "h");
  if (ed.loading) { app.innerHTML = edHead("Session") + `<div class="card hint">Loading...</div>`; return; }
  if (ed.err) { app.innerHTML = edHead("Session") + `<div class="card">${esc(ed.err)}<div style="height:8px"></div><button class="pri" data-a="hreload" style="width:100%">Retry</button></div>`; return; }
  const c = ed.cur, types = boot.dayTypes.includes(c.dayType) || !c.dayType ? boot.dayTypes : [...boot.dayTypes, c.dayType];
  const nSets = ed.orig.exercises.reduce((n, e) => n + e.sets.length, 0);
  app.innerHTML = edHead(ed.orig.name || "Session") + `
    ${navigator.onLine ? "" : `<div class="note">${OFFLINE_MSG}</div>`}
    <div class="card">
      <label class="lbl" for="hdate">Date</label><input id="hdate" type="date" value="${esc(c.date)}">
      <div style="height:8px"></div><label class="lbl" for="hday">Day type</label>
      <select id="hday">${types.map((t) => `<option ${t === c.dayType ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
      <div style="height:8px"></div><label class="lbl" for="hnotes">Notes</label>
      <textarea id="hnotes" rows="2" placeholder="Session notes (optional)" maxlength="1500">${esc(c.notes)}</textarea>
    </div>
    ${c.exercises.map((e, ei) => `<div class="card"><div class="row sb"><span class="name">${esc(e.name)}</span><button class="ghost danger" data-a="hrmex" data-e="${ei}" aria-label="Remove exercise">✕</button></div>
      ${e.sets.map((s, si) => `<div class="set">
        <div>${stepper(ei, si, "weight", s.weight, 5, "h")}<span class="lbl">weight (lb)</span></div>
        <div>${stepper(ei, si, "reps", s.reps, 1, "h")}<span class="lbl">reps</span></div>
        <div class="tools"><span class="sn">Set ${si + 1}</span>
          <button data-a="hside" class="${s.eachSide ? "on" : ""}" data-e="${ei}" data-s="${si}">Each side</button>
          <button class="danger" data-a="hrmset" data-e="${ei}" data-s="${si}">Delete</button></div></div>`).join("")}
      <div style="height:10px"></div><button data-a="haddset" data-e="${ei}" style="width:100%">+ Add set</button></div>`).join("")}
    <button data-a="hpicker" style="width:100%">+ Add exercise</button>
    <div style="height:28px"></div>
    ${ed.confirmDel ? `<div class="card delbox" id="delbox"><div>Delete this session and its ${nSets} sets? It can be restored from Notion's trash.</div><div class="row" style="margin-top:12px">
        <button data-a="hdel-no" style="flex:1" ${ed.deleting ? "disabled" : ""}>Cancel</button>
        <button class="dangerfill" data-a="hdel-yes" style="flex:1" ${ed.deleting ? "disabled" : ""}>${ed.deleting ? "Deleting..." : "Yes, delete"}</button></div></div>`
      : `<button class="delbtn" data-a="hdel" style="width:100%">Delete session</button>`}
    <div class="bar" id="hbar"></div>`;
  updateBar();
}
function updateBar() {
  const bar = $("#hbar"); if (!bar || !ed || !ed.cur) return;
  const n = Hist.countChanges(ed.orig, ed.cur);
  bar.innerHTML = `<div class="in">${ed.msg ? `<div class="msg">${esc(ed.msg)}</div>` : ""}
    <button data-a="hdiscard" ${n && !ed.saving ? "" : "disabled"}>Discard</button>
    <button class="pri" data-a="hsave" ${n && !ed.saving ? "" : "disabled"}>${ed.saving ? "Saving..." : n ? `Save changes (${n})` : "No changes"}</button></div>`;
}
const edSet = (t) => ed.cur.exercises[+t.dataset.e].sets[+t.dataset.s];
const newSet = (p) => ({ key: uid(), weight: p ? p.weight : null, reps: p ? p.reps : null, eachSide: p ? !!p.eachSide : false, notes: "" });

async function saveEdit() {
  if (!ed || ed.saving || !editorDirty()) return;
  if (!ed.cur.date) { ed.msg = "Pick a date first."; return updateBar(); }
  if (!navigator.onLine) { ed.msg = OFFLINE_MSG; return updateBar(); }
  const mine = ed; mine.saving = true; mine.msg = ""; updateBar();
  const hadNew = mine.cur.exercises.some((e) => !e.exerciseId);
  try {
    const d = await api("/api/session?id=" + encodeURIComponent(mine.id), { method: "PATCH", body: JSON.stringify(Hist.toPatchBody(mine.cur)) });
    if (hist.list) { hist.list = Hist.sortList(hist.list.map((s) => (s.id === d.id ? Hist.summaryFromDetail(d) : s))); try { LS.set("hlist", hist.list); } catch (e) { /* ignore */ } }
    if (ed === mine) { ed = null; render(); }
    toast("Saved to Notion", "ok");
    loadHistoryList(); if (hadNew) loadBootstrap();
  } catch (e) {
    mine.saving = false;
    if (e.auth) return;
    mine.msg = e.status === 400 || e.status === 404 ? e.message : "Could not save (" + (e.message || "network error") + "). Your edits are still here, tap Save to retry.";
    if (ed === mine) updateBar();
  }
}
async function deleteEdit() {
  if (!ed || ed.deleting) return;
  if (!navigator.onLine) { ed.msg = OFFLINE_MSG; ed.confirmDel = false; return render(); }
  const mine = ed; mine.deleting = true; mine.msg = ""; render();
  try {
    const d = await api("/api/session?id=" + encodeURIComponent(mine.id), { method: "DELETE" });
    if (hist.list) { hist.list = hist.list.filter((s) => s.id !== mine.id); try { LS.set("hlist", hist.list); } catch (e) { /* ignore */ } }
    if (ed === mine) { ed = null; render(); }
    toast(`Deleted session and ${d.setCount} sets`, "ok");
    loadHistoryList(); loadBootstrap();
  } catch (e) {
    mine.deleting = false; mine.confirmDel = false;
    if (e.auth) return;
    mine.msg = "Could not delete (" + (e.message || "network error") + ").";
    if (ed === mine) { render(); }
  }
}

/** Click handler for History actions (all prefixed "h"). Returns true when handled. */
async function histClick(a, t) {
  const sv = window.scrollY;
  if (a === "hopen") { openSession(t.dataset.v); return true; }
  if (a === "hday") { hist.day = t.dataset.v || null; refreshHistBody(); return true; }
  if (a === "hretry") { hist.err = ""; hist.list = LS.get("hlist", null); render(); loadHistoryList(); return true; }
  if (!a.startsWith("h") || !ed) return false;
  if (a === "hback") { closeEditor(); return true; }
  if (a === "hreload") { render(); loadSessionDetail(); return true; }
  if (a === "hsave") { saveEdit(); return true; }
  if (a === "hdiscard") { if (confirm("Discard all your changes to this session?")) { resetEdit(); ed.msg = ""; render(); window.scrollTo(0, sv); } return true; }
  if (a === "hpick-close") { ed.picker = null; render(); return true; }
  if (a === "hnx-open") { ed.picker.adding = true; ed.picker.q = $("#pq").value; render(); return true; }
  if (a === "hnx-save") {
    const name = $("#nx-name").value.trim(); if (!name) return true;
    const dup = ed.cur.exercises.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (dup) { ed.picker = null; render(); toast(name + " is already in this session"); return true; }
    ed.cur.exercises.push({ key: uid(), name, newExercise: { name, muscle: $("#nx-muscle").value || undefined }, sets: [newSet()] });
    ed.picker = null; render(); window.scrollTo(0, document.body.scrollHeight); return true;
  }
  if (a === "hpick") {
    const ex = boot.exercises.find((e) => e.id === t.dataset.v); ed.picker = null;
    if (ex && ed.cur.exercises.some((e) => e.exerciseId === ex.id)) { render(); toast(ex.name + " is already in this session"); return true; }
    if (ex) ed.cur.exercises.push({ key: uid(), exerciseId: ex.id, name: ex.name, sets: [newSet()] });
    render(); window.scrollTo(0, document.body.scrollHeight); return true;
  }
  if (!ed.cur) return false;
  if (a === "hpicker") { ed.picker = { q: "" }; render(); window.scrollTo(0, 0); return true; }
  if (a === "hdel") { ed.confirmDel = true; render(); const b = $("#delbox"); if (b) b.scrollIntoView({ block: "center" }); return true; }
  if (a === "hdel-no") { ed.confirmDel = false; render(); window.scrollTo(0, sv); return true; }
  if (a === "hdel-yes") { deleteEdit(); return true; }
  if (a === "hstep") {
    const s = edSet(t), f = t.dataset.f, d = +t.dataset.d;
    s[f] = Math.max(0, Math.round(((+s[f] || 0) + d) * 10) / 10);
    t.parentElement.querySelector("input").value = fmt(s[f]); updateBar(); return true;
  }
  if (a === "hside") { const s = edSet(t); s.eachSide = !s.eachSide; t.classList.toggle("on", s.eachSide); updateBar(); return true; }
  if (a === "haddset") { const ss = ed.cur.exercises[+t.dataset.e].sets; ss.push(newSet(ss[ss.length - 1])); }
  else if (a === "hrmset") ed.cur.exercises[+t.dataset.e].sets.splice(+t.dataset.s, 1);
  else if (a === "hrmex") {
    const e = ed.cur.exercises[+t.dataset.e];
    if (!confirm(`Remove ${e.name} and its ${e.sets.length} set(s) from this session?`)) return true;
    ed.cur.exercises.splice(+t.dataset.e, 1);
  } else return false;
  render(); window.scrollTo(0, sv); return true;
}
/** Input handler for History fields. Returns true when handled. */
function histInput(t) {
  if (tab !== "history") return false;
  if (t.id === "hfind") { hist.q = t.value; refreshHistBody(); return true; }
  if (!ed) return false;
  if (t.id === "pq" && ed.picker) { ed.picker.q = t.value; render(); return true; }
  if (!ed.cur) return false;
  if (t.id === "hdate") ed.cur.date = t.value;
  else if (t.id === "hday") ed.cur.dayType = t.value;
  else if (t.id === "hnotes") ed.cur.notes = t.value;
  else if (t.dataset.a === "hnum") { const v = t.value.replace(",", ".").trim(); edSet(t)[t.dataset.f] = v === "" || isNaN(+v) || +v < 0 ? null : +v; }
  else return false;
  ed.msg = ""; updateBar(); return true;
}

// ---------- events ----------
const setOf = (t) => draft.exercises[+t.dataset.e].sets[+t.dataset.s];
document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("[data-a]"); if (!t) return;
  const a = t.dataset.a;
  if (a === "num" || a === "hnum") return;
  if (a === "pin") { const v = $("#pin").value.trim(); if (!v) return; LS.set("pin", v); render(); await loadBootstrap(); flushQueue(); return; }
  if (a === "sel") { selDay = t.dataset.v; return render(); }
  if (a === "tab") {
    if (tab === "history" && t.dataset.v !== "history" && ed) { if (editorDirty() && !confirm("Leave without saving your changes?")) return; ed = null; }
    tab = t.dataset.v; render();
    if (tab === "history" && !ed) loadHistoryList();
    return;
  }
  if (a.startsWith("pl") && planClick(a, t)) return;
  if (a[0] === "h" && (await histClick(a, t))) return;
  if (a === "pex") return openExercise(t.dataset.v);
  if (a === "pback") { prog.ex = null; return render(); }
  if (a === "pretry") return openExercise(prog.ex);
  if (a === "pshow") { prog.showAll = true; return render(); }
  if (a === "prange") { prog.range = t.dataset.v; prog.sel = {}; const y = window.scrollY; render(); window.scrollTo(0, y); return; }
  if (a === "chart") {
    const c = prog.charts && prog.charts[t.dataset.k]; if (!c || !c.xs) return;
    const r = t.getBoundingClientRect();
    prog.sel[t.dataset.k] = Charts.nearest(c.xs, ((ev.clientX - r.left) / r.width) * c.w);
    t.closest(".cc").innerHTML = chartInner(t.dataset.k); return;
  }
  if (a === "start") return startSession(selDay);
  if (a === "resume") { draft = LS.get("draft"); view = "session"; return render(); }
  if (a === "discard") { if (confirm("Discard this session?")) { draft = null; saveDraft(); view = "home"; render(); } return; }
  if (a === "finish") return finish();
  if (a === "picker") { picker = { q: "" }; return render(); }
  if (a === "pick-close") { picker = null; return render(); }
  if (a === "nx-open") { picker.adding = true; picker.q = $("#pq").value; return render(); }
  if (a === "nx-save") {
    const name = $("#nx-name").value.trim(); if (!name) return;
    draft.exercises.push({ key: uid(), name, newExercise: { name, muscle: $("#nx-muscle").value || undefined }, sets: [blankSet()] });
    picker = null; saveDraft(); return render();
  }
  if (a === "pick") { addExercise(boot.exercises.find((e) => e.id === t.dataset.v)); picker = null; saveDraft(); return render(); }
  if (!draft) return;
  if (tab !== "log") return;
  if (a === "rmex") { if (confirm("Remove this exercise?")) draft.exercises.splice(+t.dataset.e, 1); }
  else if (a === "addset") { const ss = draft.exercises[+t.dataset.e].sets, p = ss[ss.length - 1]; ss.push(p ? { ...p, done: false } : blankSet()); }
  else if (a === "rmset") draft.exercises[+t.dataset.e].sets.splice(+t.dataset.s, 1);
  else if (a === "done") setOf(t).done = !setOf(t).done;
  else if (a === "side") { const s = setOf(t); s.eachSide = !s.eachSide; s.done = true; }
  else if (a === "step") { // +/- buttons: update state and the input in place (no re-render, keeps scroll)
    const s = setOf(t), f = t.dataset.f, d = +t.dataset.d;
    s[f] = Math.max(0, Math.round(((+s[f] || 0) + d) * 10) / 10); s.done = true;
    const row = t.closest(".set"), db = row.querySelector("[data-a=done]");
    row.classList.add("done"); db.textContent = "✓ Done"; db.classList.add("on");
    t.parentElement.querySelector("input").value = fmt(s[f]);
    return saveDraft();
  } else return;
  saveDraft(); render();
});
document.addEventListener("input", (ev) => {
  const t = ev.target;
  if (planInput(t)) return;
  if (histInput(t)) return;
  if (t.id === "notes" && draft) { draft.notes = t.value; return saveDraft(); }
  if (t.id === "pfind") { prog.q = t.value; $("#plist").innerHTML = listHtml(); return; }
  if (t.id === "pq" && picker && tab === "log") { picker.q = t.value; return render(); }
  if (t.dataset.a === "num" && draft) {
    const s = setOf(t), v = t.value.replace(",", ".").trim();
    s[t.dataset.f] = v === "" || isNaN(+v) ? null : +v; s.done = true; saveDraft();
    const row = t.closest(".set"), db = row.querySelector("[data-a=done]");
    row.classList.add("done"); db.textContent = "✓ Done"; db.classList.add("on");
  }
});

// ---------- startup ----------
window.addEventListener("online", () => { flushQueue(); loadBootstrap(); if (tab === "history" && !ed) loadHistoryList(); });
window.addEventListener("beforeunload", (ev) => { if (editorDirty()) { ev.preventDefault(); ev.returnValue = ""; } });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
render(); showQueueBanner();
if (LS.get("pin")) { loadBootstrap(); flushQueue(); }
