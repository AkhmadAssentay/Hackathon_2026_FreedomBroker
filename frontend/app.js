/* CQA UI — framework-free Web Components. Data only via window.CQA.provider. */
(function () {
  const P = () => window.CQA.provider;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (x, d = 2) => (x === null || x === undefined ? "—" : Number(x).toFixed(d).replace(/\.00$/, ""));
  const SPK = { client: "Клиент", operator: "Оператор", bot: "Бот", system: "Система", internal: "Оператор ↔ коллега" };
  const store = { group: localGet("group") || "DEV", provider: localGet("provider") || "router", health: null };

  function localGet(k) { try { return localStorage.getItem("cqa." + k); } catch { return null; } }
  function localSet(k, v) { try { localStorage.setItem("cqa." + k, v); } catch { /* ignore */ } }
  function toast(msg, kind = "") {
    const t = document.createElement("div");
    t.className = "toast " + kind; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 4200);
  }

  function answerLabel(crit, a) {
    if (a === null || a === undefined) return "—";
    if (a === "na") return "N/A";
    if (crit && crit.gross) return a === "yes" ? "Выявлено" : "Не выявлено";
    if (crit && crit.type === "scale") return `${a} / ${Math.max(...crit.scale.map((s) => +s.value))}`;
    return a === "yes" ? "Да" : "Нет";
  }
  function answerClass(crit, a) {
    if (a === "na") return "na";
    if (crit && crit.gross) return a === "yes" ? "bad" : "good";
    if (crit && crit.type === "scale") {
      const top = Math.max(...crit.scale.map((s) => +s.value));
      return +a >= top ? "good" : +a <= 0 ? "bad" : "mid";
    }
    return a === "yes" ? "good" : "bad";
  }
  function modelLabel(m) {
    if (!m) return "";
    if (m.startsWith("claude-sonnet")) return "Claude Sonnet 5.5";
    if (m.startsWith("claude-haiku")) return "Claude Haiku 5.5";
    if (m.includes("@sc")) return "Qwen3.5-35B × 5 голосов";
    if (m.startsWith("local:")) return m.replace("local:", "") + " (GPU)";
    return m;
  }
  function voteDots(share) {
    const k = Math.round(share * 5);
    return `<span class="dots">${"●".repeat(k)}<span class="off">${"●".repeat(5 - k)}</span></span>`;
  }
  function answerOptions(crit) {
    const o = crit.type === "scale" ? crit.scale.map((s) => String(s.value)) : ["yes", "no"];
    if (crit.na_allowed) o.push("na");
    return o;
  }

  // ------------------------------------------------------------------ router
  // Links of the Node prototype's format (#/dialog/DEV/p1-en-001?ev=…, #/dialogs, #/overview) keep working.
  const LEGACY_VIEWS = { overview: "dash", dialogs: "convs", dialog: "convs", checklists: "checklist" };
  function route() {
    const old = location.hash.match(/^#\/dialog\/([^/?]+)\/([^/?]+)/);
    if (old) history.replaceState(null, "", "#/conv/" + encodeURIComponent(decodeURIComponent(old[1]) + ":" + decodeURIComponent(old[2])));
    const h = location.hash.replace(/^#\/?/, "").split("?")[0];
    const [v, ...rest] = h.split("/");
    const view = LEGACY_VIEWS[v] || v;
    return { view: view || "convs", arg: rest.length ? decodeURIComponent(rest[0]) : null, sub: rest[1] || null };
  }

  // ------------------------------------------------------------------ app shell
  class CqaApp extends HTMLElement {
    connectedCallback() {
      (window.CQA.ready || Promise.resolve()).then(() => this.init());
    }
    init() {
      const ro = P().readOnly;
      this.innerHTML = `
        ${ro ? `<div class="ro-banner">Демо только для просмотра: сохранённые результаты ${esc((window.CQA.snapshotMeta || {}).dialogues || "")} синтетических чатов DEV. Оценка, апелляции и редактор работают при локальном запуске (README).</div>` : ""}
        <header class="top">
          <div class="brand"><span class="logo">CQA</span><span>Оценка качества диалогов</span></div>
          <nav>
            <a href="#/dash" data-v="dash">Аналитика</a>
            <a href="#/convs" data-v="convs">Диалоги</a>
            <a href="#/checklist" data-v="checklist">Чек-лист</a>
            <a href="#/appeals" data-v="appeals">Апелляции <span class="pill" id="ap-count"></span></a>
            <a href="#/lab" data-v="lab">Эксперименты</a>
            <a href="#/costs" data-v="costs">Расходы</a>
          </nav>
          <div class="controls">
            <label>Набор <select id="group"></select></label>
            <button class="ghost" id="load" title="Загрузить набор по group_id из API организаторов">+ group_id</button>
            <button class="ghost" id="zoom" title="Крупный режим для проектора">A+</button>
            <label>Модель <select id="provider">
              <option value="router">Sonnet + Qwen (маршрут.)</option><option value="claude">Claude Sonnet 5.5</option><option value="local_sc5">Qwen × 5 (GPU)</option><option value="local">Qwen3.5 (GPU)</option></select></label>
          </div>
        </header>
        <main id="view"></main>`;
      this.querySelector("#provider").value = store.provider;
      this.querySelector("#provider").onchange = (e) => { store.provider = e.target.value; localSet("provider", store.provider); };
      this.querySelector("#group").onchange = (e) => { store.group = e.target.value; localSet("group", store.group); this.render(true); };
      this.querySelector("#load").onclick = () => this.loadGroup();
      const applyZoom = () => { document.documentElement.classList.toggle("present", localGet("present") === "1"); };
      applyZoom();
      this.querySelector("#zoom").onclick = () => { localSet("present", localGet("present") === "1" ? "0" : "1"); applyZoom(); };
      window.addEventListener("hashchange", () => this.render());
      this.refreshGroups().then(() => this.render(true));
      P().health().then((h) => {
        store.health = h;
        if (!["router", "claude", "local_sc5", "local"].includes(store.provider)) { store.provider = "router"; }
        this.querySelector("#provider").value = store.provider;
        if (!h.has_claude_key && store.provider !== "local") {
          store.provider = "local_sc5"; this.querySelector("#provider").value = "local_sc5";
          this.querySelector("#provider option[value=claude]").textContent = "Claude API (нет ключа)";
        }
      }).catch(() => {});
      this.refreshAppealCount();
      window.CQA.refreshAppealCount = () => this.refreshAppealCount();
    }
    async refreshAppealCount() {
      try { const a = await P().appeals("open"); this.querySelector("#ap-count").textContent = a.length || ""; } catch { /* */ }
    }
    async refreshGroups() {
      const gs = await P().groups().catch(() => []);
      const sel = this.querySelector("#group");
      if (!gs.find((g) => g.group_id === store.group) && gs.length) store.group = gs[0].group_id;
      sel.innerHTML = gs.map((g) => `<option value="${esc(g.group_id)}">${esc(g.group_id)} (${g.n})</option>`).join("")
        || `<option value="">нет данных</option>`;
      sel.value = store.group;
    }
    async loadGroup() {
      const g = prompt("group_id набора (например DEV или выданный организаторами):", store.group || "DEV");
      if (!g) return;
      try {
        const r = await P().fetchGroup(g.trim());
        toast(`Загружено ${r.imported} диалогов (${r.group_id})`, "ok");
        store.group = r.group_id; localSet("group", store.group);
        await this.refreshGroups(); this.render(true);
      } catch (e) { toast("Ошибка загрузки: " + e.message, "err"); }
    }
    render(force) {
      const r = route();
      this.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.dataset.v === (r.view === "conv" ? "convs" : r.view)));
      const v = this.querySelector("#view");
      const tag = { dash: "cqa-dash", lab: "cqa-lab", convs: "cqa-dialogs", conv: "cqa-dialogs", checklist: "cqa-checklist", appeals: "cqa-appeals", costs: "cqa-costs" }[r.view] || "cqa-dialogs";
      let el = v.firstElementChild;
      if (!el || el.tagName.toLowerCase() !== tag || force) { v.innerHTML = ""; el = document.createElement(tag); v.appendChild(el); }
      if (el.onRoute) el.onRoute(r);
    }
  }

  // ------------------------------------------------------------------ dialogs (list + card)
  class CqaDialogs extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
        <section class="dialogs">
          <aside class="list">
            <div class="list-tools">
              <input id="q" placeholder="Поиск по ID…">
              <select id="lang"><option value="">Все языки</option><option>RU</option><option>KZ</option><option>EN</option></select>
              <select id="chan"><option value="">Все каналы</option><option value="agent chat">Чат</option><option value="voice call">Звонок</option></select>
            </div>
            <div class="list-actions">
              <button id="eval-all">Оценить весь набор</button>
              <span id="job" class="muted"></span>
            </div>
            <div id="rows" class="rows"></div>
          </aside>
          <cqa-card class="card-host"></cqa-card>
        </section>`;
      ["q", "lang", "chan"].forEach((id) => (this.querySelector("#" + id).oninput = () => this.drawRows()));
      this.querySelector("#eval-all").onclick = () => this.evalAll();
      this.load();
    }
    async load() {
      this.items = await P().conversations(store.group).catch(() => []);
      this.drawRows();
    }
    drawRows() {
      const q = this.querySelector("#q").value.trim().toLowerCase();
      const lang = this.querySelector("#lang").value, chan = this.querySelector("#chan").value;
      const cur = route().arg;
      const rows = (this.items || []).filter((c) => (!q || c.cid.toLowerCase().includes(q)) && (!lang || c.language === lang) && (!chan || c.channel === chan));
      this.querySelector("#rows").innerHTML = rows.map((c) => `
        <a class="row ${c.id === cur ? "on" : ""}" href="#/conv/${encodeURIComponent(c.id)}">
          <span class="ico" title="${esc(c.channel)}">${c.channel === "voice call" ? "☎" : "✉"}</span>
          <span class="cid">${esc(c.cid)}</span>
          <span class="lang">${esc(c.language)}</span>
          <span class="flags">${c.gross_error ? '<b class="flag" title="Грубая ошибка">!</b>' : ""}${c.needs_review ? `<b class="warn" title="Требует проверки: ${c.needs_review}">?</b>` : ""}${c.appeals_open ? '<b class="ap" title="Открытая апелляция">A</b>' : ""}</span>
          <span class="score ${c.final_total == null ? "none" : c.final_total >= 85 ? "good" : c.final_total >= 60 ? "mid" : "bad"}">${c.evaluation_id ? fmt(c.final_total) : "—"}</span>
        </a>`).join("") || `<p class="muted pad">Нет диалогов. Загрузите набор (group_id) вверху.</p>`;
    }
    async evalAll() {
      if (!confirm(`Оценить все диалоги набора ${store.group} моделью «${store.provider === "claude" ? "Claude API" : "локальная"}»? Уже оценённые критерии берутся из кэша.`)) return;
      try {
        const job = await P().evaluate({ group_id: store.group, provider: store.provider });
        this.pollJob(job.id);
      } catch (e) { toast(e.message, "err"); }
    }
    async pollJob(id) {
      const span = this.querySelector("#job");
      const j = await P().job(id);
      span.textContent = `${j.done + j.failed}/${j.total}${j.failed ? ` · ошибок ${j.failed}` : ""}${j.status === "budget_stop" ? " · стоп: лимит бюджета" : ""}`;
      if (j.status === "running") setTimeout(() => this.pollJob(id), 1500);
      else { toast(`Оценка завершена: ${j.done} ок, ${j.failed} ошибок`, j.failed ? "err" : "ok"); this.load(); }
      if ((j.done + j.failed) % 5 === 0) this.load();
    }
    onRoute(r) {
      if (this.items) this.drawRows();
      const card = this.querySelector("cqa-card");
      if (r.view === "conv" && r.arg) card.open(r.arg, r.sub);
      else card.empty();
    }
  }

  // ------------------------------------------------------------------ card
  class CqaCard extends HTMLElement {
    empty() { this.key = null; this.innerHTML = `<div class="placeholder">Выберите диалог слева, чтобы увидеть транскрипт и оценку.</div>`; }
    async open(key, sub) {
      const focus = sub && sub.startsWith("t") ? +sub.slice(1) : null;
      if (this.key !== key) {
        this.key = key;
        this.innerHTML = `<div class="placeholder">Загрузка…</div>`;
        try { this.data = await P().conversation(key); } catch (e) { this.innerHTML = `<div class="placeholder err">${esc(e.message)}</div>`; return; }
        this.draw();
      }
      if (focus !== null) this.focusTurn(focus, true);
    }
    async reload() { this.data = await P().conversation(this.key); this.draw(); window.CQA.refreshAppealCount && window.CQA.refreshAppealCount(); }
    draw() {
      const { conversation: c, evaluation: ev, facts } = this.data;
      const isCall = c.channel === "voice call";
      this.innerHTML = `
        <div class="card">
          <div class="card-head">
            <div>
              <h2>${esc(c.conversation_id)}</h2>
              <div class="meta">${isCall ? "Звонок" : "Чат"} · ${esc(c.language)} · ${c.turns.length} реплик · длительность ${esc(facts.duration)}${facts.first_response_sec != null ? ` · первый ответ оператора через ${facts.first_response_sec} с` : ""}</div>
            </div>
            <div class="head-actions">
              <button id="re-eval">${ev ? "Переоценить" : "Оценить"}</button>
            </div>
          </div>
          <div class="card-body">
            <div class="results">${ev ? this.resultsHtml(ev) : `<div class="placeholder">Диалог ещё не оценён. Нажмите «Оценить».</div>`}</div>
            <div class="transcript">
              ${isCall && c.audio_url ? `<div class="player"><audio id="audio" controls preload="none" src="${P().audioUrl(this.key)}"></audio><div id="wave" class="wave"><span class="muted small">Загрузка волны записи…</span></div></div>` : ""}
              <details class="timing" ${isCall ? "" : "open"}><summary>Скорость ответов оператора</summary><div id="delays"></div></details>
              ${isCall ? this.callFactsHtml(facts) : ""}
              <div class="turns">${this.turnsHtml(c, facts, isCall)}</div>
            </div>
          </div>
        </div>`;
      this.querySelector("#re-eval").onclick = () => this.evaluate();
      const audio = this.querySelector("#audio");
      if (audio) audio.ontimeupdate = () => { this.syncAudio(audio.currentTime); this.wave && this.wave.setTime(audio.currentTime); };
      const G = window.CQA.charts;
      this.querySelectorAll("[data-gauge]").forEach((g) => G.gauge(g, g.dataset.gauge === "" ? null : +g.dataset.gauge));
      G.delays(this.querySelector("#delays"), c.turns, { onPick: (i) => this.focusTurn(i, true) });
      if (ev) P().insights(ev.id).then((ins) => {
        const box = this.querySelector("#insights");
        if (!box) return;
        if (!ins) { box.remove(); return; }
        box.innerHTML = `${ins.summary ? `<div class="sum"><b>Суть:</b> ${esc(ins.summary)}</div>` : ""}
          ${ins.coaching && ins.coaching.length ? `<div class="coach"><b>Советы оператору</b><ul>${ins.coaching.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : `<div class="coach ok">Замечаний к оператору нет.</div>`}`;
      });
      if (isCall && c.audio_url) {
        const marks = {};
        if (ev) Object.entries(ev.results).forEach(([cid, r]) => (r.evidence || []).forEach((e) => {
          const cr = ev.checklist.criteria.find((x) => x.id === cid);
          marks[e.turn] = (marks[e.turn] ? marks[e.turn] + "; " : "") + (cr ? cr.title : cid);
        }));
        Promise.all([P().peaks(this.key), P().audioAnalysis(this.key)]).then(([pk, an]) => {
          if (an && an.aligned) {  // exact times from Whisper word alignment replace the estimate
            c.turns.forEach((t) => { const a = an.aligned[String(t.i)]; if (a) { t.audio_t = a.start; t.aligned = true; } });
            this.renderAudioPanel(an);
          }
          this.wave = G.waveform(this.querySelector("#wave"), pk.peaks, pk.duration, c.turns,
            { marks, onSeek: (sec) => this.seek(sec + 1), holds: (an && an.holds) || [], silences: (an && an.long_silences) || [] });
        }).catch((e) => { this.querySelector("#wave").innerHTML = `<span class="muted small">Волна недоступна: ${esc(e.message)}</span>`; });
      }
    }
    callFactsHtml(f) {
      const chip = (txt, cls = "") => `<span class="cf ${cls}">${txt}</span>`;
      const out = [];
      if (f.first_operator_turn_after_join != null) out.push(chip(`оператор подключился → первая реплика <a href="#/conv/${encodeURIComponent(this.key)}/t${f.first_operator_turn_after_join}" data-turn="${f.first_operator_turn_after_join}">t${f.first_operator_turn_after_join}</a>`));
      if (f.internal_operator_turns) out.push(chip("удержание: разговор с коллегой не оценивается", "muted"));
      if (f.ended_by_client_turn != null) out.push(chip(`клиент завершил звонок: <a href="#/conv/${encodeURIComponent(this.key)}/t${f.ended_by_client_turn}" data-turn="${f.ended_by_client_turn}">t${f.ended_by_client_turn}</a>`));
      if (f.operator_turns_after_client_hung_up) out.push(chip(`${f.operator_turns_after_client_hung_up.length} реплик оператора после конца звонка не услышаны`, "warn"));
      return out.length ? `<div class="callfacts">${out.join("")}</div>` : "";
    }
    turnsHtml(c, f, isCall) {
      const joined = isCall ? f.operator_joined_turn : null;
      if (joined == null) return c.turns.map((t) => this.turnHtml(t, isCall)).join("");
      const pre = c.turns.filter((t) => t.i < joined), rest = c.turns.filter((t) => t.i >= joined);
      if (!pre.length) return c.turns.map((t) => this.turnHtml(t, isCall)).join("");
      return `<details class="ivr"><summary>Голосовое меню и бот до подключения оператора: ${pre.length} реплик</summary>${pre.map((t) => this.turnHtml(t, isCall)).join("")}</details>`
        + rest.map((t) => this.turnHtml(t, isCall)).join("");
    }
    renderAudioPanel(an) {
      const host = this.querySelector(".player");
      if (!host || host.querySelector(".audio-panel")) return;
      const share = an.operator_talk_share;
      const mm = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, "0")}`;
      const r = an.speech_rate_wpm || {};
      host.insertAdjacentHTML("beforeend", `<div class="audio-panel">
        <div class="ap-row"><span class="muted small">Доля речи</span>
          <div class="share"><i style="width:${Math.round((share || 0) * 100)}%" title="оператор"></i></div>
          <span class="small">оператор ${Math.round((share || 0) * 100)}% · клиент ${Math.round((1 - (share || 0)) * 100)}%</span></div>
        <div class="ap-row"><span class="muted small">Темп речи</span><span class="small">оператор ${r.operator ?? "—"} сл/мин · клиент ${r.client ?? "—"} сл/мин</span></div>
        <div class="ap-row"><span class="muted small">Паузы</span><span class="small">${(an.longest_silences || []).map((g) => `<a href="#" data-seek="${g.at}">${g.seconds} с в ${mm(g.at)}</a>`).join(" · ")}</span></div>
        <div class="muted small">Время реплик выровнено по словам записи (Whisper, ${an.aligned_turns} реплик)${an.timestamp_estimate_error_sec != null ? `; оценка по системным меткам ошибалась в среднем на ${an.timestamp_estimate_error_sec} с` : ""}.</div>
      </div>`);
    }
    turnHtml(t, isCall) {
      const time = isCall ? (t.t != null ? new Date(t.t * 1000).toISOString().substr(14, 5) : "") : t.timestamp;
      const who = t.internal ? "Оператор ↔ коллега (клиент на удержании, не оценивается)" : (SPK[t.speaker] || esc(t.speaker));
      return `<div class="turn ${t.speaker}${t.internal ? " internal" : ""}" id="turn-${t.i}" data-i="${t.i}">
        <div class="tmeta"><a class="tid" href="#/conv/${encodeURIComponent(this.key)}/t${t.i}">t${t.i}</a> ${who} · ${esc(time)}${isCall && t.audio_t != null ? ` <button class="seek" data-seek="${t.audio_t}" title="Слушать с этого места">▶</button>` : ""}</div>
        <div class="ttext">${esc(t.text)}</div></div>`;
    }
    resultsHtml(ev) {
      const cl = ev.checklist, fs = ev.final_score, os = ev.original_score;
      const changed = fs.total !== os.total;
      const secs = fs.sections.map((s) => `<div class="sec"><span>${esc(s.title)}</span><span class="bar"><i style="width:${s.percent ?? 0}%"></i></span><b>${s.percent == null ? "N/A" : fmt(s.percent) + "%"}</b><span class="muted small">${fmt(s.points)} из ${fmt(s.max_points)}</span></div>`).join("");
      return `
        <div class="scorebox">
          <div class="total ${fs.total == null ? "none" : fs.total >= 85 ? "good" : fs.total >= 60 ? "mid" : "bad"}">
            <div class="gauge" data-gauge="${fs.total ?? ""}"></div><div class="lbl">${changed ? "итог после апелляций" : "итоговый балл"} из 100</div>
            ${changed ? `<div class="orig">исходно ${fmt(os.total)}</div>` : ""}
          </div>
          <div class="score-side">
            ${fs.gross_error ? `<div class="gross">⚑ Грубая ошибка выявлена${fs.gross_error_policy === "zero_total" ? " — итог обнулён" : " (отмечается отдельно)"}</div>` : `<div class="nogross">Грубых ошибок не выявлено</div>`}
            ${fs.total == null ? `<div class="muted">Итог не рассчитывается: нет применимых критериев с весом.</div>` : ""}
            ${fs.na_criteria.length ? `<div class="muted small">N/A: ${fs.na_criteria.map((id) => esc((cl.criteria.find((c) => c.id === id) || {}).title || id)).join(", ")} — вес перераспределён (применимый вес ${fmt(fs.applicable_weight)} → 100)</div>` : ""}
            <div class="secs">${secs}</div>
            <div class="muted small">Чек-лист v${ev.checklist_version} · ${esc(ev.model.startsWith("router") ? "маршрутизатор Sonnet + Qwen" : modelLabel(ev.model))} · оценка #${ev.id}${ev.cost_usd ? ` · $${ev.cost_usd.toFixed(4)}` : ""}</div>
          </div>
        </div>
        <div class="insights" id="insights"><span class="muted small">Готовим краткое содержание и советы оператору…</span></div>
        <div class="crits">${cl.criteria.map((c) => this.critHtml(c, ev)).join("")}</div>`;
    }
    critHtml(c, ev) {
      const r = ev.results[c.id] || {};
      const fa = ev.final_answers[c.id];
      const sc = ev.final_score.criteria[c.id] || {};
      const aps = ev.appeals.filter((a) => a.criterion_id === c.id);
      const changed = fa !== r.answer;
      const ev_chips = (r.evidence || []).map((e) => `<a class="chip ${e.speaker}" href="#/conv/${encodeURIComponent(this.key)}/t${e.turn}" data-turn="${e.turn}" title="Перейти к реплике">t${e.turn} · ${SPK[e.speaker] || ""}: «${esc(e.quote)}»</a>`).join("");
      const span = r.answer === "no" && r.checked_span && r.checked_span.length === 2
        ? `<div class="span">Проверенный участок: <a href="#" data-range="${r.checked_span[0]}-${r.checked_span[1]}">t${r.checked_span[0]}–t${r.checked_span[1]}</a>${r.expected_turn >= 0 ? `, действие ожидалось в <a href="#/conv/${encodeURIComponent(this.key)}/t${r.expected_turn}" data-turn="${r.expected_turn}">t${r.expected_turn}</a>` : ""}</div>` : "";
      const pts = c.gross ? "без баллов" : fa === "na" ? `вес ${fmt(c.weight)} перераспределён` : `${fmt(sc.points)} из ${fmt(sc.effective_weight)} <span class="muted">(вес ${fmt(c.weight)})</span>`;
      return `<div class="crit ${r.needs_review ? "review" : ""}" id="crit-${c.id}">
        <div class="crit-head">
          <div><div class="ctitle">${esc(c.title)}</div><div class="muted small">${esc((ev.checklist.sections.find((s) => s.id === c.section) || {}).title || "")}</div></div>
          <div class="ans">
            ${changed ? `<span class="badge ${answerClass(c, r.answer)} struck">${answerLabel(c, r.answer)}</span>→` : ""}
            <span class="badge ${answerClass(c, fa)}">${answerLabel(c, fa)}</span>
            <div class="pts">${pts}</div>
          </div>
        </div>
        <div class="expl">${esc(r.explanation || "")}</div>
        ${r.answer === "na" && r.na_reason ? `<div class="na">Причина N/A: ${esc(r.na_reason)}</div>` : ""}
        ${ev_chips ? `<div class="chips">${ev_chips}</div>` : ""}
        ${span}
        ${r.needs_review ? `<div class="rev">⚠ Требует проверки${r.confidence === "low" ? " (низкая уверенность модели)" : ""}${(r.errors || []).length ? ": " + esc(r.errors.join("; ")) : ""}</div>` : ""}
        ${(r.validator_notes || []).length ? `<div class="muted small">Валидатор: ${esc(r.validator_notes.join("; "))}</div>` : ""}
        ${aps.map((a) => `<div class="appeal ${a.status}">
            <b>Апелляция #${a.id}</b> (${a.status === "open" ? "ожидает решения" : a.decision === "change" ? "оценка изменена" : "оценка подтверждена"}): «${esc(a.comment)}»
            ${a.status === "decided" ? `<div>Решение проверяющего: <b>${answerLabel(c, a.new_answer)}</b> — ${esc(a.reason)}</div>` : ""}</div>`).join("")}
        <div class="crit-actions">
          <span class="muted small">${esc(modelLabel(r.model))}${r.vote_share != null ? ` · <span class="votes" title="${esc(JSON.stringify(r.votes || {}))}">${voteDots(r.vote_share)} ${Math.round(r.vote_share * 5)} из 5 голосов</span>` : ` · уверенность: ${esc(r.confidence || "—")}`}</span>
          ${aps.some((a) => a.status === "open") ? "" : `<button class="ghost small" data-appeal="${c.id}">Оспорить</button>`}
        </div>
        <form class="appeal-form hidden" data-form="${c.id}">
          <textarea name="comment" rows="2" placeholder="Почему оценка неверна? (обязательно)"></textarea>
          <div><button type="submit">Подать апелляцию</button> <button type="button" class="ghost" data-cancel="${c.id}">Отмена</button></div>
        </form>
      </div>`;
    }
    onClick = async (e) => {
      const a = e.target.closest("[data-turn],[data-range],[data-seek],[data-appeal],[data-cancel]");
      if (!a) return;
      if (a.dataset.turn !== undefined) { e.preventDefault(); history.replaceState(null, "", a.getAttribute("href")); this.focusTurn(+a.dataset.turn, true); }
      else if (a.dataset.range) { e.preventDefault(); const [x, y] = a.dataset.range.split("-").map(Number); this.focusRange(x, y); }
      else if (a.dataset.seek) { e.preventDefault(); this.seek(+a.dataset.seek); }
      else if (a.dataset.appeal) { this.querySelector(`[data-form="${a.dataset.appeal}"]`).classList.remove("hidden"); }
      else if (a.dataset.cancel) { this.querySelector(`[data-form="${a.dataset.cancel}"]`).classList.add("hidden"); }
    };
    connectedCallback() {
      this.addEventListener("click", this.onClick);
      this.addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target, cid = f.dataset.form, comment = f.comment.value.trim();
        if (!comment) { toast("Добавьте комментарий", "err"); return; }
        try { await P().appeal(this.data.evaluation.id, cid, comment); toast("Апелляция сохранена — она появилась у проверяющего", "ok"); await this.reload(); }
        catch (err) { toast(err.message, "err"); }
      });
      if (!this.key) this.empty();
    }
    focusTurn(i, seekAudio) {
      this.querySelectorAll(".turn.hl").forEach((x) => x.classList.remove("hl"));
      const el = this.querySelector(`#turn-${i}`);
      if (!el) return;
      const det = el.closest("details"); if (det) det.open = true;
      el.classList.add("hl"); el.scrollIntoView({ behavior: "smooth", block: "center" });
      const t = this.data.conversation.turns[i];
      if (seekAudio && t && t.audio_t != null && this.querySelector("#audio")) this.seek(t.audio_t);
    }
    focusRange(x, y) {
      this.querySelectorAll(".turn.hl").forEach((el) => el.classList.remove("hl"));
      for (let i = x; i <= y; i++) { const el = this.querySelector(`#turn-${i}`); if (el) el.classList.add("hl"); }
      const first = this.querySelector(`#turn-${x}`); if (first) first.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    seek(sec) {
      const a = this.querySelector("#audio"); if (!a) return;
      const go = () => { a.currentTime = Math.max(0, sec - 1); a.play().catch(() => {}); };
      if (a.readyState >= 1) go(); else { a.preload = "auto"; a.addEventListener("loadedmetadata", go, { once: true }); a.load(); }
    }
    syncAudio(t) {
      const turns = this.data.conversation.turns.filter((x) => x.audio_t != null && x.audio_t <= t + 0.5);
      const cur = turns[turns.length - 1];
      this.querySelectorAll(".turn.playing").forEach((x) => x.classList.remove("playing"));
      if (cur) { const el = this.querySelector(`#turn-${cur.i}`); if (el) el.classList.add("playing"); }
    }
    async evaluate() {
      const btn = this.querySelector("#re-eval"); btn.disabled = true; btn.textContent = "Оценка…";
      try {
        const job = await P().evaluate({ keys: [this.key], provider: store.provider });
        let j = job;
        while (j.status === "running") { await new Promise((r) => setTimeout(r, 1200)); j = await P().job(job.id); }
        if (j.failed) toast("Ошибка оценки: " + j.errors.join("; "), "err"); else toast("Оценка готова", "ok");
        await this.reload();
        const list = document.querySelector("cqa-dialogs"); if (list) list.load();
      } catch (e) { toast(e.message, "err"); btn.disabled = false; }
    }
  }

  // ------------------------------------------------------------------ appeals (reviewer)
  class CqaAppeals extends HTMLElement {
    connectedCallback() { this.status = "open"; this.load(); }
    async load() {
      const items = await P().appeals(this.status === "all" ? null : this.status);
      const views = {};
      for (const a of items) if (!views[a.evaluation_id]) views[a.evaluation_id] = await P().evaluation(a.evaluation_id);
      const convs = {};
      for (const a of items) if (!convs[a.conv_id]) convs[a.conv_id] = (await P().conversation(a.conv_id)).conversation;
      this.innerHTML = `
        <section class="page">
          <div class="page-head"><h2>Апелляции — рабочее место проверяющего</h2>
            <div class="seg">${["open", "decided", "all"].map((s) => `<button class="${this.status === s ? "on" : "ghost"}" data-s="${s}">${{ open: "Ожидают", decided: "Решённые", all: "Все" }[s]}</button>`).join("")}</div></div>
          ${items.length ? items.map((a) => this.itemHtml(a, views[a.evaluation_id], convs[a.conv_id])).join("") : `<p class="muted">Апелляций нет. Оспорить оценку можно в карточке диалога (кнопка «Оспорить» у критерия).</p>`}
        </section>`;
      this.querySelectorAll("[data-s]").forEach((b) => (b.onclick = () => { this.status = b.dataset.s; this.load(); }));
      this.querySelectorAll("form").forEach((f) => (f.onsubmit = (e) => this.decide(e)));
      this.querySelectorAll("select[name=decision]").forEach((s) => (s.onchange = () => { s.form.new_answer.disabled = s.value !== "change"; }));
    }
    itemHtml(a, v, conv) {
      const c = v.checklist.criteria.find((x) => x.id === a.criterion_id) || { title: a.criterion_id, type: "binary", scale: [] };
      const r = v.results[a.criterion_id] || {};
      const ctxTurns = new Set();
      (r.evidence || []).forEach((e) => { ctxTurns.add(e.turn - 1); ctxTurns.add(e.turn); ctxTurns.add(e.turn + 1); });
      if (r.expected_turn >= 0) ctxTurns.add(r.expected_turn);
      const frag = conv.turns.filter((t) => ctxTurns.has(t.i)).map((t) => `<div class="turn ${t.speaker} mini"><div class="tmeta">t${t.i} ${SPK[t.speaker]}</div><div class="ttext">${esc(t.text)}</div></div>`).join("");
      return `<div class="appeal-card ${a.status}">
        <div class="ap-head"><b>#${a.id} · ${esc(conv.conversation_id)}</b> · ${esc(c.title)}
          <a href="#/conv/${encodeURIComponent(a.conv_id)}" class="small">открыть карточку →</a></div>
        <div class="ap-grid">
          <div>
            <div>Спорная оценка: <span class="badge ${answerClass(c, r.answer)}">${answerLabel(c, r.answer)}</span></div>
            <div class="expl">${esc(r.explanation || "")}</div>
            <div class="comment">Комментарий заявителя: «${esc(a.comment)}»</div>
            <div class="muted small">Итог: исходно ${fmt(v.original_score.total)} → сейчас ${fmt(v.final_score.total)}</div>
          </div>
          <div class="frag">${frag || '<span class="muted">Нет цитат — см. карточку</span>'}</div>
        </div>
        ${a.status === "open" ? `<form data-id="${a.id}" class="decide">
            <select name="decision"><option value="confirm">Подтвердить оценку</option><option value="change">Изменить оценку</option></select>
            <select name="new_answer" disabled>${answerOptions(c).map((o) => `<option value="${o}">${answerLabel(c, o)}</option>`).join("")}</select>
            <input name="reason" placeholder="Причина решения (обязательно)" required>
            <button type="submit">Сохранить решение</button></form>`
          : `<div class="decided">Решение: <b>${a.decision === "change" ? "изменено на " + answerLabel(c, a.new_answer) : "подтверждено"}</b> — ${esc(a.reason)}</div>`}
      </div>`;
    }
    async decide(e) {
      e.preventDefault();
      const f = e.target;
      try {
        const v = await P().decide(f.dataset.id, { decision: f.decision.value, new_answer: f.new_answer.value, reason: f.reason.value });
        toast(`Решение сохранено. Итог: ${fmt(v.original_score.total)} → ${fmt(v.final_score.total)}`, "ok");
        window.CQA.refreshAppealCount && window.CQA.refreshAppealCount();
        this.load();
      } catch (err) { toast(err.message, "err"); }
    }
  }

  // ------------------------------------------------------------------ checklist editor
  class CqaChecklist extends HTMLElement {
    connectedCallback() {
      this.addEventListener("click", this.onClick);
      this.addEventListener("change", (e) => { if (e.target.name === "type") { this.collect(); this.draw(); } });
      this.load();
    }
    async load(version) {
      this.versions = await P().checklists();
      this.cl = await P().checklist(version || (this.versions[0] || {}).version);
      this.base = JSON.parse(JSON.stringify(this.cl));
      this.draw();
    }
    draw() {
      const cl = this.cl;
      this.innerHTML = `
        <section class="page">
          <div class="page-head"><h2>Чек-лист</h2>
            <label>Версия <select id="ver">${this.versions.map((v) => `<option value="${v.version}" ${v.version === cl.version ? "selected" : ""}>v${v.version} — ${esc(v.note || v.name)}</option>`).join("")}</select></label>
          </div>
          <div class="cl-top">
            <label>Название <input id="cl-name" size="32" value="${esc(cl.name)}"></label>
            <label>Грубая ошибка <select id="cl-gross"><option value="flag">отмечается отдельно</option><option value="zero_total">обнуляет итог</option></select></label>
            <label>Округление итога <input id="cl-round" type="number" min="0" max="4" value="${cl.rounding ?? 2}"></label>
          </div>
          <div id="crits">${cl.criteria.map((c, i) => this.critForm(c, i)).join("")}</div>
          <div class="cl-actions">
            <button class="ghost" id="add">+ Добавить критерий</button>
            <span class="grow"></span>
            <input id="note" placeholder="Комментарий к версии (что изменено)">
            <button id="save">Сохранить как новую версию</button>
          </div>
          <div id="apply" class="apply hidden"></div>
        </section>`;
      this.querySelector("#cl-gross").value = cl.gross_error_policy || "flag";
      this.querySelector("#ver").onchange = (e) => this.load(+e.target.value);
      this.querySelector("#add").onclick = () => { this.collect(); this.cl.criteria.push({ id: this.newId(), section: (cl.sections[0] || {}).id, title: "Новый критерий", type: "binary", weight: 10, na_allowed: false, gross: false, description: "", na_condition: "", scale: [], guidelines: [] }); this.draw(); this.querySelector("#crits").lastElementChild.scrollIntoView({ behavior: "smooth" }); };
      this.querySelector("#save").onclick = () => this.save();
    }
    newId() { let n = this.cl.criteria.length + 1; while (this.cl.criteria.some((c) => c.id === "c" + n)) n++; return "c" + n; }
    critForm(c, i) {
      const secs = this.cl.sections.map((s) => `<option value="${s.id}" ${s.id === c.section ? "selected" : ""}>${esc(s.title)}</option>`).join("");
      return `<fieldset class="cform" data-i="${i}">
        <div class="crow">
          <input name="id" value="${esc(c.id)}" class="w-id" title="ID">
          <input name="title" value="${esc(c.title)}" class="grow" placeholder="Название">
          <select name="section">${secs}</select>
          <select name="type"><option value="binary" ${c.type === "binary" ? "selected" : ""}>Да / Нет</option><option value="scale" ${c.type === "scale" ? "selected" : ""}>Шкала</option></select>
          <label class="w-n">Вес <input name="weight" type="number" min="0" step="1" value="${c.weight}"></label>
          <label><input name="na_allowed" type="checkbox" ${c.na_allowed ? "checked" : ""}> N/A</label>
          <label><input name="gross" type="checkbox" ${c.gross ? "checked" : ""}> грубая</label>
          <button type="button" class="ghost small" data-del="${i}" title="Удалить критерий">✕</button>
        </div>
        <label class="fl">Формулировка (когда «Да»)</label>
        <textarea name="description" rows="2" placeholder="Да — оператор …">${esc(c.description)}</textarea>
        <label class="fl">Условие N/A${c.na_allowed ? "" : " (N/A не разрешён)"}</label>
        <input name="na_condition" value="${esc(c.na_condition || "")}" placeholder="Когда критерий неприменим">
        ${c.type === "scale" ? `<div class="scale">${(c.scale || []).map((s, j) => `<div class="srow" data-j="${j}"><input name="sv" type="number" value="${s.value}" class="w-n"><input name="sl" value="${esc(s.label)}" class="grow"><button type="button" class="ghost small" data-sdel="${i}:${j}">✕</button></div>`).join("")}
          <button type="button" class="ghost small" data-sadd="${i}">+ ступень</button></div>` : ""}
        <label class="fl">Пояснения для оценщика (по одному в строке)</label>
        <textarea name="guidelines" rows="3" placeholder="Например: общие вопросы о тарифах не требуют идентификации">${esc((c.guidelines || []).join("\n"))}</textarea>
      </fieldset>`;
    }
    onClick = (e) => {
      const b = e.target.closest("[data-del],[data-sadd],[data-sdel]");
      if (!b) return;
      this.collect();
      if (b.dataset.del !== undefined) this.cl.criteria.splice(+b.dataset.del, 1);
      if (b.dataset.sadd !== undefined) this.cl.criteria[+b.dataset.sadd].scale.push({ value: 0, label: "" });
      if (b.dataset.sdel) { const [i, j] = b.dataset.sdel.split(":").map(Number); this.cl.criteria[i].scale.splice(j, 1); }
      this.draw();
    };
    collect() {
      const cl = this.cl;
      cl.name = this.querySelector("#cl-name").value;
      cl.gross_error_policy = this.querySelector("#cl-gross").value;
      cl.rounding = +this.querySelector("#cl-round").value;
      cl.criteria = [...this.querySelectorAll("fieldset.cform")].map((f) => {
        const g = (n) => f.querySelector(`[name=${n}]`);
        const old = cl.criteria[+f.dataset.i] || {};
        return {
          ...old, id: g("id").value.trim(), title: g("title").value.trim(), section: g("section").value, type: g("type").value,
          weight: +g("weight").value, na_allowed: g("na_allowed").checked, gross: g("gross").checked,
          description: g("description").value.trim(), na_condition: g("na_condition").value.trim(),
          scale: g("type").value === "scale" ? [...f.querySelectorAll(".srow")].map((r) => ({ value: +r.querySelector("[name=sv]").value, label: r.querySelector("[name=sl]").value.trim() })) : [],
          guidelines: g("guidelines").value.split("\n").map((s) => s.trim()).filter(Boolean),
        };
      });
    }
    changedIds() {
      const key = (c) => JSON.stringify([c.title, c.type, c.weight, c.na_allowed, c.gross, c.description, c.na_condition, c.scale, c.guidelines]);
      const before = Object.fromEntries(this.base.criteria.map((c) => [c.id, key(c)]));
      return this.cl.criteria.filter((c) => before[c.id] !== key(c)).map((c) => c.id);
    }
    async save() {
      this.collect();
      const changed = this.changedIds();
      const wsum = this.cl.criteria.filter((c) => !c.gross).reduce((s, c) => s + (+c.weight || 0), 0);
      try {
        const { version } = await P().saveChecklist(this.cl, this.querySelector("#note").value || `изменены: ${changed.join(", ") || "параметры"}`);
        toast(`Сохранена версия v${version}`, "ok");
        await this.load(version);
        const ap = this.querySelector("#apply");
        ap.classList.remove("hidden");
        ap.innerHTML = `<div>Версия <b>v${version}</b> сохранена. Изменённые критерии: <b>${changed.join(", ") || "—"}</b>. Сумма весов: ${wsum}${wsum !== 100 ? " (итог всё равно нормируется к 100)" : ""}.
          При применении заново оцениваются только изменённые критерии, остальные берутся из кэша.</div>
          <button id="apply-btn">Применить v${version} к набору ${esc(store.group)}</button> <span id="apply-st" class="muted"></span>`;
        this.querySelector("#apply-btn").onclick = () => this.apply(version);
      } catch (e) { toast("Не сохранено: " + e.message, "err"); }
    }
    async apply(version) {
      const st = this.querySelector("#apply-st");
      try {
        let j = await P().evaluate({ group_id: store.group, version, provider: store.provider });
        const t0 = Date.now();
        while (j.status === "running") { st.textContent = `${j.done + j.failed}/${j.total}…`; await new Promise((r) => setTimeout(r, 1200)); j = await P().job(j.id); }
        st.innerHTML = `Готово за ${Math.round((Date.now() - t0) / 1000)} с: ${j.done} диалогов${j.failed ? `, ошибок ${j.failed}` : ""}. <a href="#/convs">К списку диалогов →</a>`;
      } catch (e) { toast(e.message, "err"); }
    }
  }

  // ------------------------------------------------------------------ costs & metrics
  class CqaCosts extends HTMLElement {
    async connectedCallback() {
      const [b, h, m] = await Promise.all([P().budget(), P().health(), P().metrics()]);
      const rows = b.by_model.map((r) => `<tr><td>${esc(r.provider)}</td><td>${esc(r.model)}</td><td>${r.n}</td><td>${r.convs}</td><td>${r.inp}</td><td>${r.out}</td><td>$${(r.cost || 0).toFixed(4)}</td><td>${r.convs ? "$" + ((r.cost || 0) / r.convs).toFixed(4) : "—"}</td></tr>`).join("");
      this.innerHTML = `<section class="page">
        <h2>Модель и расходы</h2>
        <p>Основная модель: <b>${esc(h.claude_model)}</b> (Claude API). Альтернатива: локальная модель на GPU-кластере (vLLM), данные не покидают контур.
        Лимит расходов на Claude API: <b>$${b.cap_usd.toFixed(2)}</b>, израсходовано <b>$${b.spent_usd.toFixed(4)}</b> — вызов, который может превысить лимит, блокируется.</p>
        <table class="tbl"><thead><tr><th>Провайдер</th><th>Модель</th><th>Вызовов</th><th>Диалогов</th><th>Вход, ток.</th><th>Выход, ток.</th><th>Стоимость</th><th>≈ на диалог</th></tr></thead><tbody>${rows}</tbody></table>
        ${m ? `<h3>Качество на эталонной разметке</h3>${m.html || ""}` : ""}
      </section>`;
    }
  }

  // ------------------------------------------------------------------ analytics dashboard
  class CqaDash extends HTMLElement {
    async connectedCallback() {
      this.innerHTML = `<section class="page wide"><div class="placeholder">Загрузка аналитики…</div></section>`;
      const a = await P().analytics(store.group).catch((e) => ({ error: e.message }));
      if (a.error) { this.innerHTML = `<section class="page"><p class="err">${esc(a.error)}</p></section>`; return; }
      const tiles = [
        ["Оценено диалогов", `${a.n_evaluated} / ${a.n_dialogues}`, ""],
        ["Средний итог", fmt(a.mean_total), "из 100"],
        ["Грубые ошибки", a.gross.length, a.gross.length ? "диалогов с флагом" : "не выявлено"],
        ["Требуют проверки", a.needs_review, "критериев с сомнением"],
        ["Апелляции", `${a.appeals_open} / ${a.appeals_decided}`, "открыто / решено"],
        ["Стоимость набора", "$" + (a.cost_usd || 0).toFixed(3), Object.keys(a.models).join(", ")],
      ];
      this.innerHTML = `<section class="page wide">
        <div class="page-head"><h2>Аналитика набора ${esc(store.group)}</h2><span class="muted small">наведите на график, чтобы увидеть значения; клик по диалогу открывает карточку</span></div>
        <div class="tiles">${tiles.map(([l, v, s]) => `<div class="tile"><div class="tl">${l}</div><div class="tv">${v}</div><div class="ts">${esc(s)}</div></div>`).join("")}</div>
        <div class="grid2">
          <div class="panel"><h3>Распределение итоговых баллов</h3><div id="hist"></div></div>
          <div class="panel"><h3>Исходы по критериям</h3><div id="outc"></div></div>
          <div class="panel"><h3>Средний итог по языку и каналу</h3><div id="lang"></div></div>
          <div class="panel"><h3>Требуют внимания</h3>
            <div class="flaglist">${a.gross.map((c) => `<a class="chip bad" href="#/conv/${encodeURIComponent(store.group + ":" + c)}">⚑ ${esc(c)} — грубая ошибка</a>`).join("")}
            ${a.worst.map((w) => `<a class="chip" href="#/conv/${encodeURIComponent(w.key)}">${esc(w.cid)} — ${fmt(w.total)} баллов</a>`).join("")}</div></div>
        </div></section>`;
      const G = window.CQA.charts;
      G.histogram(this.querySelector("#hist"), a.totals);
      G.outcomes(this.querySelector("#outc"), a.criteria);
      const L = { RU: "Русский", KZ: "Казахский", EN: "Английский", "agent chat": "Чаты", "voice call": "Звонки" };
      G.hbars(this.querySelector("#lang"), [
        ...Object.entries(a.by_language).map(([k, v]) => ({ label: `${L[k] || k} (${v.n})`, value: v.mean, color: G.C.s1 })),
        ...Object.entries(a.by_channel).map(([k, v]) => ({ label: `${L[k] || k} (${v.n})`, value: v.mean, color: G.C.s2 })),
      ], { unit: "", label: "Средний итог" });
    }
  }

  // ------------------------------------------------------------------ experiments lab
  const VNAME = {
    "app:claude-sonnet-5-5": "Claude Sonnet 5.5", "app:local:Qwen3.5-35B-A3B-GPTQ-Int4": "Qwen3.5-35B (локально)",
    router_sonnet_qwensc5: "Маршрутизатор Sonnet + Qwen×5", router_sonnet_qwen: "Маршрутизатор Sonnet + Qwen",
    router_sonnet_qwensc5_haiku: "Маршрутизатор Sonnet + Qwen×5 + Haiku", router_free_local: "Маршрутизатор: только GPU",
    router_cheap: "Маршрутизатор: Haiku + GPU", router_all: "Маршрутизатор: все", jury_sonnet_qwen_haiku: "Жюри Sonnet/Qwen/Haiku",
    qwen_sub_sc5: "Qwen + подвопросы × 5",
    haiku: "Claude Haiku 5.5", haiku_sub: "Haiku + подвопросы", qwen: "Qwen", qwen_sc5: "Qwen × 5 голосов",
    qwen_sub: "Qwen + подвопросы", qwen_sub_sc5: "Qwen + подвопросы × 5", qwen_percrit: "Qwen, критерий на запрос",
    qwen_gloss: "Qwen + перевод KZ→RU", gemma: "Gemma 3 27B (локально)", gemma_sc5: "Gemma × 5 голосов",
  };
  const vname = (k) => VNAME[k] || (k.startsWith("cascade_") ? k.replace(/^cascade_(qwen_sub_sc5|qwen_sc5)_to_sonnet@(.*)$/, (m, a, t) => `Каскад ${a === "qwen_sc5" ? "Qwen×5" : "Qwen+подвопросы×5"} → Sonnet (порог ${t})`) : null) || k.replace(/^cascade_/, "каскад ").replace(/^jury_/, "жюри ").replace(/^router_/, "маршрутизатор ").replace(/_/g, " ");
  class CqaLab extends HTMLElement {
    async connectedCallback() {
      const [ex, an, calls] = await Promise.all([P().experiments(), P().analysis(), P().callsResults()]);
      if (!ex) { this.innerHTML = `<section class="page"><p class="muted">Эксперименты ещё не запускались (python -m eval.experiments report).</p></section>`; return; }
      const names = Object.keys(ex).filter((k) => !k.startsWith("_") && ex[k].all && ex[k].all.n);
      const best = names.slice().sort((a, b) => ex[b].test.accuracy - ex[a].test.accuracy);
      const crits = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"].map((id, i) => ({ id, short: "К" + (i + 1), title: ["Контакт", "Потребность", "Идентификация", "Консультация", "Эмпатия", "Ведение", "Завершение", "Грубые"][i] }));
      this.innerHTML = `<section class="page wide">
        <div class="page-head"><h2>Эксперименты: какой способ оценки точнее</h2>
          <span class="muted small">эталон — 44 диалога; выбор делается на половине «dev», точность показана на отложенной половине «test»</span></div>
        <div class="grid2">
          <div class="panel"><h3>Точность на отложенной выборке</h3><div id="acc"></div></div>
          <div class="panel"><h3>Стоимость и точность</h3><div id="cost"></div></div>
          <div class="panel"><h3>Выборочная проверка человеком</h3><div id="risk"></div>
            <p class="muted small">Оценки сортируются по уверенности (доля совпавших голосов, самооценка модели). Проверяющий смотрит самые неуверенные — точность остальных растёт.</p></div>
          <div class="panel"><h3>Маршрутизатор: кто оценивает какой критерий</h3><div id="route"></div></div>
          <div class="panel span2"><h3>Точность по критериям (все 44 диалога)</h3><div id="heat"></div></div>
          ${an ? `<div class="panel span2 rel-head"><h3>Надёжность: насколько можно верить цифрам</h3>
            <p class="muted small">44 размеченных диалога — немного. Поэтому показываем 95% доверительные интервалы (bootstrap по диалогам), парный тест и порог автоприёма с гарантией.</p></div>
          <div class="panel"><h3>Точность и 95% доверительный интервал (все 44 диалога)</h3><div id="ci"></div>
            ${an.mcnemar_router_vs_sonnet ? `<p class="muted small">Маршрутизатор против Sonnet на тех же метках: ${an.mcnemar_router_vs_sonnet.a_right_b_wrong} : ${an.mcnemar_router_vs_sonnet.a_wrong_b_right} в пользу маршрутизатора, p = ${an.mcnemar_router_vs_sonnet.p_value} — направление ясно, для строгой значимости нужно больше разметки.</p>` : ""}</div>
          <div class="panel"><h3>Где ещё ошибается маршрутизатор</h3><div id="errs"></div>
            <p class="muted small">Ошибки по срезам: ${Object.entries(an.error_analysis_router.error_rate_by_slice).map(([k, v]) => `${esc(k)} ${(v * 100).toFixed(1)}%`).join(" · ")}</p></div>
          <div class="panel"><h3>Автоприём с гарантией (Trust or Escalate)</h3>
            <table class="tbl"><tr><th>Цель точности</th><th>Автоматически</th><th>Точность (test)</th><th>К человеку</th></tr>
            ${Object.entries(an.conformal).map(([t, c]) => `<tr><td>≥ ${esc(t)}</td><td>${c.threshold == null ? "недостижимо на 44 диалогах" : Math.round(c.test_auto_share * 100) + "%"}</td><td>${c.test_auto_accuracy == null ? "—" : (c.test_auto_accuracy * 100).toFixed(1) + "%"}</td><td>${c.test_to_human ?? "—"}</td></tr>`).join("")}</table>
            <p class="muted small">Порог уверенности выбран на половине «dev» по нижней 90%-границе Клоппера–Пирсона; проверен на «test».</p></div>
          <div class="panel"><h3>Калибровка шкал (RULERS)</h3>
            <table class="tbl"><tr><th>Модель</th><th>test до → после</th><th>ошибка итога</th></tr>
            ${Object.entries(an.calibration).map(([m, c]) => `<tr><td>${esc(m)}</td><td>${(c.test_before * 100).toFixed(1)}% → <b>${(c.test_after * 100).toFixed(1)}%</b></td><td>${c.mae_before} → ${c.mae_after}</td></tr>`).join("")}</table>
            <p class="muted small">Монотонное отображение «ступень модели → ступень человека» обучено на «dev». Помогает строгому Sonnet, маршрутизатору не нужно.</p></div>` : ""}
          ${calls ? `<div class="panel span2"><h3>Звонки: что помогает (5 реальных звонков × 8 критериев = 40 меток)</h3><div id="calls" style="max-width:900px"></div>
            <p class="muted small">Помогло: структура звонка и измерения по записи (тишина, удержание, кто завершил звонок), «Консультация» звонков → Sonnet. Не помогло: вторая расшифровка Whisper и коррекция ошибок распознавания (GER). Whisper слышит скрытые организаторами имена — используется только локально. Подробно: docs/calls.md.</p></div>` : ""}
          ${ex._memory ? `<div class="panel span2"><h3>Память апелляций: помогают ли прецеденты в промпте?</h3><div id="mem" style="max-width:760px"></div>
            <p class="muted small">9 ошибок маршрутизатора на половине «dev» превращены в решения проверяющего с причиной и добавлены в промпт; оценка на отложенных ${ex._memory.n_test_dialogues} диалогах. Не помогло — поэтому функция выключена по умолчанию, а повторяющиеся решения переносятся в пояснения критерия.</p></div>` : ""}
          <div class="panel span2"><h3>Таблица</h3><div class="tblwrap"><table class="tbl"><tr><th>Способ</th><th>dev</th><th>test</th><th>все</th><th>KZ</th><th>RU</th><th>EN</th><th>Звонки</th><th>ошибка итога</th><th>грубые (найдено/пропущено/ложно)</th><th>$ / диалог</th></tr>
          ${best.map((k) => { const a = ex[k].all, pl = a.per_language || {}, g = a.gross || {}; const p = (v) => (v == null ? "—" : Math.round(v * 1000) / 10 + "%");
            return `<tr><td>${esc(vname(k))}</td><td>${p(ex[k].dev.accuracy)}</td><td><b>${p(ex[k].test.accuracy)}</b></td><td>${p(a.accuracy)}</td><td>${p(pl.KZ)}</td><td>${p(pl.RU)}</td><td>${p(pl.EN)}</td><td>${p(pl.CALL)}</td><td>${fmt(a.total_mae)}</td><td>${g.tp || 0}/${g.fn || 0}/${g.fp || 0}</td><td>$${(a.usd_per_dialogue || 0).toFixed(4)}</td></tr>`; }).join("")}</table></div></div>
        </div></section>`;
      const G = window.CQA.charts;
      const colorOf = (k) => (k.includes("sonnet") || k.includes("haiku") ? (k.startsWith("cascade") || k.startsWith("jury") || k.startsWith("router") ? G.C.s3 : G.C.s2) : G.C.s1);
      G.hbars(this.querySelector("#acc"), best.slice(0, 12).map((k) => ({ label: vname(k).slice(0, 34), tip: vname(k), value: 100 * ex[k].test.accuracy, color: colorOf(k) })), { unit: "%", max: 100, labelWidth: 250 });
      this.querySelector("#acc").insertAdjacentHTML("beforeend", `<div class="viz-legend"><span><i style="background:${G.C.s1}"></i>локальные модели (GPU)</span><span><i style="background:${G.C.s2}"></i>Claude API</span><span><i style="background:${G.C.s3}"></i>комбинации (каскад, жюри, маршрутизатор)</span></div>`);
      G.costAccuracy(this.querySelector("#cost"), best.map((k, i) => ({ label: vname(k), cost: ex[k].all.usd_per_dialogue || 0, acc: ex[k].test.accuracy, color: colorOf(k), showLabel: i < 4 })));
      const rc = ex._risk_coverage || [];
      if (rc.length) G.riskCoverage(this.querySelector("#risk"), rc);
      const ch = (ex._router_choices || {})["app:claude-sonnet-5-5 + qwen_sc5"];
      if (ch) this.querySelector("#route").innerHTML = `<table class="tbl">${crits.map((c) => `<tr><td>${c.short} ${esc(c.title)}</td><td>${esc(vname(ch[c.id]))}</td></tr>`).join("")}</table>
        <p class="muted small">Выбор сделан на половине «dev»; новый или изменённый критерий оценивает Claude Sonnet 5.5.</p>`;
      if (an) {
        const colors = { "Маршрутизатор (рабочий прогон)": G.C.s3, "Claude Sonnet 5.5": G.C.s2, "Claude Haiku 5.5": G.C.s2 };
        G.ciBars(this.querySelector("#ci"), Object.entries(an.systems).map(([k, v]) => ({ label: k, acc: v.all[0], lo: v.all[1], hi: v.all[2], color: colors[k] || G.C.s1 })), { lo: 0.6, hi: 1.0 });
        const e = an.error_analysis_router, names = { c1: "Контакт", c2: "Потребность", c3: "Идентификация", c4: "Консультация", c5: "Эмпатия", c6: "Ведение", c7: "Завершение", c8: "Грубые" };
        G.errorBars(this.querySelector("#errs"), Object.entries(e.by_criterion).map(([k, n]) => ({ label: names[k] || k, total: n, near: (e.scale_one_step_off || {})[k] || 0 })));
      }
      if (calls) {
        const pick = [["base_qwen5", "Qwen × 5, как в чатах"], ["base_sonnet", "Sonnet, как в чатах"], ["router base (sonnet + qwen5)", "маршрутизатор, как в чатах"],
          ["whisper_qwen5", "Qwen + вторая расшифровка Whisper"], ["ger_qwen5", "Qwen + коррекция GER"], ["rules_qwen5", "Qwen + правила звонка"],
          ["rules_sonnet", "Sonnet + правила звонка"], ["router + call rules", "маршрутизатор + правила звонка"],
          ["router + call rules + consultation by LOO (sonnet)", "+ «Консультация» → Sonnet"], ["production (latest run)", "рабочий прогон после внедрения"]];
        G.hbars(this.querySelector("#calls"), pick.filter(([k]) => calls[k]).map(([k, l]) => ({ label: l, value: 100 * calls[k].accuracy,
          tip: `${l}: ${calls[k].correct}, ошибка итога ${calls[k].total_mae}`, color: k.includes("rules") || k.includes("production") ? G.C.s3 : (k.includes("whisper") || k.includes("ger") ? G.C.s2 : G.C.s1) })), { unit: "%", labelWidth: 300 });
      }
      if (ex._memory) {
        const m = ex._memory;
        G.hbars(this.querySelector("#mem"), [
          { label: "без прецедентов", value: 100 * m.without_memory.accuracy, color: G.C.s3 },
          { label: "причины пишет модель", value: 100 * m.with_memory.accuracy, color: G.C.s2 },
          ...(m.with_reviewer_memory ? [{ label: "причины пишет проверяющий", value: 100 * m.with_reviewer_memory.accuracy, color: G.C.s2 }] : []),
        ], { unit: "%", labelWidth: 230 });
      }
      G.heatmap(this.querySelector("#heat"), best.slice(0, 12).map((k) => ({ key: k, label: vname(k) })), crits, (r, c) => ex[r.key].all.per_criterion[c.id]);
    }
  }

  customElements.define("cqa-dash", CqaDash);
  customElements.define("cqa-lab", CqaLab);
  customElements.define("cqa-app", CqaApp);
  customElements.define("cqa-dialogs", CqaDialogs);
  customElements.define("cqa-card", CqaCard);
  customElements.define("cqa-appeals", CqaAppeals);
  customElements.define("cqa-checklist", CqaChecklist);
  customElements.define("cqa-costs", CqaCosts);
})();
