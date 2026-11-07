/* CQA front-end — vanilla JS, no build step. Mounts into #cqa-root (embeddable as a Dynamics 365 web resource). */
(function () {
  'use strict';
  const root = document.getElementById('cqa-root');
  const API = (root.dataset.apiBase || '').replace(/\/$/, '') + '/api';

  // ---------------- utils ----------------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, el = root) => el.querySelector(sel);
  const $$ = (sel, el = root) => Array.from(el.querySelectorAll(sel));
  // Read-only demo mode: when there is no backend (static hosting such as Vercel), the UI shows a saved
  // snapshot of evaluated results (public/snapshot.json, made by scripts/export_snapshot.js).
  let SNAPSHOT = null;
  const modeReady = (async () => {
    // A cold start can fail once: retry before falling back to the read-only snapshot.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(API + '/config');
        if (r.ok && (r.headers.get('content-type') || '').includes('json')) return;
        if (r.status === 404) break; // static hosting without an API
      } catch { /* no backend */ }
      await new Promise((res) => setTimeout(res, 1500));
    }
    try {
      const r = await fetch('snapshot.json');
      if (r.ok) SNAPSHOT = await r.json();
    } catch { /* no snapshot either */ }
  })();
  async function api(path, opts = {}) {
    await modeReady;
    if (SNAPSHOT) {
      if (opts.method && opts.method !== 'GET') throw new Error('Демо-версия только для просмотра. Оценка, апелляции и изменение чек-листа работают при локальном запуске (npm start).');
      const v = SNAPSHOT.responses[path];
      if (v === undefined) throw new Error('Этих данных нет в демо-версии');
      return JSON.parse(JSON.stringify(v));
    }
    const res = await fetch(API + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, retryAfter: data.retry_after || null });
    return data;
  }
  let toastTimer;
  function toast(msg, err) {
    let t = $('.toast');
    if (!t) { t = document.createElement('div'); root.appendChild(t); }
    t.className = 'toast' + (err ? ' err' : '');
    t.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), err ? 7000 : 3500);
  }
  const scoreCls = (v) => (v === null || v === undefined ? 's-none' : v >= 85 ? 's-good' : v >= 60 ? 's-mid' : 's-bad');
  const scorePill = (v) => `<span class="score ${scoreCls(v)}">${v === null || v === undefined ? '—' : v}</span>`;
  function answerBadge(c, answer) {
    const a = answer;
    if (c.type === 'flag') return a === 'yes' ? '<span class="badge b-flag">Нарушение</span>' : '<span class="badge b-yes">Нет нарушений</span>';
    if (a === 'na') return '<span class="badge b-na">N/A</span>';
    if (a === 'yes') return '<span class="badge b-yes">Да</span>';
    if (a === 'no') return '<span class="badge b-no">Нет</span>';
    return `<span class="badge b-scale">${esc(a)}${c.scale_max ? ' / ' + c.scale_max : ''}</span>`;
  }
  const answerText = (a) => (a === 'yes' ? 'Да' : a === 'no' ? 'Нет' : a === 'na' ? 'N/A' : String(a));
  const statusLabel = { not_evaluated: 'Не оценён', evaluated: 'Оценён', appealed: 'Апелляция', reviewed: 'Пересмотрен', error: 'Ошибка' };
  const LS = { get: (k, d) => { try { return JSON.parse(localStorage.getItem('cqa.' + k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem('cqa.' + k, JSON.stringify(v)); } catch {} } };

  // ---------------- state ----------------
  const state = { config: null, openAppeals: 0 };

  // ---------------- layout ----------------
  function shell(active, inner) {
    const c = state.config || {};
    root.innerHTML = `
      <header class="top">
        <div class="logo"><span class="mark">Q</span>CQA <small>Freedom Broker</small></div>
        <nav>
          <a href="#/dialogs" class="${active === 'dialogs' ? 'on' : ''}">Диалоги</a>
          <a href="#/checklists" class="${active === 'checklists' ? 'on' : ''}">Чек-листы</a>
          <a href="#/appeals" class="${active === 'appeals' ? 'on' : ''}">Апелляции${state.openAppeals ? `<span class="count">${state.openAppeals}</span>` : ''}</a>
        </nav>
        <div class="right">
          <span class="chip-dark" title="Активный чек-лист">✓ ${esc(c.active_checklist || '—')}</span>
          <span class="chip-dark" title="Модель оценки">${c.provider === 'rules' ? 'Эвристика (без LLM)' : esc(c.provider + ' · ' + c.model)}</span>
        </div>
      </header>
      ${SNAPSHOT ? `<div class="demo-banner">Демо-версия только для просмотра: сохранённые результаты оценки ${c.snapshot ? c.snapshot.conversations : ''} ${c.snapshot && c.snapshot.calls_included ? 'диалогов (чаты и звонки)' : 'чатов'} набора ${esc(c.snapshot ? c.snapshot.group_id : '')} (модель ${esc(c.model || '')}, чек-лист ${esc(c.active_checklist || '')}, ${c.snapshot ? new Date(c.snapshot.created_at).toLocaleDateString('ru-RU') : ''}). Записи звонков в демо не публикуются. Оценка, апелляции и изменение чек-листа работают при локальном запуске.</div>` : ''}
      <main>${inner}</main>`;
  }

  async function refreshMeta() {
    try {
      state.config = await api('/config');
      const open = await api('/appeals?status=open');
      state.openAppeals = open.length;
    } catch (e) { /* ignore */ }
  }

  // ---------------- router ----------------
  async function router() {
    const h = location.hash.replace(/^#/, '') || '/dialogs';
    const [pathPart, qs] = h.split('?');
    const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
    const q = new URLSearchParams(qs || '');
    await refreshMeta();
    try {
      if (parts[0] === 'dialog') return await viewDialog(parts[1], parts[2], q);
      if (parts[0] === 'checklists') return await viewChecklists(parts[1]);
      if (parts[0] === 'appeals') return await viewAppeals(q.get('tab') || 'open');
      return await viewDialogs(q);
    } catch (e) {
      shell('', `<div class="panel empty">Ошибка: ${esc(e.message)}</div>`);
    }
  }
  window.addEventListener('hashchange', router);

  // =====================================================================
  // DIALOGS LIST
  // =====================================================================
  let pollTimer = null;
  async function viewDialogs(q) {
    clearInterval(pollTimer);
    const datasets = await api('/datasets');
    const group = q.get('group') || LS.get('group', null) || (datasets.find((d) => d.group_id === 'DEV') || datasets[0] || {}).group_id;
    if (group) LS.set('group', group);
    const filters = LS.get('filters', { lang: '', channel: '', q: '', status: '' });

    let list = null;
    if (group && datasets.some((d) => d.group_id === group)) list = await api('/conversations?group_id=' + encodeURIComponent(group));

    const items = list ? list.items : [];
    const evaluated = items.filter((i) => i.total !== null);
    const avg = evaluated.length ? (evaluated.reduce((s, i) => s + i.total, 0) / evaluated.length).toFixed(2) : '—';

    shell('dialogs', `
      <div class="row" style="margin-bottom:14px">
        <div><h1>Диалоги</h1><p class="sub" style="margin:0">Загрузите набор, запустите оценку и откройте карточку диалога.</p></div>
        <div class="spacer"></div>
        <label class="f">Набор
          <select id="grp">${datasets.map((d) => `<option ${d.group_id === group ? 'selected' : ''} value="${esc(d.group_id)}">${esc(d.group_id)} · ${d.total}</option>`).join('') || '<option>—</option>'}</select>
        </label>
        <label class="f">group_id из API<input id="gid" type="text" placeholder="DEV" style="width:110px"></label>
        <button class="btn" id="fetch">⇣ Загрузить из API</button>
        <label class="btn" style="cursor:pointer">⇪ JSON файл<input id="file" type="file" accept=".json,application/json" hidden></label>
      </div>
      ${list ? `
      <div class="panel" style="margin-bottom:12px">
        <div class="row">
          <div><b>${items.length}</b> <span class="muted">диалогов</span></div>
          <div><b>${evaluated.length}</b> <span class="muted">оценено</span></div>
          <div><span class="muted">средний балл</span> <b>${avg}</b></div>
          <div><b>${items.filter((i) => i.gross_error).length}</b> <span class="muted">с грубыми ошибками</span></div>
          <div class="muted small">чек-лист: <span class="mono">${esc(list.checklist_uid)}</span></div>
          <div class="spacer"></div>
          <div id="job" class="row small"></div>
          <button class="btn" id="evalMissing">Оценить неоценённые</button>
          <button class="btn primary" id="evalAll">Оценить все</button>
          <a class="btn" href="${SNAPSHOT ? 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(SNAPSHOT.responses['/export?group_id=' + encodeURIComponent(group)] || [])) : `${API}/export?group_id=${encodeURIComponent(group)}`}" ${SNAPSHOT ? `download="cqa_${esc(group)}.json"` : 'target="_blank"'}>Экспорт JSON</a>
        </div>
      </div>
      <div class="row" style="margin-bottom:10px">
        <input id="fq" type="text" placeholder="Поиск по ID" value="${esc(filters.q)}">
        <select id="flang"><option value="">Все языки</option>${['RU', 'KZ', 'EN'].map((l) => `<option ${filters.lang === l ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="fch"><option value="">Все каналы</option>${['agent chat', 'voice call'].map((l) => `<option ${filters.channel === l ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="fst"><option value="">Все статусы</option>${Object.entries(statusLabel).map(([k, v]) => `<option value="${k}" ${filters.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      </div>
      <table class="t"><thead><tr><th>ID диалога</th><th>Канал</th><th>Язык</th><th>Реплик</th><th>Итог</th><th>Грубые ошибки</th><th>Статус</th><th>Апелляции</th></tr></thead>
      <tbody id="rows"></tbody></table>` : `<div class="panel empty">Нет загруженных наборов. Загрузите DEV через API или JSON-файлом.</div>`}
    `);

    function renderRows() {
      const f = filters;
      const rows = items.filter((i) => (!f.lang || i.language === f.lang) && (!f.channel || i.channel === f.channel) && (!f.status || i.status === f.status) && (!f.q || i.conversation_id.toLowerCase().includes(f.q.toLowerCase())));
      $('#rows').innerHTML = rows.map((i) => `
        <tr class="click" data-id="${esc(i.conversation_id)}">
          <td class="mono">${esc(i.conversation_id)}</td>
          <td>${i.channel === 'voice call' ? '📞 звонок' : '💬 чат'}</td>
          <td>${esc(i.language)}</td>
          <td>${i.messages}</td>
          <td>${scorePill(i.total)}</td>
          <td>${i.gross_error ? '<span class="badge b-flag">Да</span>' : i.total !== null ? '<span class="muted">нет</span>' : ''}</td>
          <td>${i.status === 'error' ? `<span class="badge b-no" title="${esc(i.error)}">Ошибка</span>` : esc(statusLabel[i.status] || i.status)}${i.needs_review ? ` <span class="badge b-open" title="Вторая модель не согласилась по ${i.needs_review} критериям">проверить: ${i.needs_review}</span>` : ''}</td>
          <td>${i.open_appeals ? `<span class="badge b-open">${i.open_appeals} открыто</span>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="8" class="empty">Ничего не найдено</td></tr>';
      $$('#rows tr.click').forEach((tr) => tr.addEventListener('click', () => (location.hash = `#/dialog/${encodeURIComponent(group)}/${encodeURIComponent(tr.dataset.id)}`)));
    }
    if (list) {
      renderRows();
      const bindF = (id, key, ev = 'change') => $(id).addEventListener(ev, (e) => { filters[key] = e.target.value; LS.set('filters', filters); renderRows(); });
      bindF('#fq', 'q', 'input'); bindF('#flang', 'lang'); bindF('#fch', 'channel'); bindF('#fst', 'status');
      $('#evalAll').onclick = () => startBatch(false);
      $('#evalMissing').onclick = () => startBatch(true);
      const running = LS.get('job', null);
      if (running && running.group === group) pollJob(running.id);
    }

    $('#grp').onchange = (e) => (location.hash = '#/dialogs?group=' + encodeURIComponent(e.target.value));
    $('#fetch').onclick = async () => {
      const g = $('#gid').value.trim() || 'DEV';
      $('#fetch').disabled = true;
      try {
        const r = await api('/datasets/fetch', { method: 'POST', body: { group_id: g } });
        toast(`Загружено ${r.total} диалогов (${r.group_id})`);
        location.hash = '#/dialogs?group=' + encodeURIComponent(r.group_id);
        router();
      } catch (e) { toast(e.message, true); $('#fetch').disabled = false; }
    };
    $('#file').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const payload = JSON.parse(await file.text());
        const g = $('#gid').value.trim() || payload?.data?.dataset_group_id || file.name.replace(/\.json$/i, '');
        const r = await api('/datasets/upload', { method: 'POST', body: { group_id: g, payload } });
        toast(`Загружено ${r.total} диалогов (${r.group_id})`);
        location.hash = '#/dialogs?group=' + encodeURIComponent(r.group_id);
        router();
      } catch (err) { toast('Не удалось загрузить: ' + err.message, true); }
    };

    async function startBatch(onlyMissing) {
      try {
        const job = await api('/evaluate-batch', { method: 'POST', body: { group_id: group, only_missing: onlyMissing } });
        if (job.client_side) return runClientBatch(job);
        if (!job.total) return toast('Нечего оценивать — всё уже оценено');
        LS.set('job', { id: job.id, group });
        pollJob(job.id);
      } catch (e) { toast(e.message, true); }
    }
    // Online (serverless) mode: the browser evaluates the dialogs one by one, two at a time.
    async function runClientBatch(job) {
      const ids = job.conversation_ids;
      if (!ids.length) return toast('Нечего оценивать — всё уже оценено');
      let done = 0;
      const errors = [];
      let cost = 0;
      const show = () => {
        const el = $('#job');
        if (!el) return;
        const pct = Math.round((done / ids.length) * 100);
        el.innerHTML = `<div class="progress"><i style="width:${pct}%"></i></div> ${done}/${ids.length}${errors.length ? ` · <span style="color:var(--bad)">ошибок ${errors.length}</span>` : ''}${cost ? ` · $${cost.toFixed(4)}` : ''} · не закрывайте вкладку`;
      };
      show();
      let next = 0;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const worker = async () => {
        while (next < ids.length) {
          const id = ids[next++];
          // Hosted models have per-minute limits: on 429 (or a function timeout) wait and retry.
          for (let attempt = 0; ; attempt++) {
            try {
              const ev = await api('/evaluate', { method: 'POST', body: { conversation_id: id, group_id: job.group_id, checklist_uid: job.checklist_uid } });
              if (ev.meta && ev.meta.cost_usd) cost += ev.meta.cost_usd;
              break;
            } catch (e) {
              const retryable = e.status === 429 || e.status === 503 || e.status === 504;
              if (!retryable || attempt >= 6) { errors.push({ id, error: e.message }); break; }
              const wait = Math.min(Math.max(e.retryAfter || 20, 5), 60);
              const el = $('#job');
              if (el) el.insertAdjacentHTML('beforeend', ` · <span class="muted">лимит модели, повтор через ${wait} с</span>`);
              await sleep(wait * 1000);
            }
          }
          done++;
          show();
        }
      };
      // one request at a time online (rate-limited hosted model), two locally
      await Promise.all(Array.from({ length: state.config && state.config.serverless ? 1 : 2 }, worker));
      toast(`Оценка завершена: ${done - errors.length} успешно${errors.length ? ', ошибок: ' + errors.length + ' (' + errors[0].error.slice(0, 80) + ')' : ''}`, errors.length > 0);
      router();
    }
    function pollJob(jobId) {
      clearInterval(pollTimer);
      const tick = async () => {
        let j;
        try { j = await api('/jobs/' + jobId); } catch { clearInterval(pollTimer); LS.set('job', null); return; }
        const el = $('#job');
        if (!el) return clearInterval(pollTimer);
        const pct = j.total ? Math.round((j.done / j.total) * 100) : 100;
        el.innerHTML = `<div class="progress"><i style="width:${pct}%"></i></div> ${j.done}/${j.total}${j.errors.length ? ` · <span style="color:var(--bad)">ошибок ${j.errors.length}</span>` : ''}${j.cost_usd ? ` · $${j.cost_usd.toFixed(4)}` : ''}`;
        if (j.status !== 'running') {
          clearInterval(pollTimer);
          LS.set('job', null);
          toast(`Оценка завершена: ${j.done - j.errors.length} успешно${j.errors.length ? ', ошибок: ' + j.errors.length : ''}`, j.errors.length > 0);
          router();
        }
      };
      tick();
      pollTimer = setInterval(tick, 1500);
    }
  }

  // =====================================================================
  // DIALOG CARD
  // =====================================================================
  async function viewDialog(group, convId, q) {
    clearInterval(pollTimer);
    const conv = await api(`/conversations/${encodeURIComponent(convId)}?group_id=${encodeURIComponent(group)}`);
    const rec = conv.record;
    const cls = await api('/checklists');
    const evId = q.get('ev') || (conv.evaluations.filter((e) => e.status !== 'error').slice(-1)[0] || {}).id;
    const ev = evId ? await api('/evaluations/' + evId) : null;
    const res = ev ? ev.final_result || ev.result : null;
    const isCall = rec.channel === 'voice call';
    // the API's audio_url is an HTML player page; the backend resolves it to the mp3 and streams it
    const audioSrc = rec.audio_url ? `${API}/audio?group_id=${encodeURIComponent(group)}&id=${encodeURIComponent(rec.conversation_id)}` : null;

    // seconds offsets for audio seek
    let t0 = null;
    const msgs = (rec.transcript || []).map((m, idx) => {
      let off = null;
      if (/^\d{4}-\d{2}-\d{2}T/.test(m.timestamp || '')) { const ms = Date.parse(m.timestamp); if (t0 === null) t0 = ms; off = (ms - t0) / 1000; }
      else if (m.timestamp) { const p = String(m.timestamp).split(':').map(Number); off = p.reduce((a, x) => a * 60 + x, 0); }
      return { ...m, idx, off };
    });
    const fmtTs = (m) => (isCall && m.off !== null ? `${Math.floor(m.off / 60)}:${String(Math.round(m.off % 60)).padStart(2, '0')} · ${esc(m.timestamp)}` : esc(m.timestamp));

    const critById = {};
    if (ev) for (const c of ev.checklist.criteria) critById[c.id] = { ...c, scale_max: c.type === 'scale' ? Math.max(...c.scale.map((s) => s.value)) : null };

    shell('dialogs', `
      <div class="row" style="margin-bottom:12px">
        <a class="btn" href="#/dialogs?group=${encodeURIComponent(group)}">← Список</a>
        <div><h1 class="mono" style="font-size:18px">${esc(rec.conversation_id)}</h1>
          <div class="muted small">${isCall ? '📞 Звонок' : '💬 Чат'} · ${esc(rec.language)} · ${msgs.length} реплик · набор ${esc(group)}</div></div>
        <div class="spacer"></div>
        ${conv.evaluations.length > 1 ? `<label class="f">История оценок<select id="evsel">${conv.evaluations.map((e) => `<option value="${e.id}" ${ev && e.id === ev.id ? 'selected' : ''}>${new Date(e.created_at).toLocaleString()} · ${esc(e.checklist_uid)} · ${e.total ?? (e.status === 'error' ? 'ошибка' : '—')}</option>`).join('')}</select></label>` : ''}
        <label class="f">Чек-лист<select id="clsel">${cls.items.map((c) => `<option value="${esc(c.uid)}" ${c.uid === cls.active ? 'selected' : ''}>${esc(c.name)} · v${c.version}</option>`).join('')}</select></label>
        <button class="btn primary" id="run">${ev ? '↻ Переоценить' : '▶ Оценить'}</button>
      </div>
      <div class="card-grid">
        <section class="panel transcript" id="tr">
          ${isCall ? `<div class="audio"><div class="small muted" style="margin-bottom:6px">Запись звонка</div>${rec.audio_url ? `<audio id="aud" controls preload="metadata" src="${esc(audioSrc)}"></audio><div class="small"><a href="${esc(rec.audio_url)}" target="_blank" rel="noopener">Открыть запись в новой вкладке ↗</a></div>` : rec.audio_withheld ? '<span class="muted">Запись звонка в публичной версии не публикуется (реальный голос клиента) — она доступна при локальном запуске.</span>' : '<span class="muted">Ссылка на запись отсутствует</span>'}</div>` : ''}
          ${msgs.map((m) => `
            <div class="msg ${esc(m.speaker)}" id="m-${m.idx}">
              <div class="n">${m.idx + 1}</div>
              <div><div class="who">${esc(m.speaker)} <span class="ts">${fmtTs(m)}</span>${isCall && rec.audio_url && m.off !== null ? `<button class="play" data-off="${m.off}">▶ слушать</button>` : ''}</div>
              <div class="txt">${esc(m.text)}</div></div>
            </div>`).join('')}
        </section>
        <section id="res">${res ? renderResult(ev, res, critById) : ev && ev.status === 'error' ? `<div class="panel">Ошибка оценки: ${esc(ev.error)}</div>` : `<div class="panel empty">Диалог ещё не оценён. Выберите чек-лист и нажмите «Оценить».</div>`}</section>
      </div>`);

    // --- interactions ---
    const aud = $('#aud');
    function seek(off) {
      if (!aud || off === null || off === undefined || Number.isNaN(Number(off))) return;
      try { aud.currentTime = Number(off); aud.play().catch(() => {}); } catch {}
    }
    $$('.play').forEach((b) => (b.onclick = () => seek(b.dataset.off)));
    function focusMsg(i, range) {
      $$('.msg.focus, .msg.inrange').forEach((m) => m.classList.remove('focus', 'inrange'));
      if (range) for (let k = range[0]; k <= range[1]; k++) { const el = $('#m-' + k); if (el) el.classList.add('inrange'); }
      const el = $('#m-' + i);
      if (!el) return;
      el.classList.add('focus');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (isCall) seek(msgs[i] && msgs[i].off);
    }
    $$('[data-goto]').forEach((b) => (b.onclick = () => focusMsg(Number(b.dataset.goto), b.dataset.range ? JSON.parse(b.dataset.range) : null)));
    if (q.get('msg')) setTimeout(() => focusMsg(Number(q.get('msg'))), 150);

    $('#run').onclick = async () => {
      const btn = $('#run');
      btn.disabled = true;
      btn.textContent = 'Оценка…';
      try {
        const out = await api('/evaluate', { method: 'POST', body: { conversation_id: rec.conversation_id, group_id: group, checklist_uid: $('#clsel').value } });
        toast(`Готово: ${out.result.total ?? '—'} баллов`);
        location.hash = `#/dialog/${encodeURIComponent(group)}/${encodeURIComponent(rec.conversation_id)}?ev=${out.id}`;
      } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Оценить'; }
    };
    if ($('#evsel')) $('#evsel').onchange = (e) => (location.hash = `#/dialog/${encodeURIComponent(group)}/${encodeURIComponent(rec.conversation_id)}?ev=${e.target.value}`);

    // appeals
    $$('[data-appeal]').forEach((b) => (b.onclick = () => {
      const cid = b.dataset.appeal;
      const box = $('#af-' + cid);
      if (box.innerHTML) { box.innerHTML = ''; return; }
      const c = critById[cid];
      box.innerHTML = `<div class="appeal-form">
          <b>Апелляция по критерию «${esc(c.name)}»</b>
          <label class="f">Какой результат считаете верным (необязательно)${answerSelect(c, '', 'ap-want-' + cid, true)}</label>
          <label class="f">Комментарий *<textarea id="ap-c-${cid}" placeholder="Почему оценка неверна? Укажите реплику."></textarea></label>
          <div class="row"><button class="btn primary" id="ap-s-${cid}">Отправить апелляцию</button><button class="btn" id="ap-x-${cid}">Отмена</button></div>
        </div>`;
      $('#ap-x-' + cid).onclick = () => (box.innerHTML = '');
      $('#ap-s-' + cid).onclick = async () => {
        const comment = $('#ap-c-' + cid).value.trim();
        if (!comment) return toast('Добавьте комментарий', true);
        try {
          const want = $('#ap-want-' + cid).value;
          await api('/appeals', { method: 'POST', body: { evaluation_id: ev.id, criterion_id: cid, comment, requested_answer: want === '' ? null : want } });
          toast('Апелляция сохранена и передана проверяющему');
          router();
        } catch (e) { toast(e.message, true); }
      };
    }));
  }

  function answerSelect(c, current, id, allowEmpty) {
    let opts = [];
    if (c.type === 'scale') opts = [...c.scale].sort((a, b) => b.value - a.value).map((s) => [String(s.value), `${s.value} — ${s.label}`]);
    else if (c.type === 'flag') opts = [['yes', 'Да — нарушение есть'], ['no', 'Нет — нарушений нет']];
    else opts = [['yes', 'Да'], ['no', 'Нет']];
    if (c.na_allowed) opts.push(['na', 'N/A']);
    return `<select id="${id}">${allowEmpty ? '<option value="">—</option>' : ''}${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(current) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  }

  function renderResult(ev, res, critById) {
    const orig = ev.result;
    const appeals = ev.appeals || [];
    const changed = orig && res && orig.total !== res.total;
    const meta = ev.meta || {};
    return `
      <div class="panel">
        <div class="total">
          <div class="big">${res.total ?? '—'}<small> / 100</small></div>
          <div>
            <div><b>Итоговый балл</b> ${ev.status === 'reviewed' ? '<span class="badge b-changed">после пересмотра</span>' : ev.status === 'appealed' ? '<span class="badge b-open">апелляция открыта</span>' : ''}</div>
            ${changed ? `<div class="small">Исходная оценка: <b>${orig.total}</b> → финальная: <b>${res.total}</b></div>` : ''}
            <div class="small muted">Чек-лист <span class="mono">${esc(ev.checklist_uid)}</span> · ${new Date(ev.created_at).toLocaleString()}</div>
            <div class="small muted">${meta.provider === 'rules' ? 'Эвристика без LLM' : esc((meta.provider || '') + ' · ' + (meta.model || ''))}${meta.fallback_from ? ` <span title="Основная модель была на лимите">(резервная вместо ${esc(meta.fallback_from)})</span>` : ''}${meta.usage ? ` · токены ${meta.usage.input}+${meta.usage.output}` : ''}${meta.cost_usd ? ` · $${meta.cost_usd.toFixed(4)}` : ''}${meta.duration_ms ? ` · ${(meta.duration_ms / 1000).toFixed(1)} с` : ''}</div>
          </div>
        </div>
        ${res.total === null ? '<div class="warn">Нет применимых критериев с весом — итог не рассчитывается.</div>' : ''}
        ${res.gross_error ? `<div class="gross">⚠ Выявлена грубая ошибка — см. критерий ${res.gross_error_criteria.map((id) => esc(critById[id]?.code || id)).join(', ')}</div>` : ''}
        <div class="sections">${res.sections.filter((s) => s.has_weight).map((s) => `<div class="sec">${esc(s.name)}<b>${s.percent === null ? 'N/A' : s.percent + '%'}</b><span class="muted">${s.points === null ? '' : `${s.points} из ${s.max_points} балл.`}</span><div class="bar"><i style="width:${s.percent || 0}%"></i></div></div>`).join('')}</div>
      </div>
      ${res.criteria.map((r) => renderCrit(r, critById[r.criterion_id] || r, orig.criteria.find((o) => o.criterion_id === r.criterion_id), appeals.filter((a) => a.criterion_id === r.criterion_id), ev)).join('')}`;
  }

  function renderCrit(r, c, o, appeals, ev) {
    const open = appeals.find((a) => a.status === 'open');
    const ov = (ev.overrides || {})[r.criterion_id];
    const pts = r.type === 'flag' ? '<span class="muted">без баллов</span>' : r.applicable ? `<b>${r.points}</b> / ${r.effective_weight}<br><span class="muted">вес ${r.base_weight}${r.effective_weight !== r.base_weight ? ' → ' + r.effective_weight : ''}</span>` : `<b>—</b><br><span class="muted">вес ${r.base_weight} перераспределён</span>`;
    const range = r.checked_range ? JSON.stringify(r.checked_range) : '';
    return `
      <div class="crit ${r.type === 'flag' && r.answer === 'yes' ? 'flagged' : ''}">
        <div class="head">
          <span class="code">${esc(r.code || r.criterion_id)}</span>
          <span class="name">${esc(r.name)}</span>
          ${answerBadge(c, r.answer)}
          ${r.overridden ? '<span class="badge b-changed">изменено проверяющим</span>' : ''}
          <div class="pts">${pts}</div>
        </div>
        <div class="expl">${r.answer === 'na' ? '<b>N/A: </b>' : ''}${esc(o && r.overridden ? o.explanation : r.explanation)}</div>
        <div>${r.evidence.map((e) => `<button class="ev ${e.verified ? '' : 'unv'}" data-goto="${e.msg}" ${range ? `data-range='${range}'` : ''} title="${e.verified ? 'Перейти к реплике' : 'Цитата не найдена дословно'}"><span class="i">[${e.msg + 1}]</span><span>${esc(e.speaker || '')} · «${esc(e.quote.length > 140 ? e.quote.slice(0, 140) + '…' : e.quote)}»</span></button>`).join('')}
          ${r.checked_range ? `<button class="ev" data-goto="${r.checked_range[0]}" data-range='${range}' title="Проверенный участок"><span class="i">⟷</span><span>проверенный участок [${r.checked_range[0] + 1}–${r.checked_range[1] + 1}]</span></button>` : ''}
        </div>
        ${(r.warnings || []).filter((w) => !/^Эвристика/.test(w)).map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('')}
        ${ov ? `<div class="override">Исходно: <b>${esc(answerText(o.answer))}</b>${o.points !== null && o.points !== undefined ? ` (${o.points} балл.)` : ''} → решение проверяющего: <b>${esc(answerText(r.answer))}</b>. Причина: ${esc(ov.reason)} <span class="muted">— ${esc(ov.reviewer)}</span></div>` : ''}
        ${appeals.filter((a) => a.status !== 'open' && !(ov && ov.appeal_id === a.id)).map((a) => `<div class="override">Апелляция отклонена, оценка подтверждена. Причина: ${esc(a.decision.reason)} <span class="muted">— ${esc(a.decision.reviewer)}</span></div>`).join('')}
        <div class="row" style="margin-top:8px">
          ${open ? `<span class="badge b-open">Апелляция на рассмотрении</span><span class="small muted">«${esc(open.comment)}»</span><a class="btn small" href="#/appeals">Рассмотреть →</a>` : `<button class="btn small" data-appeal="${esc(r.criterion_id)}">Оспорить</button>`}
        </div>
        <div id="af-${esc(r.criterion_id)}"></div>
      </div>`;
  }

  // =====================================================================
  // CHECKLISTS
  // =====================================================================
  async function viewChecklists(uid) {
    clearInterval(pollTimer);
    const cls = await api('/checklists');
    const sel = uid || cls.active;
    const cl = JSON.parse(JSON.stringify(await api('/checklists/' + encodeURIComponent(sel))));
    shell('checklists', `
      <div class="row" style="margin-bottom:14px">
        <div><h1>Чек-листы</h1><p class="sub" style="margin:0">Каждое сохранение создаёт новую версию. Старые оценки остаются привязаны к своей версии.</p></div>
      </div>
      <div class="cl-grid">
        <aside class="panel vlist">
          <h2>Версии</h2>
          ${cls.items.slice().reverse().map((c) => `<a href="#/checklists/${encodeURIComponent(c.uid)}" class="${c.uid === sel ? 'on' : ''}"><div><b>${esc(c.name)}</b></div><div class="small muted">v${c.version} · ${c.criteria} крит. · ${new Date(c.saved_at).toLocaleString()} ${c.uid === cls.active ? '· <span style="color:var(--brand);font-weight:600">активный</span>' : ''}</div></a>`).join('')}
          <hr style="border:0;border-top:1px solid var(--line);margin:12px 0">
          <label class="btn" style="display:block;text-align:center;cursor:pointer">Импорт JSON<input id="imp" type="file" accept=".json" hidden></label>
        </aside>
        <section>
          <div class="panel">
            <div class="row">
              <label class="f" style="flex:1">Название<input id="cl-name" type="text" value="${esc(cl.name)}"></label>
              <label class="f">ID семейства<input id="cl-id" type="text" value="${esc(cl.id)}" style="width:170px"></label>
              <label class="f">Порог первой реакции, сек<input id="cl-thr" type="number" value="${cl.settings?.first_response_threshold_sec ?? 180}" style="width:120px"></label>
              <label class="f">Округление<input id="cl-rnd" type="number" min="0" max="4" value="${cl.settings?.rounding ?? 2}" style="width:90px"></label>
            </div>
            <div class="row" style="margin-top:10px">
              <div>Сумма весов: <span class="wsum" id="wsum"></span> <span class="muted small">(при N/A веса перераспределяются автоматически, максимум всегда 100)</span></div>
              <div class="spacer"></div>
              ${cl.uid !== cls.active ? '<button class="btn" id="activate">Сделать активным</button>' : ''}
              <button class="btn" id="exp">Экспорт JSON</button>
              <button class="btn primary" id="save">Сохранить новую версию</button>
            </div>
          </div>
          <div class="panel" style="margin-top:10px">
            <h2>Секции</h2>
            <div id="secs"></div>
            <button class="btn small" id="addsec" style="margin-top:6px">+ секция</button>
          </div>
          <div id="crits"></div>
          <button class="btn" id="addcrit" style="margin-top:10px">+ Добавить критерий</button>
        </section>
      </div>`);

    const ensureSections = () => (cl.sections = cl.sections || []);
    ensureSections();

    function renderSecs() {
      $('#secs').innerHTML = cl.sections.map((s, i) => `<div class="row" style="margin-top:4px"><input type="text" class="mono" data-sid="${i}" value="${esc(s.id)}" style="width:120px"><input type="text" data-sname="${i}" value="${esc(s.name)}" style="flex:1"><button class="btn small danger" data-sdel="${i}">✕</button></div>`).join('');
      $$('[data-sid]').forEach((el) => (el.oninput = () => { cl.sections[el.dataset.sid].id = el.value.trim(); }));
      $$('[data-sid]').forEach((el) => (el.onchange = renderCrits));
      $$('[data-sname]').forEach((el) => (el.oninput = () => { cl.sections[el.dataset.sname].name = el.value; }));
      $$('[data-sdel]').forEach((el) => (el.onclick = () => { cl.sections.splice(Number(el.dataset.sdel), 1); renderSecs(); renderCrits(); }));
    }

    function wsum() {
      const s = cl.criteria.filter((c) => c.type !== 'flag').reduce((a, c) => a + (Number(c.weight) || 0), 0);
      const el = $('#wsum');
      el.textContent = s;
      el.className = 'wsum' + (s === 100 ? '' : ' off');
    }

    function renderCrits() {
      $('#crits').innerHTML = cl.criteria.map((c, i) => `
        <div class="ced" data-i="${i}">
          <div class="g">
            <label class="f">Код<input type="text" data-k="code" value="${esc(c.code || '')}"></label>
            <label class="f">Название критерия<input type="text" data-k="name" value="${esc(c.name)}"></label>
            <label class="f">Секция<select data-k="section"><option value="">—</option>${cl.sections.map((s) => `<option value="${esc(s.id)}" ${s.id === c.section ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
            <label class="f">Тип ответа<select data-k="type"><option value="binary" ${c.type === 'binary' ? 'selected' : ''}>Да / Нет</option><option value="scale" ${c.type === 'scale' ? 'selected' : ''}>Шкала</option><option value="flag" ${c.type === 'flag' ? 'selected' : ''}>Флаг (без баллов)</option></select></label>
            <label class="f">Вес<input type="number" min="0" data-k="weight" value="${c.type === 'flag' ? 0 : c.weight}" ${c.type === 'flag' ? 'disabled' : ''}></label>
            <div class="row" style="gap:4px">
              <button class="btn small" data-mv="-1" title="Вверх">↑</button><button class="btn small" data-mv="1" title="Вниз">↓</button>
              <button class="btn small danger" data-del title="Удалить">✕</button>
            </div>
          </div>
          <label class="f">Правило оценки (что считать «Да» / как ставить баллы)<textarea data-k="description">${esc(c.description || '')}</textarea></label>
          ${Array.isArray(c.checks) && c.checks.length ? (c.checks_signature === [c.name, c.type, String(c.description || '').trim()].join('|')
            ? `<div class="small muted">Подвопросы: ${c.checks.length} (${c.checks.map((q) => esc(q.label || q.id)).join(' · ')}). Модель отвечает на них, итог считается по правилу.</div>`
            : '<div class="small muted">Формулировка изменена — подвопросы отключены, критерий оценивается напрямую по новому правилу.</div>') : ''}
          <div class="g2">
            <label class="row small" style="gap:6px"><input type="checkbox" data-k="na_allowed" ${c.na_allowed ? 'checked' : ''} ${c.type === 'flag' ? 'disabled' : ''}> N/A допустим</label>
            ${c.na_allowed ? `<label class="f">Условие N/A<input type="text" data-k="na_condition" value="${esc(c.na_condition || '')}"></label>` : '<div></div>'}
          </div>
          ${c.type === 'scale' ? `<div><div class="small muted">Шкала (верхняя ступень = полный вес)</div>
            ${(c.scale || []).map((s, j) => `<div class="scale-row"><input type="number" data-sv="${j}" value="${s.value}"><input type="text" data-sl="${j}" value="${esc(s.label)}"><button class="btn small danger" data-sd="${j}">✕</button></div>`).join('')}
            <button class="btn small" data-sa style="margin-top:4px">+ ступень</button></div>` : ''}
          <div class="small muted mono">id: ${esc(c.id)}</div>
        </div>`).join('');
      wsum();
      $$('.ced').forEach((box) => {
        const i = Number(box.dataset.i);
        const c = cl.criteria[i];
        $$('[data-k]', box).forEach((el) => {
          const k = el.dataset.k;
          const handler = () => {
            if (k === 'na_allowed') { c.na_allowed = el.checked; renderCrits(); return; }
            if (k === 'weight') { c.weight = Number(el.value); wsum(); return; }
            c[k] = el.value;
            if (k === 'type') {
              if (c.type === 'scale' && !(c.scale && c.scale.length)) c.scale = [{ value: 10, label: 'Отлично' }, { value: 5, label: 'Частично' }, { value: 0, label: 'Нет' }];
              if (c.type === 'flag') { c.weight = 0; c.na_allowed = false; }
              renderCrits();
            }
          };
          el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', handler);
        });
        $$('[data-sv]', box).forEach((el) => (el.oninput = () => (c.scale[el.dataset.sv].value = Number(el.value))));
        $$('[data-sl]', box).forEach((el) => (el.oninput = () => (c.scale[el.dataset.sl].label = el.value)));
        $$('[data-sd]', box).forEach((el) => (el.onclick = () => { c.scale.splice(Number(el.dataset.sd), 1); renderCrits(); }));
        const sa = $('[data-sa]', box);
        if (sa) sa.onclick = () => { c.scale.push({ value: 0, label: '' }); renderCrits(); };
        $$('[data-mv]', box).forEach((el) => (el.onclick = () => { const j = i + Number(el.dataset.mv); if (j < 0 || j >= cl.criteria.length) return; [cl.criteria[i], cl.criteria[j]] = [cl.criteria[j], cl.criteria[i]]; renderCrits(); }));
        $('[data-del]', box).onclick = () => { if (confirmDel(c)) { cl.criteria.splice(i, 1); renderCrits(); } };
      });
    }
    function confirmDel(c) { return window.confirm(`Удалить критерий «${c.name}»?`); }

    renderSecs();
    renderCrits();

    $('#addsec').onclick = () => { cl.sections.push({ id: 'sec' + (cl.sections.length + 1), name: 'Новая секция' }); renderSecs(); renderCrits(); };
    $('#addcrit').onclick = () => {
      let n = cl.criteria.length + 1;
      while (cl.criteria.some((c) => c.id === 'c' + String(n).padStart(2, '0'))) n++;
      cl.criteria.push({ id: 'c' + String(n).padStart(2, '0'), code: String(n).padStart(2, '0'), name: 'Новый критерий', section: cl.sections[0]?.id || '', type: 'binary', weight: 10, na_allowed: false, description: '', na_condition: '' });
      renderCrits();
      $$('.ced').slice(-1)[0].scrollIntoView({ behavior: 'smooth' });
    };
    $('#save').onclick = async () => {
      cl.name = $('#cl-name').value.trim();
      cl.id = $('#cl-id').value.trim();
      cl.settings = { ...(cl.settings || {}), first_response_threshold_sec: Number($('#cl-thr').value) || 180, rounding: Number($('#cl-rnd').value) };
      try {
        const saved = await api('/checklists', { method: 'POST', body: { checklist: cl, activate: true } });
        toast(`Сохранено: ${saved.uid} (активный). Переоцените диалоги, чтобы применить.`);
        location.hash = '#/checklists/' + encodeURIComponent(saved.uid);
      } catch (e) { toast(e.message, true); }
    };
    if ($('#activate')) $('#activate').onclick = async () => { await api('/checklists/' + encodeURIComponent(cl.uid) + '/activate', { method: 'POST', body: {} }); toast('Чек-лист активирован'); router(); };
    $('#exp').onclick = () => {
      const { uid, saved_at, ...clean } = cl;
      const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${cl.id}-v${cl.version}.json`;
      a.click();
    };
    $('#imp').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const saved = await api('/checklists', { method: 'POST', body: { checklist: data, activate: true } });
        toast('Импортировано: ' + saved.uid);
        location.hash = '#/checklists/' + encodeURIComponent(saved.uid);
      } catch (err) { toast(err.message, true); }
    };
  }

  // =====================================================================
  // APPEALS (reviewer)
  // =====================================================================
  async function viewAppeals(tab) {
    clearInterval(pollTimer);
    const all = await api('/appeals');
    const list = all.filter((a) => (tab === 'open' ? a.status === 'open' : a.status !== 'open')).reverse();
    shell('appeals', `
      <h1>Апелляции</h1><p class="sub">Проверяющий изучает доказательства, подтверждает или меняет оценку. Итог пересчитывается автоматически.</p>
      <div class="tabs"><a href="#/appeals?tab=open" class="${tab === 'open' ? 'on' : ''}">На рассмотрении (${all.filter((a) => a.status === 'open').length})</a><a href="#/appeals?tab=closed" class="${tab !== 'open' ? 'on' : ''}">Рассмотренные (${all.filter((a) => a.status !== 'open').length})</a></div>
      <div id="aps">${list.length ? '' : '<div class="panel empty">Апелляций нет</div>'}</div>`);
    const box = $('#aps');
    for (const a of list) {
      const [ev, conv] = await Promise.all([api('/evaluations/' + a.evaluation_id), api(`/conversations/${encodeURIComponent(a.conversation_id)}?group_id=${encodeURIComponent(a.group_id)}`)]);
      const c = ev.checklist.criteria.find((x) => x.id === a.criterion_id);
      const row = ev.result.criteria.find((x) => x.criterion_id === a.criterion_id);
      const msgs = conv.record.transcript;
      const idxs = row.evidence.map((e) => e.msg);
      if (row.checked_range) idxs.push(...row.checked_range);
      const lo = Math.max(0, Math.min(...(idxs.length ? idxs : [0])) - 2);
      const hi = Math.min(msgs.length - 1, Math.max(...(idxs.length ? idxs : [msgs.length - 1])) + 2);
      const hl = new Set(row.evidence.map((e) => e.msg));
      const el = document.createElement('div');
      el.className = 'panel ap';
      const link = `#/dialog/${encodeURIComponent(a.group_id)}/${encodeURIComponent(a.conversation_id)}?ev=${a.evaluation_id}`;
      el.innerHTML = `
        <div>
          <div class="row"><span class="mono">${esc(a.conversation_id)}</span><span class="badge ${a.status === 'open' ? 'b-open' : a.status === 'changed' ? 'b-changed' : 'b-done'}">${a.status === 'open' ? 'На рассмотрении' : a.status === 'changed' ? 'Оценка изменена' : 'Оценка подтверждена'}</span><div class="spacer"></div><a class="btn small" href="${link}">Открыть карточку →</a></div>
          <h2 style="margin-top:10px">${esc(c.code || '')} · ${esc(c.name)}</h2>
          <div class="row small"><span>Спорная оценка:</span> ${answerBadge({ ...c, scale_max: c.type === 'scale' ? Math.max(...c.scale.map((s) => s.value)) : null }, a.disputed_answer)} ${a.disputed_points !== null && a.disputed_points !== undefined ? `<span class="muted">${a.disputed_points} балл.</span>` : ''} ${a.requested_answer !== null && a.requested_answer !== undefined ? `<span class="muted">· запрошено: <b>${esc(answerText(a.requested_answer))}</b></span>` : ''}</div>
          <div style="margin-top:8px"><b>Обоснование системы:</b> ${esc(row.explanation)}</div>
          <div style="margin-top:8px;background:#fff7e6;padding:8px;border-radius:8px"><b>Комментарий (${esc(a.author)}):</b> ${esc(a.comment)}</div>
          ${a.status === 'open' ? `
            <div class="appeal-form" style="margin-top:12px">
              <b>Решение проверяющего</b>
              <div class="row"><label class="row small"><input type="radio" name="act-${a.id}" value="confirm"> Подтвердить оценку</label><label class="row small"><input type="radio" name="act-${a.id}" value="change"> Изменить на</label>${answerSelect(c, a.requested_answer ?? '', 'ans-' + a.id, false)}</div>
              <label class="f">Причина *<textarea id="rsn-${a.id}" placeholder="Например: системное сообщение [4] подтверждает идентификацию"></textarea></label>
              <div class="row"><button class="btn primary" id="dec-${a.id}">Сохранить решение</button><span class="small muted">Текущий итог диалога: <b>${a.total ?? '—'}</b></span></div>
            </div>` : `
            <div class="cmp"><div>Исходная оценка<b>${esc(answerText(a.disputed_answer))}</b></div><div>Решение<b>${esc(answerText(a.decision.answer))}</b>${esc(a.decision.reason)}</div><div>Итог<b>${a.decision.total_before} → ${a.decision.total_after}</b>${esc(a.decision.reviewer)} · ${new Date(a.decision.decided_at).toLocaleString()}</div></div>`}
        </div>
        <div>
          <div class="small muted" style="margin-bottom:6px">Фрагмент диалога [${lo + 1}–${hi + 1}] · выделены реплики-доказательства</div>
          <div class="frag">${msgs.slice(lo, hi + 1).map((m, k) => { const i = lo + k; return `<div class="msg ${esc(m.speaker)} ${hl.has(i) ? 'focus' : ''}"><div class="n">${i + 1}</div><div><div class="who">${esc(m.speaker)} <span class="ts">${esc(m.timestamp)}</span></div><div class="txt">${esc(m.text)}</div></div></div>`; }).join('')}</div>
        </div>`;
      box.appendChild(el);
      const dec = $('#dec-' + a.id, el);
      // Choosing a new answer means "change": select it automatically, so the decision cannot be
      // saved as "confirm" by accident (the cause of appeals that did not change the score).
      const sel = $('#ans-' + a.id, el);
      if (sel) sel.addEventListener('change', () => { const r = $(`input[name="act-${a.id}"][value="change"]`, el); if (r) r.checked = true; });
      if (dec) dec.onclick = async () => {
        const picked = $(`input[name="act-${a.id}"]:checked`, el);
        if (!picked) return toast('Выберите решение: «Подтвердить оценку» или «Изменить на»', true);
        const action = picked.value;
        const reason = $('#rsn-' + a.id, el).value.trim();
        if (!reason) return toast('Укажите причину решения', true);
        if (action === 'change' && String(sel.value) === String(a.disputed_answer)) return toast('Новая оценка совпадает со спорной — выберите другое значение или «Подтвердить оценку»', true);
        try {
          const out = await api(`/appeals/${a.id}/decision`, { method: 'POST', body: { action, answer: $('#ans-' + a.id, el).value, reason } });
          toast(`Решение сохранено. Итог: ${out.decision.total_before} → ${out.decision.total_after}`);
          router();
        } catch (e) { toast(e.message, true); }
      };
    }
  }

  router();
})();
