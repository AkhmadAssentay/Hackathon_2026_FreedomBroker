/* Tiny dependency-free SVG charts for CQA (embeddable in Dynamics 365).
 * Colors: validated reference palette (blue, orange, aqua for series; status good/critical + gray N/A,
 * always with text labels). Every mark carries data-tip for the shared hover tooltip. */
(function () {
  const C = {
    s1: "#2a78d6", s2: "#eb6834", s3: "#1baf7a", s4: "#eda100", s5: "#e87ba4",
    good: "#0ca30c", bad: "#d03b3b", partial: "#eda100", na: "#b9bdb9",
    ink: "#18211d", ink2: "#52514e", muted: "#8a918d", grid: "#e6ebe8", surface: "#ffffff",
    seq: ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"],
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (x, d = 1) => (x == null ? "—" : Number(x).toFixed(d).replace(/\.0+$/, ""));

  // ---------------------------------------------------------------- shared tooltip
  let tip;
  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement("div");
    tip.className = "viz-tip";
    document.body.appendChild(tip);
    document.addEventListener("mousemove", (e) => {
      const t = e.target.closest && e.target.closest("[data-tip]");
      if (!t) { tip.style.opacity = 0; return; }
      tip.innerHTML = t.getAttribute("data-tip");
      tip.style.opacity = 1;
      const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
      const y = Math.max(8, e.clientY - tip.offsetHeight - 12);
      tip.style.left = x + "px"; tip.style.top = y + "px";
    });
    return tip;
  }
  const svg = (w, h, body, label) => `<svg class="viz" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(label || "")}" preserveAspectRatio="xMidYMid meet">${body}</svg>`;
  const legend = (items) => `<div class="viz-legend">${items.map(([c, l]) => `<span><i style="background:${c}"></i>${esc(l)}</span>`).join("")}</div>`;
  // rounded data-end bar (radius only on the free end), anchored at the baseline
  function hbar(x, y, w, h, fill, r = 4, attrs = "") {
    if (w <= 0) return "";
    r = Math.min(r, w, h / 2);
    return `<path d="M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${w - r}z" fill="${fill}" ${attrs}/>`;
  }
  function vbar(x, y, w, h, fill, r = 4, attrs = "") {
    if (h <= 0) return "";
    r = Math.min(r, h, w / 2);
    return `<path d="M${x},${y + h}v-${h - r}a${r},${r} 0 0 1 ${r},-${r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - r}z" fill="${fill}" ${attrs}/>`;
  }

  // ---------------------------------------------------------------- histogram of totals
  function histogram(el, values, { bins = 10, min = 0, max = 100, label = "Итоговый балл" } = {}) {
    ensureTip();
    const W = 560, H = 220, L = 34, B = 30, T = 10, R = 8;
    const step = (max - min) / bins;
    const counts = Array(bins).fill(0);
    values.forEach((v) => { counts[Math.min(bins - 1, Math.max(0, Math.floor((v - min) / step)))]++; });
    const top = Math.max(1, ...counts);
    const bw = (W - L - R) / bins;
    let g = "";
    for (let k = 0; k <= 4; k++) {
      const y = T + (H - T - B) * (1 - k / 4), val = Math.round((top * k) / 4);
      g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="${C.grid}"/><text x="${L - 6}" y="${y + 4}" text-anchor="end" class="ax">${val}</text>`;
    }
    counts.forEach((c, i) => {
      const h = ((H - T - B) * c) / top, x = L + i * bw + 1, lo = min + i * step, hi = lo + step;
      g += vbar(x, H - B - h, bw - 2, h, C.s1, 4, `data-tip="${fmt(lo, 0)}–${fmt(hi, 0)} баллов: <b>${c}</b> диалог(ов)"`);
      g += `<rect x="${x}" y="${T}" width="${bw - 2}" height="${H - T - B}" fill="transparent" data-tip="${fmt(lo, 0)}–${fmt(hi, 0)} баллов: <b>${c}</b> диалог(ов)"/>`;
      if (i % 2 === 0) g += `<text x="${L + i * bw}" y="${H - B + 16}" class="ax">${fmt(lo, 0)}</text>`;
    });
    g += `<text x="${W - R}" y="${H - B + 16}" text-anchor="end" class="ax">${max}</text>`;
    el.innerHTML = svg(W, H, g, label);
  }

  // ---------------------------------------------------------------- 100% stacked outcome bars per criterion
  function outcomes(el, rows) {
    ensureTip();
    const W = 600, rowH = 30, L = 260, R = 44, T = 4;
    const H = T + rows.length * rowH + 4;
    const segs = [["yes", C.good, "выполнено"], ["partial", C.partial, "частично"], ["no", C.bad, "нарушение / не выполнено"], ["na", C.na, "N/A"]];
    let g = "";
    rows.forEach((r, i) => {
      const n = segs.reduce((s, [k]) => s + (r[k] || 0), 0) || 1;
      const y = T + i * rowH;
      g += `<text x="${L - 8}" y="${y + 19}" text-anchor="end" class="lbl">${esc(r.title.length > 32 ? r.title.slice(0, 31) + "…" : r.title)}</text>`;
      let x = L;
      segs.forEach(([k, col, name]) => {
        const v = r[k] || 0;
        if (!v) return;
        const w = ((W - L - R) * v) / n;
        g += `<rect x="${x}" y="${y + 5}" width="${Math.max(0, w - 2)}" height="${rowH - 10}" rx="3" fill="${col}" data-tip="${esc(r.title)}<br>${name}: <b>${v}</b> (${Math.round((100 * v) / n)}%)"/>`;
        x += w;
      });
      const okShare = Math.round((100 * ((r.yes || 0) + (r.na || 0))) / n);
      g += `<text x="${W - R + 6}" y="${y + 19}" class="val">${okShare}%</text>`;
    });
    el.innerHTML = svg(W, H, g, "Исходы по критериям") + legend(segs.map(([, c, l]) => [c, l]));
  }

  // ---------------------------------------------------------------- simple horizontal bars (category -> value)
  function hbars(el, items, { max = 100, unit = "", color = C.s1, label = "", decimals = 1, labelWidth = 150 } = {}) {
    ensureTip();
    const W = 420 + labelWidth, rowH = 30, L = labelWidth, R = 56, T = 4;
    const H = T + items.length * rowH + 4;
    let g = "";
    items.forEach((it, i) => {
      const y = T + i * rowH, w = ((W - L - R) * (it.value || 0)) / max;
      g += `<text x="${L - 8}" y="${y + 19}" text-anchor="end" class="lbl">${esc(it.label)}</text>`;
      g += `<rect x="${L}" y="${y + 6}" width="${W - L - R}" height="${rowH - 12}" rx="3" fill="${C.grid}"/>`;
      g += hbar(L, y + 6, w, rowH - 12, it.color || color, 4, `data-tip="${esc(it.tip || it.label)}: <b>${fmt(it.value, decimals)}${unit}</b>"`);
      g += `<text x="${L + w + 6}" y="${y + 19}" class="val">${fmt(it.value, decimals)}${unit}</text>`;
    });
    el.innerHTML = svg(W, H, g, label);
  }

  // ---------------------------------------------------------------- heatmap (rows x cols, 0..1)
  function heatmap(el, rows, cols, value, { label = "", fmtCell = (v) => Math.round(v * 100) } = {}) {
    ensureTip();
    const cw = 62, ch = 28, L = 300, T = 30;
    const W = L + cols.length * cw + 6, H = T + rows.length * ch + 6;
    const lo = 0.4, hi = 1.0;
    let g = "";
    cols.forEach((c, j) => { g += `<text x="${L + j * cw + cw / 2}" y="${T - 10}" text-anchor="middle" class="ax">${esc(c.short || c.id)}</text>`; });
    rows.forEach((r, i) => {
      g += `<text x="${L - 8}" y="${T + i * ch + 20}" text-anchor="end" class="lbl">${esc(r.label)}</text>`;
      cols.forEach((c, j) => {
        const v = value(r, c);
        if (v == null) return;
        const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
        const idx = Math.round(t * (C.seq.length - 1));
        const fill = C.seq[idx];
        const ink = idx >= 4 ? "#ffffff" : C.ink;
        g += `<rect x="${L + j * cw + 1}" y="${T + i * ch + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" fill="${fill}" data-tip="${esc(r.label)} · ${esc(c.title || c.id)}: <b>${fmtCell(v)}%</b>"/>`;
        g += `<text x="${L + j * cw + cw / 2}" y="${T + i * ch + 20}" text-anchor="middle" class="cell" fill="${ink}" pointer-events="none">${fmtCell(v)}</text>`;
      });
    });
    el.innerHTML = svg(W, H, g, label).replace('width="100%"', `width="100%" style="max-width:${W}px"`);
  }

  // ---------------------------------------------------------------- scatter: cost (x, log) vs accuracy (y)
  function costAccuracy(el, pts, { label = "Стоимость и точность" } = {}) {
    ensureTip();
    const W = 560, H = 280, L = 48, B = 40, T = 14, R = 16;
    const ys = pts.map((p) => p.acc);
    const ymin = Math.floor(Math.min(...ys) * 20) / 20 - 0.02, ymax = Math.min(1, Math.ceil(Math.max(...ys) * 20) / 20 + 0.02);
    const xs = pts.map((p) => Math.max(p.cost, 0.0001));
    const lx = (v) => Math.log10(Math.max(v, 0.0001));
    const xmin = Math.min(-4, ...xs.map(lx)), xmax = Math.max(-1, ...xs.map(lx));
    const X = (c) => L + ((lx(Math.max(c, 0.0001)) - xmin) / (xmax - xmin)) * (W - L - R);
    const Y = (a) => T + (1 - (a - ymin) / (ymax - ymin)) * (H - T - B);
    let g = "";
    for (let a = Math.ceil(ymin * 20) / 20; a <= ymax + 1e-9; a += 0.05) {
      g += `<line x1="${L}" x2="${W - R}" y1="${Y(a)}" y2="${Y(a)}" stroke="${C.grid}"/><text x="${L - 6}" y="${Y(a) + 4}" text-anchor="end" class="ax">${Math.round(a * 100)}%</text>`;
    }
    [0.0001, 0.001, 0.01, 0.1].forEach((c) => {
      if (lx(c) < xmin || lx(c) > xmax) return;
      g += `<line x1="${X(c)}" x2="${X(c)}" y1="${T}" y2="${H - B}" stroke="${C.grid}"/><text x="${X(c)}" y="${H - B + 16}" text-anchor="middle" class="ax">${c < 0.001 ? "$0" : "$" + c}</text>`;
    });
    g += `<text x="${(W + L) / 2}" y="${H - 6}" text-anchor="middle" class="ax">стоимость одной оценки (лог. шкала)</text>`;
    const placed = [];
    pts.forEach((p) => {
      const x = X(p.cost), y = Y(p.acc);
      g += `<circle cx="${x}" cy="${y}" r="7" fill="${p.color || C.s1}" stroke="${C.surface}" stroke-width="2" data-tip="<b>${esc(p.label)}</b><br>точность ${Math.round(p.acc * 1000) / 10}%<br>$${p.cost.toFixed(4)} за диалог"/>`;
      if (p.showLabel && !placed.some(([px, py]) => Math.abs(px - x) < 150 && Math.abs(py - y) < 15)) {
        const right = x > W - 200;
        g += `<text x="${right ? x - 10 : x + 10}" y="${y - 9}" text-anchor="${right ? "end" : "start"}" class="lbl small">${esc(p.label)}</text>`;
        placed.push([x, y]);
      }
    });
    el.innerHTML = svg(W, H, g, label);
  }

  // ---------------------------------------------------------------- operator reply delays along the dialogue
  function delays(el, turns, { threshold = 180, onPick } = {}) {
    ensureTip();
    const W = 560, H = 120, L = 34, B = 22, T = 8, R = 8;
    const pts = [];
    let pending = null;
    turns.forEach((t) => {
      if (t.speaker === "client" && !pending) pending = t;
      else if (t.speaker === "operator" && !t.internal && pending && t.t != null && pending.t != null) {
        pts.push({ i: t.i, d: Math.max(0, t.t - pending.t), from: pending.i });
        pending = null;
      }
    });
    if (!pts.length) { el.innerHTML = `<div class="muted small">Нет пар «клиент → оператор» с временем.</div>`; return; }
    const ymax = Math.max(threshold * 1.15, ...pts.map((p) => p.d));
    const n = turns.length;
    const X = (i) => L + (i / Math.max(1, n - 1)) * (W - L - R);
    const Y = (d) => T + (1 - d / ymax) * (H - T - B);
    let g = `<line x1="${L}" x2="${W - R}" y1="${Y(threshold)}" y2="${Y(threshold)}" stroke="${C.bad}" stroke-dasharray="4 4"/>`
      + `<text x="${W - R}" y="${Y(threshold) - 4}" text-anchor="end" class="ax">порог ${threshold / 60} мин</text>`
      + `<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="${C.grid}"/>`
      + `<text x="${L - 6}" y="${T + 8}" text-anchor="end" class="ax">${Math.round(ymax)}с</text><text x="${L - 6}" y="${H - B}" text-anchor="end" class="ax">0</text>`;
    pts.forEach((p) => {
      const x = X(p.i), y = Y(p.d), col = p.d > threshold ? C.bad : C.s1;
      g += `<line x1="${x}" x2="${x}" y1="${H - B}" y2="${y}" stroke="${col}" stroke-width="2"/>`;
      g += `<circle cx="${x}" cy="${y}" r="5" fill="${col}" stroke="${C.surface}" stroke-width="2" data-pick="${p.i}" data-tip="Ответ оператора t${p.i} на t${p.from}: <b>${Math.round(p.d)} с</b>${p.d > threshold ? " — дольше порога" : ""}" style="cursor:pointer"/>`;
    });
    g += `<text x="${L}" y="${H - 6}" class="ax">начало</text><text x="${W - R}" y="${H - 6}" text-anchor="end" class="ax">конец диалога</text>`;
    el.innerHTML = svg(W, H, g, "Задержки ответов оператора");
    if (onPick) el.querySelectorAll("[data-pick]").forEach((c) => (c.onclick = () => onPick(+c.dataset.pick)));
  }

  // ---------------------------------------------------------------- call waveform with turn markers
  function waveform(el, peaks, duration, turns, { onSeek, marks = {}, holds = [], silences = [] } = {}) {
    ensureTip();
    const W = 900, H = 96, mid = 50, amp = 38;
    const n = peaks.length, bw = W / n;
    let g = "";
    holds.forEach(([a, b]) => {
      const x = (a / duration) * W, w = Math.max(4, ((b - a) / duration) * W);
      g += `<rect x="${x}" y="0" width="${w}" height="${H}" fill="#8a918d" opacity=".18" data-tip="Удержание: оператор говорит с коллегой (${Math.round(b - a)} с) — не оценивается"/>`;
    });
    silences.forEach((sl) => {
      const x = (sl.at_sec / duration) * W, w = Math.max(3, (sl.seconds / duration) * W);
      const col = sl.operator_warned ? "#8a918d" : C.bad;
      g += `<rect x="${x}" y="${H - 4}" width="${w}" height="4" fill="${col}"/><rect x="${x}" y="0" width="${w}" height="${H}" fill="${col}" opacity=".08" data-tip="Тишина ${sl.seconds} с в ${Math.floor(sl.at_sec / 60)}:${String(Math.floor(sl.at_sec % 60)).padStart(2, "0")}<br>${sl.operator_warned ? "оператор предупредил об ожидании" : "<b>без предупреждения оператора</b>"}"/>`;
    });
    peaks.forEach((p, i) => {
      const h = Math.max(1, p * amp);
      g += `<rect x="${i * bw}" y="${mid - h}" width="${Math.max(0.6, bw - 0.4)}" height="${2 * h}" fill="#9fb3a8"/>`;
    });
    const colorFor = (t) => (t.internal ? C.muted : t.speaker === "operator" ? C.s1 : t.speaker === "client" ? C.s2 : null);
    turns.forEach((t) => {
      if (t.audio_t == null || !colorFor(t)) return;
      const x = (t.audio_t / duration) * W;
      const m = marks[t.i];
      g += `<rect x="${x - 1}" y="${t.speaker === "operator" ? 2 : H - 10}" width="${m ? 4 : 2}" height="8" rx="1" fill="${m ? C.bad : colorFor(t)}" data-seek="${t.audio_t}" data-tip="t${t.i} ${t.internal ? "оператор ↔ коллега" : t.speaker === "operator" ? "оператор" : "клиент"} · ${Math.floor(t.audio_t / 60)}:${String(Math.floor(t.audio_t % 60)).padStart(2, "0")}${m ? "<br><b>" + esc(m) + "</b>" : ""}<br>${esc(t.text.slice(0, 90))}" style="cursor:pointer"/>`;
    });
    g += `<rect class="wf-cursor" x="0" y="0" width="2" height="${H}" fill="${C.ink}" opacity=".7"/>`;
    el.innerHTML = svg(W, H, g, "Волна записи") + legend([[C.s1, "оператор (сверху)"], [C.s2, "клиент (снизу)"], [C.bad, "доказательство / тишина без предупреждения"], [C.muted, "удержание"]]);
    const s = el.querySelector("svg");
    s.style.cursor = "pointer";
    s.addEventListener("click", (e) => {
      const tgt = e.target.closest("[data-seek]");
      const r = s.getBoundingClientRect();
      const sec = tgt ? +tgt.dataset.seek : ((e.clientX - r.left) / r.width) * duration;
      onSeek && onSeek(sec);
    });
    return { setTime: (t) => { const c = el.querySelector(".wf-cursor"); if (c) c.setAttribute("x", (t / duration) * W); } };
  }

  // ---------------------------------------------------------------- donut gauge for the total
  function gauge(el, value, { max = 100 } = {}) {
    const r = 46, c = 2 * Math.PI * r, v = value == null ? 0 : Math.max(0, Math.min(max, value)) / max;
    const col = value == null ? C.na : value >= 85 ? C.good : value >= 60 ? C.partial : C.bad;
    el.innerHTML = `<svg viewBox="0 0 120 120" width="120" height="120" role="img" aria-label="Итог ${value ?? "нет"}">`
      + `<circle cx="60" cy="60" r="${r}" fill="none" stroke="${C.grid}" stroke-width="12"/>`
      + `<circle cx="60" cy="60" r="${r}" fill="none" stroke="${col}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${c * v} ${c}" transform="rotate(-90 60 60)"/>`
      + `<text x="60" y="66" text-anchor="middle" class="gauge-num">${value == null ? "—" : fmt(value, 1)}</text></svg>`;
  }

  // ---------------------------------------------------------------- risk-coverage line
  function riskCoverage(el, pts) {
    ensureTip();
    const W = 560, H = 240, L = 48, B = 40, T = 14, R = 16;
    const ys = pts.map((p) => p.auto_accuracy);
    const ymin = Math.floor(Math.min(...ys) * 50) / 50 - 0.01, ymax = Math.min(1, Math.ceil(Math.max(...ys) * 50) / 50 + 0.01);
    const xmax = Math.max(...pts.map((p) => p.review_pct));
    const X = (v) => L + (v / xmax) * (W - L - R), Y = (a) => T + (1 - (a - ymin) / (ymax - ymin)) * (H - T - B);
    let g = "";
    for (let a = Math.ceil(ymin * 50) / 50; a <= ymax + 1e-9; a += 0.02)
      g += `<line x1="${L}" x2="${W - R}" y1="${Y(a)}" y2="${Y(a)}" stroke="${C.grid}"/><text x="${L - 6}" y="${Y(a) + 4}" text-anchor="end" class="ax">${Math.round(a * 100)}%</text>`;
    pts.forEach((p) => { g += `<text x="${X(p.review_pct)}" y="${H - B + 16}" text-anchor="middle" class="ax">${p.review_pct}%</text>`; });
    g += `<text x="${(W + L) / 2}" y="${H - 6}" text-anchor="middle" class="ax">доля оценок, которые смотрит человек</text>`;
    g += `<path d="${pts.map((p, i) => (i ? "L" : "M") + X(p.review_pct) + "," + Y(p.auto_accuracy)).join("")}" fill="none" stroke="${C.s3}" stroke-width="2"/>`;
    pts.forEach((p) => {
      g += `<circle cx="${X(p.review_pct)}" cy="${Y(p.auto_accuracy)}" r="5" fill="${C.s3}" stroke="${C.surface}" stroke-width="2" data-tip="Проверка ${p.review_pct}% самых неуверенных оценок<br>точность остальных: <b>${(p.auto_accuracy * 100).toFixed(1)}%</b><br>поймано ошибок: ${p.errors_caught} из ${p.errors_total}"/>`;
    });
    el.innerHTML = svg(W, H, g, "Точность в зависимости от доли ручной проверки");
  }

  // ---------------------------------------------------------------- accuracy with 95% CI whiskers
  function ciBars(el, rows, { lo = 0.6, hi = 1.0, labelWidth = 260 } = {}) {
    ensureTip();
    const W = 420 + labelWidth, rowH = 34, L = labelWidth, R = 70, T = 6;
    const H = T + rows.length * rowH + 26;
    const X = (v) => L + ((v - lo) / (hi - lo)) * (W - L - R);
    let g = "";
    [0.6, 0.7, 0.8, 0.9, 1.0].filter((v) => v >= lo && v <= hi).forEach((v) => {
      g += `<line x1="${X(v)}" x2="${X(v)}" y1="${T}" y2="${H - 22}" stroke="${C.grid}"/><text x="${X(v)}" y="${H - 6}" text-anchor="middle" class="ax">${Math.round(v * 100)}%</text>`;
    });
    rows.forEach((r, i) => {
      const y = T + i * rowH + rowH / 2;
      const tip = `${esc(r.label)}: <b>${(r.acc * 100).toFixed(1)}%</b><br>95% ДИ ${(r.lo * 100).toFixed(1)}–${(r.hi * 100).toFixed(1)}%`;
      g += `<text x="${L - 8}" y="${y + 4}" text-anchor="end" class="lbl">${esc(r.label)}</text>`;
      g += `<line x1="${X(r.lo)}" x2="${X(r.hi)}" y1="${y}" y2="${y}" stroke="${r.color || C.s1}" stroke-width="3"/>`;
      g += `<line x1="${X(r.lo)}" x2="${X(r.lo)}" y1="${y - 7}" y2="${y + 7}" stroke="${r.color || C.s1}" stroke-width="2"/><line x1="${X(r.hi)}" x2="${X(r.hi)}" y1="${y - 7}" y2="${y + 7}" stroke="${r.color || C.s1}" stroke-width="2"/>`;
      g += `<circle cx="${X(r.acc)}" cy="${y}" r="7" fill="${r.color || C.s1}" stroke="${C.surface}" stroke-width="2" data-tip="${tip}"/>`;
      g += `<rect x="${L}" y="${y - rowH / 2}" width="${W - L - R}" height="${rowH}" fill="transparent" data-tip="${tip}"/>`;
      g += `<text x="${W - R + 8}" y="${y + 4}" class="val">${(r.acc * 100).toFixed(1)}%</text>`;
    });
    el.innerHTML = svg(W, H, g, "Точность с 95% доверительными интервалами");
  }

  // ---------------------------------------------------------------- stacked error bars (near miss vs other)
  function errorBars(el, rows) {
    ensureTip();
    const W = 560, rowH = 32, L = 220, R = 40, T = 4;
    const H = T + rows.length * rowH + 4;
    const max = Math.max(1, ...rows.map((r) => r.total));
    let g = "";
    rows.forEach((r, i) => {
      const y = T + i * rowH, unit = (W - L - R) / max;
      g += `<text x="${L - 8}" y="${y + 20}" text-anchor="end" class="lbl">${esc(r.label)}</text>`;
      const wn = r.near * unit, wo = (r.total - r.near) * unit;
      if (r.near) g += `<rect x="${L}" y="${y + 6}" width="${Math.max(0, wn - 2)}" height="${rowH - 12}" rx="3" fill="${C.s4}" data-tip="${esc(r.label)}: промах на одну ступень — <b>${r.near}</b>"/>`;
      if (r.total - r.near) g += `<rect x="${L + wn}" y="${y + 6}" width="${Math.max(0, wo - 2)}" height="${rowH - 12}" rx="3" fill="${C.bad}" data-tip="${esc(r.label)}: другие ошибки — <b>${r.total - r.near}</b>"/>`;
      g += `<text x="${L + wn + wo + 6}" y="${y + 20}" class="val">${r.total}</text>`;
    });
    el.innerHTML = svg(W, H, g, "Ошибки маршрутизатора по критериям") + legend([[C.s4, "промах на одну ступень шкалы"], [C.bad, "другие ошибки"]]);
  }

  window.CQA = window.CQA || {};
  window.CQA.charts = { ciBars, errorBars, riskCoverage, C, histogram, outcomes, hbars, heatmap, costAccuracy, delays, waveform, gauge };
})();
