// Pure chart logic (no DOM, no dependencies). Works as a plain <script> in the browser (global `Charts`)
// and can be imported in Node tests (also sets globalThis.Charts).
(function (root) {
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAY = 86400000;

  /** "YYYY-MM-DD" -> local midnight Date (never UTC, so no timezone shift). */
  function parseDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dayDiff = (a, b) => Math.round((b.getTime() - a.getTime()) / DAY);
  /** "2025-11-09" -> "Nov 9" (with year when asked) */
  function fmtDate(s, withYear) {
    const d = parseDate(s);
    if (!d) return "";
    return `${MON[d.getMonth()]} ${d.getDate()}${withYear ? `, ${d.getFullYear()}` : ""}`;
  }
  const fmtNum = (n) => {
    if (n == null || !isFinite(n)) return "";
    const r = Math.round(n * 10) / 10;
    return String(r);
  };

  const estOneRM = (w, r) => (w > 0 && r > 0 ? Math.round(w * (1 + r / 30)) : 0);

  /**
   * Turn history sessions [{date, sessionId, sets:[{weight,reps,eachSide}]}] into one point per session,
   * sorted by date ascending (stable for equal dates). Volume is plain weight*reps (Each Side ignored).
   */
  function buildSeries(history) {
    const pts = [];
    (history || []).forEach((h, idx) => {
      const d = parseDate(h.date);
      if (!d) return;
      let top = null, est = 0, vol = 0, bestReps = 0, totalReps = 0, n = 0;
      for (const s of h.sets || []) {
        const w = Number(s.weight) || 0, r = Number(s.reps) || 0;
        if (!w && !r) continue;
        n++;
        totalReps += r;
        if (r > bestReps) bestReps = r;
        vol += w * r;
        est = Math.max(est, estOneRM(w, r));
        if (w > 0 && (!top || w > top.weight || (w === top.weight && r > top.reps))) top = { weight: w, reps: r };
      }
      if (!n) return;
      pts.push({
        date: h.date, sessionId: h.sessionId || null, dayType: h.dayType || "", t: d.getTime(), idx,
        weight: top ? top.weight : 0, reps: top ? top.reps : 0, est1RM: est, volume: Math.round(vol),
        bestReps, totalReps, sets: n,
      });
    });
    pts.sort((a, b) => a.t - b.t || a.idx - b.idx);
    return pts;
  }

  /** True when no session has a weight (pull-ups, push-ups, ...): chart reps instead. */
  const isBodyweight = (pts) => pts.length > 0 && pts.every((p) => !p.weight);

  /** Values of one metric as chart points [{t, v, date, p}] dropping sessions where the metric is 0. */
  function metric(pts, key) {
    return pts.filter((p) => p[key] > 0).map((p) => ({ t: p.t, v: p[key], date: p.date, p }));
  }

  /** Personal records for `key`: each time the value strictly beat all earlier ones. Newest first. */
  function detectPRs(pts, key) {
    const out = [];
    let best = 0;
    for (const p of pts) {
      const v = p[key];
      if (v > best) {
        out.push({ date: p.date, value: v, reps: p.reps, previous: best || null, gain: best ? v - best : null });
        best = v;
      }
    }
    return out.reverse();
  }

  /** Keep points within the range ("3m","6m","1y","all") ending at `today` (YYYY-MM-DD or Date). */
  function filterRange(pts, range, today) {
    if (!range || range === "all") return pts.slice();
    const end = today instanceof Date ? today : parseDate(today) || new Date();
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    if (range === "3m") start.setMonth(start.getMonth() - 3);
    else if (range === "6m") start.setMonth(start.getMonth() - 6);
    else if (range === "1y") start.setFullYear(start.getFullYear() - 1);
    else return pts.slice();
    return pts.filter((p) => p.t >= start.getTime());
  }

  /** Overall stats for the header. */
  function summarize(pts) {
    const bw = isBodyweight(pts);
    const last = pts[pts.length - 1];
    return {
      bodyweight: bw,
      sessions: pts.length,
      totalSets: pts.reduce((a, p) => a + p.sets, 0),
      bestWeight: Math.max(0, ...pts.map((p) => p.weight)),
      bestEst1RM: Math.max(0, ...pts.map((p) => p.est1RM)),
      bestReps: Math.max(0, ...pts.map((p) => p.bestReps)),
      lastDate: last ? last.date : null,
    };
  }

  /** Change of a metric series: since the first point and versus the previous point. */
  function trend(series) {
    if (series.length < 2) return null;
    const first = series[0], last = series[series.length - 1], prev = series[series.length - 2];
    const sign = (x) => (x > 0 ? "up" : x < 0 ? "down" : "flat");
    return {
      sinceFirst: last.v - first.v, sinceFirstDir: sign(last.v - first.v), firstDate: first.date,
      vsPrev: last.v - prev.v, vsPrevDir: sign(last.v - prev.v),
    };
  }

  /** Nice axis ticks covering [min,max]. Flat series get a padded domain. Returns {min,max,ticks,step}. */
  function niceTicks(min, max, count = 4) {
    if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 1, ticks: [0, 1], step: 1 };
    if (min > max) [min, max] = [max, min];
    if (min === max) {
      const pad = Math.max(1, Math.abs(min) * 0.1);
      min -= pad; max += pad;
    }
    const raw = (max - min) / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    const lo = Math.floor(min / step + 1e-9) * step, hi = Math.ceil(max / step - 1e-9) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return { min: lo, max: hi, ticks, step };
  }

  /** Linear scale factory domain -> range (never divides by zero). */
  function linear(d0, d1, r0, r1) {
    const span = d1 - d0;
    return (v) => (span === 0 ? (r0 + r1) / 2 : r0 + ((v - d0) / span) * (r1 - r0));
  }

  /** Time axis ticks between two timestamps: month starts for long spans, evenly spaced days for short ones. */
  function timeTicks(t0, t1, maxTicks = 5) {
    const a = new Date(t0), b = new Date(t1);
    const spanDays = dayDiff(a, b);
    const long = spanDays >= 365;
    const out = [];
    if (spanDays > 60) {
      const months = [];
      let d = new Date(a.getFullYear(), a.getMonth() + (a.getDate() > 1 ? 1 : 0), 1);
      while (d.getTime() <= b.getTime()) { months.push(new Date(d)); d = new Date(d.getFullYear(), d.getMonth() + 1, 1); }
      const stride = Math.max(1, Math.ceil(months.length / maxTicks));
      months.forEach((m, i) => {
        if (i % stride) return;
        const lbl = MON[m.getMonth()] + (long && (m.getMonth() === 0 || i === 0) ? ` '${String(m.getFullYear()).slice(2)}` : "");
        out.push({ t: m.getTime(), label: lbl });
      });
    } else {
      const want = Math.max(1, maxTicks - 1);
      const step = [1, 2, 3, 5, 7, 10, 14, 21].find((s) => s >= spanDays / want) || 30;
      for (let i = 0; i * step <= spanDays; i++) {
        const d = new Date(a.getFullYear(), a.getMonth(), a.getDate() + i * step);
        out.push({ t: d.getTime(), label: `${MON[d.getMonth()]} ${d.getDate()}` });
      }
    }
    return out;
  }

  /** SVG path "M x y L x y ..." for [{x,y}] points. */
  function linePath(pts) {
    return pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  }

  const escXml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /**
   * Build an inline SVG string for a series [{t, v, date}] (ascending by t).
   * opts: kind "line" | "bar", width, height, selected (index), label (aria).
   * Needs >= 1 point; the caller shows "Not enough data yet" for fewer than 2.
   */
  function chartSvg(series, opts = {}) {
    const W = opts.width || 360, H = opts.height || 200;
    const m = { l: 42, r: 12, t: 12, b: 26 };
    const kind = opts.kind || "line";
    const vals = series.map((p) => p.v);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (kind === "bar") lo = 0;
    const y = niceTicks(lo, hi, 4);
    if (kind === "bar") { y.min = 0; }
    const t0 = series[0].t, t1 = series[series.length - 1].t;
    const padT = t1 === t0 ? DAY * 3 : (t1 - t0) * 0.04;
    const xd0 = t0 - padT, xd1 = t1 + padT;
    const sx = linear(xd0, xd1, m.l, W - m.r), sy = linear(y.min, y.max, H - m.b, m.t);
    const p = series.map((s) => ({ x: sx(s.t), y: sy(s.v) }));
    let g = "";
    for (const tk of y.ticks) {
      const yy = sy(tk).toFixed(1);
      g += `<line class="gl" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/><text class="ax" x="${m.l - 6}" y="${(+yy + 4).toFixed(1)}" text-anchor="end">${escXml(fmtNum(tk))}</text>`;
    }
    for (const tk of timeTicks(xd0, xd1, 5)) {
      const xx = sx(tk.t);
      if (xx < m.l - 1 || xx > W - m.r + 1) continue;
      g += `<line class="gl v" x1="${xx.toFixed(1)}" x2="${xx.toFixed(1)}" y1="${m.t}" y2="${H - m.b}"/><text class="ax" x="${xx.toFixed(1)}" y="${H - 8}" text-anchor="middle">${escXml(tk.label)}</text>`;
    }
    let body = "";
    if (kind === "bar") {
      let gap = Infinity;
      for (let i = 1; i < p.length; i++) gap = Math.min(gap, p[i].x - p[i - 1].x);
      const bw = Math.max(3, Math.min(22, isFinite(gap) ? gap * 0.7 : 22));
      p.forEach((q, i) => { body += `<rect class="bar${i === opts.selected ? " sel" : ""}" x="${(q.x - bw / 2).toFixed(1)}" y="${q.y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, H - m.b - q.y).toFixed(1)}" rx="2"/>`; });
    } else {
      if (p.length > 1) body += `<path class="ln" d="${linePath(p)}"/>`;
      p.forEach((q, i) => { body += `<circle class="dot${i === opts.selected ? " sel" : ""}" cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="${i === opts.selected ? 6 : 3.5}"/>`; });
    }
    if (opts.selected != null && p[opts.selected]) {
      const q = p[opts.selected];
      body = `<line class="cur" x1="${q.x.toFixed(1)}" x2="${q.x.toFixed(1)}" y1="${m.t}" y2="${H - m.b}"/>` + body;
    }
    return {
      svg: `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${escXml(opts.label || "chart")}" preserveAspectRatio="xMidYMid meet">${g}${body}</svg>`,
      xs: p.map((q) => q.x), width: W,
    };
  }

  /** Index of the point whose x (viewBox units) is closest to x. */
  function nearest(xs, x) {
    let best = -1, bd = Infinity;
    xs.forEach((v, i) => { const d = Math.abs(v - x); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  const api = { parseDate, ymd, fmtDate, fmtNum, estOneRM, buildSeries, isBodyweight, metric, detectPRs, filterRange, summarize, trend, niceTicks, linear, timeTicks, linePath, chartSvg, nearest };
  root.Charts = api;
})(globalThis);
