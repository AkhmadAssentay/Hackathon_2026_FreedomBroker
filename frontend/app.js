/* CQA UI — framework-free Web Components. Data only via window.CQA.provider. */
(function () {
  const P = () => window.CQA.provider;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (x, d = 2) => (x === null || x === undefined ? "—" : Number(x).toFixed(d).replace(/\.00$/, ""));
  const SPK = { client: "Клиент", operator: "Оператор", bot: "Бот", system: "Система", internal: "Оператор ↔ коллега" };
  const store = { group: localGet("group") || "DEV", provider: localGet("provider") || "claude", health: null };

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
  function answerOptions(crit) {
    const o = crit.type === "scale" ? crit.scale.map((s) => String(s.value)) : ["yes", "no"];
    if (crit.na_allowed) o.push("na");
    return o;
  }

  // ------------------------------------------------------------------ router
  function route() {
    const h = location.hash.replace(/^#\/?/, "");
    const [view, ...rest] = h.split("/");
    return { view: view || "convs", arg: rest.length ? decodeURIComponent(rest[0]) : null, sub: rest[1] || null };
  }

  // ------------------------------------------------------------------ app shell
  class CqaApp extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
        <header class="top">
          <div class="brand"><span class="logo">CQA</span><span>Оценка качества диалогов</span></div>
          <nav>
            <a href="#/convs" data-v="convs">Диалоги</a>
            <a href="#/checklist" data-v="checklist">Чек-лист</a>
            <a href="#/appeals" data-v="appeals">Апелляции <span class="pill" id="ap-count"></span></a>
            <a href="#/costs" data-v="costs">Модель и расходы</a>
          </nav>
          <div class="controls">
            <label>Набор <select id="group"></select></label>
            <button class="ghost" id="load">Загрузить group_id…</button>
            <label>Модель <select id="provider">
              <option value="claude">Claude API</option><option value="local">Локальная (HPC)</option></select></label>
          </div>
        </header>
        <main id="view"></main>`;
      this.querySelector("#provider").value = store.provider;
      this.querySelector("#provider").onchange = (e) => { store.provider = e.target.value; localSet("provider", store.provider); };
      this.querySelector("#group").onchange = (e) => { store.group = e.target.value; localSet("group", store.group); this.render(true); };
      this.querySelector("#load").onclick = () => this.loadGroup();
      window.addEventListener("hashchange", () => this.render());
      this.refreshGroups().then(() => this.render(true));
      P().health().then((h) => {
        store.health = h;
        if (!h.has_claude_key && store.provider === "claude") {
          store.provider = "local"; this.querySelector("#provider").value = "local";
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
      const tag = { convs: "cqa-dialogs", conv: "cqa-dialogs", checklist: "cqa-checklist", appeals: "cqa-appeals", costs: "cqa-costs" }[r.view] || "cqa-dialogs";
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
              ${isCall && c.audio_url ? `<div class="player"><audio id="audio" controls preload="none" src="${P().audioUrl(this.key)}"></audio><div class="muted small">Клик по ссылке-доказательству перематывает запись к реплике.</div></div>` : ""}
              <div class="turns">${c.turns.map((t) => this.turnHtml(t, isCall)).join("")}</div>
            </div>
          </div>
        </div>`;
      this.querySelector("#re-eval").onclick = () => this.evaluate();
      const audio = this.querySelector("#audio");
      if (audio) audio.ontimeupdate = () => this.syncAudio(audio.currentTime);
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
            <div class="num">${fs.total == null ? "—" : fmt(fs.total)}</div><div class="lbl">${changed ? "итог после апелляций" : "итоговый балл"} из 100</div>
            ${changed ? `<div class="orig">исходно ${fmt(os.total)}</div>` : ""}
          </div>
          <div class="score-side">
            ${fs.gross_error ? `<div class="gross">⚑ Грубая ошибка выявлена${fs.gross_error_policy === "zero_total" ? " — итог обнулён" : " (отмечается отдельно)"}</div>` : `<div class="nogross">Грубых ошибок не выявлено</div>`}
            ${fs.total == null ? `<div class="muted">Итог не рассчитывается: нет применимых критериев с весом.</div>` : ""}
            ${fs.na_criteria.length ? `<div class="muted small">N/A: ${fs.na_criteria.map((id) => esc((cl.criteria.find((c) => c.id === id) || {}).title || id)).join(", ")} — вес перераспределён (применимый вес ${fmt(fs.applicable_weight)} → 100)</div>` : ""}
            <div class="secs">${secs}</div>
            <div class="muted small">Чек-лист v${ev.checklist_version} · ${esc(ev.model)} · оценка #${ev.id}${ev.cost_usd ? ` · $${ev.cost_usd.toFixed(4)}` : ""}</div>
          </div>
        </div>
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
          <span class="muted small">уверенность: ${esc(r.confidence || "—")}</span>
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
      else if (a.dataset.seek) { this.seek(+a.dataset.seek); }
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

  customElements.define("cqa-app", CqaApp);
  customElements.define("cqa-dialogs", CqaDialogs);
  customElements.define("cqa-card", CqaCard);
  customElements.define("cqa-appeals", CqaAppeals);
  customElements.define("cqa-checklist", CqaChecklist);
  customElements.define("cqa-costs", CqaCosts);
})();
