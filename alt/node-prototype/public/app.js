/* Clarity — Conversation Quality Analytics. Vanilla JS, no build step.
   Mounts into #cqa-root (embeddable as a Dynamics 365 HTML web resource; data-api-base points to the service). */
(function () {
  'use strict';
  const root = document.getElementById('cqa-root');
  const API = (root.dataset.apiBase || '').replace(/\/$/, '') + '/api';

  // =====================================================================
  // utils
  // =====================================================================
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, el = root) => el.querySelector(sel);
  const $$ = (sel, el = root) => Array.from(el.querySelectorAll(sel));
  const LS = { get: (k, d) => { try { return JSON.parse(localStorage.getItem('cqa.' + k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem('cqa.' + k, JSON.stringify(v)); } catch {} } };
  const enc = encodeURIComponent;

  // Read-only demo mode: when there is no backend (static hosting), the UI shows a saved snapshot of
  // evaluated results (public/snapshot.json, made by scripts/export_snapshot.js).
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
      if (opts.method && opts.method !== 'GET') throw new Error(t('demo.readonly'));
      const v = SNAPSHOT.responses[path];
      if (v === undefined) throw new Error(t('demo.missing'));
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
    let el = $('.toast');
    if (!el) { el = document.createElement('div'); root.appendChild(el); }
    el.className = 'toast' + (err ? ' err' : '');
    el.setAttribute('role', 'status');
    el.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), err ? 7000 : 3500);
  }

  // =====================================================================
  // i18n — interface text in RU / KZ / EN. Dialog content and model explanations stay as written.
  // =====================================================================
  const I18N = {
    ru: {
      'brand.sub': 'Conversation Quality Analytics', 'nav.workspace': 'Рабочая область', 'nav.overview': 'Обзор', 'nav.conversations': 'Диалоги', 'nav.appeals': 'Апелляции', 'nav.checklist': 'Чек-лист', 'nav.collapse': 'Свернуть меню', 'nav.menu': 'Меню',
      'ds.active': 'Активный набор', 'ds.dialogs': 'диалогов', 'ds.online': 'онлайн · MongoDB', 'ds.local': 'локально', 'ds.demo': 'демо · только просмотр', 'ds.none': 'Набор не загружен',
      'profile.name': 'Команда качества', 'profile.role': 'Проверяющий · без входа',
      'top.model': 'Модель оценки', 'top.settings': 'Настройки чек-листа', 'top.help': 'Документация', 'top.lang': 'Язык интерфейса', 'top.heuristic': 'Эвристика без LLM',
      'demo.title': 'Режим просмотра', 'demo.text': 'Показаны сохранённые результаты оценки; записи звонков не публикуются. Оценка, апелляции и изменение чек-листа работают при подключённом сервере.', 'demo.readonly': 'Демо-версия только для просмотра: оценка, апелляции и изменение чек-листа работают при подключённом сервере.', 'demo.missing': 'Этих данных нет в демо-версии',
      'ov.eyebrow': 'Аналитика качества', 'ov.title': 'Обзор качества', 'ov.sub': 'Качество диалогов и работы операторов по активному чек-листу.', 'ov.run': 'Оценить неоценённые', 'ov.import': 'Загрузить данные',
      'ov.score': 'Средний итоговый балл', 'ov.score_d': 'Взвешенный результат по применимым критериям; N/A исключаются из знаменателя, вес перераспределяется.', 'ov.score_lbl': 'балл', 'ov.cov': 'Покрытие оценкой', 'ov.cov_d': 'Доля диалогов набора, оценённых активным чек-листом.', 'ov.cov_lbl': 'оценено',
      'ov.evaluated': 'оценено', 'ov.gross': 'с грубыми ошибками', 'ov.review': 'критериев на проверку', 'ov.errors': 'ошибок оценки', 'ov.pending': 'ждут оценки',
      'ov.breakdown': 'Результаты по критериям', 'ov.breakdown_d': 'Средний результат, вес и статус каждого критерия по набору. Нажмите строку, чтобы увидеть доказательства.',
      'ov.attention': 'Требуют внимания', 'ov.attention_d': 'Самые низкие итоги и грубые ошибки', 'ov.appeals': 'Открытые апелляции', 'ov.appeals_d': 'Ждут решения проверяющего', 'ov.no_appeals': 'Открытых апелляций нет', 'ov.no_data': 'В наборе пока нет оценённых диалогов', 'ov.go_conv': 'Перейти к диалогам',
      'col.criterion': 'Критерий', 'col.result': 'Средний результат', 'col.weight': 'Вес', 'col.dist': 'Распределение', 'col.status': 'Статус', 'col.evidence': 'Доказательства', 'col.id': 'ID диалога', 'col.channel': 'Канал', 'col.lang': 'Язык', 'col.msgs': 'Реплик', 'col.score': 'Итог', 'col.gross': 'Грубые', 'col.state': 'Статус', 'col.date': 'Оценено', 'col.appeals': 'Апелляции',
      'st.pass': 'Выполняется', 'st.partial': 'Частично', 'st.fail': 'Не выполняется', 'st.na': 'N/A', 'st.critical': 'Грубые ошибки', 'st.clean': 'Нарушений нет',
      'act.evidence': 'Доказательства', 'act.details': 'Подробно', 'act.open': 'Открыть',
      'conv.eyebrow': 'Набор данных', 'conv.title': 'Диалоги', 'conv.sub': 'Загрузите набор, запустите оценку и откройте карточку диалога.', 'conv.source': 'Источник данных', 'conv.dataset': 'Набор', 'conv.gid': 'group_id из API', 'conv.fetch': 'Загрузить из API', 'conv.file': 'JSON-файл', 'conv.evalMissing': 'Оценить неоценённые', 'conv.evalAll': 'Переоценить все', 'conv.export': 'Экспорт JSON',
      'conv.search': 'Поиск по ID', 'conv.allLang': 'Все языки', 'conv.allCh': 'Все каналы', 'conv.allSt': 'Все статусы', 'conv.allScore': 'Любой балл', 'conv.allAppeal': 'Любые апелляции', 'conv.withAppeal': 'С открытой апелляцией', 'conv.noAppeal': 'Без апелляций', 'conv.nothing': 'Ничего не найдено', 'conv.noDs': 'Нет загруженных наборов. Загрузите DEV через API или JSON-файлом.', 'conv.shown': 'Показано', 'conv.of': 'из', 'conv.prev': 'Назад', 'conv.next': 'Вперёд', 'conv.reset': 'Сбросить фильтры',
      'ch.chat': 'чат', 'ch.call': 'звонок',
      'stat.not_evaluated': 'Не оценён', 'stat.evaluated': 'Оценён', 'stat.appealed': 'Апелляция', 'stat.reviewed': 'Пересмотрен', 'stat.error': 'Ошибка',
      'dlg.back': 'Диалоги', 'dlg.history': 'История оценок', 'dlg.checklist': 'Чек-лист', 'dlg.eval': 'Оценить', 'dlg.reeval': 'Переоценить', 'dlg.challenge': 'Оспорить оценку', 'dlg.transcript': 'Транскрипт', 'dlg.total': 'Итоговый балл', 'dlg.notEvaluated': 'Диалог ещё не оценён. Выберите чек-лист и нажмите «Оценить».',
      'sp.client': 'Клиент', 'sp.operator': 'Оператор', 'sp.bot': 'Бот', 'sp.system': 'Система',
      'ap.eyebrow': 'Проверка', 'ap.title': 'Апелляции', 'ap.sub': 'Проверяющий изучает доказательства, подтверждает или меняет оценку. Итог пересчитывается автоматически.', 'ap.pending': 'На рассмотрении', 'ap.accepted': 'Приняты', 'ap.rejected': 'Отклонены', 'ap.resolved': 'Все решённые', 'ap.none': 'Апелляций нет',
      'cl.eyebrow': 'Настройки', 'cl.title': 'Чек-лист', 'cl.sub': 'Каждое сохранение создаёт новую версию. Старые оценки остаются привязаны к своей версии.', 'cl.versions': 'Версии', 'cl.apply': 'Применить к набору', 'cl.save': 'Сохранить новую версию', 'cl.active': 'активный',
    },
    en: {
      'brand.sub': 'Conversation Quality Analytics', 'nav.workspace': 'Workspace', 'nav.overview': 'Overview', 'nav.conversations': 'Conversations', 'nav.appeals': 'Appeals', 'nav.checklist': 'Checklist settings', 'nav.collapse': 'Collapse menu', 'nav.menu': 'Menu',
      'ds.active': 'Active dataset', 'ds.dialogs': 'conversations', 'ds.online': 'online · MongoDB', 'ds.local': 'local', 'ds.demo': 'demo · read-only', 'ds.none': 'No dataset loaded',
      'profile.name': 'Quality team', 'profile.role': 'Reviewer · no sign-in',
      'top.model': 'Evaluation model', 'top.settings': 'Checklist settings', 'top.help': 'Documentation', 'top.lang': 'Interface language', 'top.heuristic': 'Heuristic, no LLM',
      'demo.title': 'Read-only mode', 'demo.text': 'Saved evaluation results are shown; call recordings are not published. Evaluation, appeals and checklist edits work when the server is connected.', 'demo.readonly': 'Read-only demo: evaluation, appeals and checklist edits work when the server is connected.', 'demo.missing': 'This data is not in the demo',
      'ov.eyebrow': 'Quality analytics', 'ov.title': 'Quality overview', 'ov.sub': 'Monitor conversation quality and operator performance with the active checklist.', 'ov.run': 'Evaluate pending', 'ov.import': 'Import data',
      'ov.score': 'Average quality score', 'ov.score_d': 'Weighted result across applicable criteria; N/A items are excluded and their weight redistributed.', 'ov.score_lbl': 'score', 'ov.cov': 'Evaluation coverage', 'ov.cov_d': 'Share of the dataset evaluated with the active checklist.', 'ov.cov_lbl': 'evaluated',
      'ov.evaluated': 'evaluated', 'ov.gross': 'with critical errors', 'ov.review': 'criteria to review', 'ov.errors': 'evaluation errors', 'ov.pending': 'pending',
      'ov.breakdown': 'Criteria performance', 'ov.breakdown_d': 'Average result, weight and status of each criterion across the dataset. Click a row to inspect the evidence.',
      'ov.attention': 'Needs attention', 'ov.attention_d': 'Lowest scores and critical errors', 'ov.appeals': 'Open appeals', 'ov.appeals_d': 'Waiting for a reviewer decision', 'ov.no_appeals': 'No open appeals', 'ov.no_data': 'No evaluated conversations in this dataset yet', 'ov.go_conv': 'Go to conversations',
      'col.criterion': 'Criterion', 'col.result': 'Average result', 'col.weight': 'Weight', 'col.dist': 'Distribution', 'col.status': 'Status', 'col.evidence': 'Evidence', 'col.id': 'Conversation ID', 'col.channel': 'Channel', 'col.lang': 'Language', 'col.msgs': 'Messages', 'col.score': 'Score', 'col.gross': 'Critical', 'col.state': 'Status', 'col.date': 'Evaluated', 'col.appeals': 'Appeals',
      'st.pass': 'Passed', 'st.partial': 'Partially passed', 'st.fail': 'Failed', 'st.na': 'N/A', 'st.critical': 'Critical errors', 'st.clean': 'No violations',
      'act.evidence': 'Evidence', 'act.details': 'Details', 'act.open': 'Open',
      'conv.eyebrow': 'Dataset', 'conv.title': 'Conversations', 'conv.sub': 'Load a dataset, run the evaluation and open a conversation.', 'conv.source': 'Data source', 'conv.dataset': 'Dataset', 'conv.gid': 'group_id from API', 'conv.fetch': 'Load from API', 'conv.file': 'JSON file', 'conv.evalMissing': 'Evaluate pending', 'conv.evalAll': 'Re-evaluate all', 'conv.export': 'Export JSON',
      'conv.search': 'Search by ID', 'conv.allLang': 'All languages', 'conv.allCh': 'All channels', 'conv.allSt': 'All statuses', 'conv.allScore': 'Any score', 'conv.allAppeal': 'Any appeals', 'conv.withAppeal': 'With open appeal', 'conv.noAppeal': 'No appeals', 'conv.nothing': 'Nothing found', 'conv.noDs': 'No datasets loaded. Load DEV from the API or a JSON file.', 'conv.shown': 'Showing', 'conv.of': 'of', 'conv.prev': 'Previous', 'conv.next': 'Next', 'conv.reset': 'Reset filters',
      'ch.chat': 'chat', 'ch.call': 'call',
      'stat.not_evaluated': 'Not evaluated', 'stat.evaluated': 'Evaluated', 'stat.appealed': 'Appealed', 'stat.reviewed': 'Reviewed', 'stat.error': 'Error',
      'dlg.back': 'Conversations', 'dlg.history': 'Evaluation history', 'dlg.checklist': 'Checklist', 'dlg.eval': 'Evaluate', 'dlg.reeval': 'Re-evaluate', 'dlg.challenge': 'Challenge evaluation', 'dlg.transcript': 'Transcript', 'dlg.total': 'Final score', 'dlg.notEvaluated': 'Not evaluated yet. Choose a checklist and press Evaluate.',
      'sp.client': 'Client', 'sp.operator': 'Operator', 'sp.bot': 'Bot', 'sp.system': 'System',
      'ap.eyebrow': 'Review', 'ap.title': 'Appeals', 'ap.sub': 'The reviewer inspects the evidence and confirms or changes the score. The total is recalculated automatically.', 'ap.pending': 'Pending', 'ap.accepted': 'Accepted', 'ap.rejected': 'Rejected', 'ap.resolved': 'All resolved', 'ap.none': 'No appeals',
      'cl.eyebrow': 'Settings', 'cl.title': 'Checklist settings', 'cl.sub': 'Every save creates a new version. Past evaluations stay linked to their version.', 'cl.versions': 'Versions', 'cl.apply': 'Apply to dataset', 'cl.save': 'Save new version', 'cl.active': 'active',
    },
    kk: {
      'brand.sub': 'Conversation Quality Analytics', 'nav.workspace': 'Жұмыс аймағы', 'nav.overview': 'Шолу', 'nav.conversations': 'Диалогтар', 'nav.appeals': 'Апелляциялар', 'nav.checklist': 'Чек-парақ', 'nav.collapse': 'Мәзірді жию', 'nav.menu': 'Мәзір',
      'ds.active': 'Белсенді жиын', 'ds.dialogs': 'диалог', 'ds.online': 'онлайн · MongoDB', 'ds.local': 'жергілікті', 'ds.demo': 'демо · тек қарау', 'ds.none': 'Жиын жүктелмеген',
      'profile.name': 'Сапа тобы', 'profile.role': 'Тексеруші · кірусіз',
      'top.model': 'Бағалау моделі', 'top.settings': 'Чек-парақ баптаулары', 'top.help': 'Құжаттама', 'top.lang': 'Интерфейс тілі', 'top.heuristic': 'LLM-сіз эвристика',
      'demo.title': 'Қарау режимі', 'demo.text': 'Сақталған бағалау нәтижелері көрсетілген; қоңырау жазбалары жарияланбайды. Бағалау, апелляция және чек-парақты өзгерту сервер қосулы болғанда жұмыс істейді.', 'demo.readonly': 'Демо тек қарауға арналған: бағалау, апелляция және чек-парақты өзгерту сервер қосулы болғанда жұмыс істейді.', 'demo.missing': 'Бұл деректер демода жоқ',
      'ov.eyebrow': 'Сапа аналитикасы', 'ov.title': 'Сапаға шолу', 'ov.sub': 'Белсенді чек-парақ бойынша диалогтар мен операторлар жұмысының сапасы.', 'ov.run': 'Бағаланбағандарды бағалау', 'ov.import': 'Деректерді жүктеу',
      'ov.score': 'Орташа қорытынды балл', 'ov.score_d': 'Қолданылатын критерийлер бойынша салмақталған нәтиже; N/A алынып тасталады, салмақ қайта бөлінеді.', 'ov.score_lbl': 'балл', 'ov.cov': 'Бағалау қамтуы', 'ov.cov_d': 'Белсенді чек-парақпен бағаланған диалогтардың үлесі.', 'ov.cov_lbl': 'бағаланды',
      'ov.evaluated': 'бағаланды', 'ov.gross': 'өрескел қателері бар', 'ov.review': 'тексерілетін критерий', 'ov.errors': 'бағалау қатесі', 'ov.pending': 'бағалауды күтуде',
      'ov.breakdown': 'Критерийлер бойынша нәтижелер', 'ov.breakdown_d': 'Әр критерийдің жиын бойынша орташа нәтижесі, салмағы мен мәртебесі. Дәлелдерді көру үшін жолды басыңыз.',
      'ov.attention': 'Назар аударыңыз', 'ov.attention_d': 'Ең төмен нәтижелер мен өрескел қателер', 'ov.appeals': 'Ашық апелляциялар', 'ov.appeals_d': 'Тексерушінің шешімін күтуде', 'ov.no_appeals': 'Ашық апелляция жоқ', 'ov.no_data': 'Бұл жиында әлі бағаланған диалог жоқ', 'ov.go_conv': 'Диалогтарға өту',
      'col.criterion': 'Критерий', 'col.result': 'Орташа нәтиже', 'col.weight': 'Салмақ', 'col.dist': 'Бөлінуі', 'col.status': 'Мәртебе', 'col.evidence': 'Дәлелдер', 'col.id': 'Диалог ID', 'col.channel': 'Арна', 'col.lang': 'Тіл', 'col.msgs': 'Реплика', 'col.score': 'Қорытынды', 'col.gross': 'Өрескел', 'col.state': 'Мәртебе', 'col.date': 'Бағаланды', 'col.appeals': 'Апелляциялар',
      'st.pass': 'Орындалады', 'st.partial': 'Ішінара', 'st.fail': 'Орындалмайды', 'st.na': 'N/A', 'st.critical': 'Өрескел қателер', 'st.clean': 'Бұзушылық жоқ',
      'act.evidence': 'Дәлелдер', 'act.details': 'Толығырақ', 'act.open': 'Ашу',
      'conv.eyebrow': 'Деректер жиыны', 'conv.title': 'Диалогтар', 'conv.sub': 'Жиынды жүктеп, бағалауды іске қосып, диалог карточкасын ашыңыз.', 'conv.source': 'Деректер көзі', 'conv.dataset': 'Жиын', 'conv.gid': 'API-дегі group_id', 'conv.fetch': 'API-ден жүктеу', 'conv.file': 'JSON файл', 'conv.evalMissing': 'Бағаланбағандарды бағалау', 'conv.evalAll': 'Барлығын қайта бағалау', 'conv.export': 'JSON экспорт',
      'conv.search': 'ID бойынша іздеу', 'conv.allLang': 'Барлық тілдер', 'conv.allCh': 'Барлық арналар', 'conv.allSt': 'Барлық мәртебелер', 'conv.allScore': 'Кез келген балл', 'conv.allAppeal': 'Кез келген апелляция', 'conv.withAppeal': 'Ашық апелляциямен', 'conv.noAppeal': 'Апелляциясыз', 'conv.nothing': 'Ештеңе табылмады', 'conv.noDs': 'Жүктелген жиын жоқ. DEV-ті API арқылы немесе JSON файлмен жүктеңіз.', 'conv.shown': 'Көрсетілді', 'conv.of': '/', 'conv.prev': 'Артқа', 'conv.next': 'Алға', 'conv.reset': 'Сүзгілерді тазалау',
      'ch.chat': 'чат', 'ch.call': 'қоңырау',
      'stat.not_evaluated': 'Бағаланбаған', 'stat.evaluated': 'Бағаланды', 'stat.appealed': 'Апелляция', 'stat.reviewed': 'Қайта қаралды', 'stat.error': 'Қате',
      'dlg.back': 'Диалогтар', 'dlg.history': 'Бағалау тарихы', 'dlg.checklist': 'Чек-парақ', 'dlg.eval': 'Бағалау', 'dlg.reeval': 'Қайта бағалау', 'dlg.challenge': 'Бағаға шағым', 'dlg.transcript': 'Транскрипт', 'dlg.total': 'Қорытынды балл', 'dlg.notEvaluated': 'Диалог әлі бағаланбаған. Чек-парақты таңдап, «Бағалау» батырмасын басыңыз.',
      'sp.client': 'Клиент', 'sp.operator': 'Оператор', 'sp.bot': 'Бот', 'sp.system': 'Жүйе',
      'ap.eyebrow': 'Тексеру', 'ap.title': 'Апелляциялар', 'ap.sub': 'Тексеруші дәлелдерді қарап, бағаны растайды немесе өзгертеді. Қорытынды автоматты түрде қайта есептеледі.', 'ap.pending': 'Қаралуда', 'ap.accepted': 'Қабылданды', 'ap.rejected': 'Қабылданбады', 'ap.resolved': 'Барлық шешілгендер', 'ap.none': 'Апелляция жоқ',
      'cl.eyebrow': 'Баптаулар', 'cl.title': 'Чек-парақ', 'cl.sub': 'Әр сақтау жаңа нұсқа жасайды. Бұрынғы бағалар өз нұсқасына байланған күйде қалады.', 'cl.versions': 'Нұсқалар', 'cl.apply': 'Жиынға қолдану', 'cl.save': 'Жаңа нұсқаны сақтау', 'cl.active': 'белсенді',
    },
  };
  let LANG = LS.get('lang', 'ru');
  if (!I18N[LANG]) LANG = 'ru';
  const t = (k) => (I18N[LANG] && I18N[LANG][k]) || I18N.ru[k] || k;
  const locale = () => ({ ru: 'ru-RU', kk: 'kk-KZ', en: 'en-GB' }[LANG] || 'ru-RU');
  const fmtDate = (s) => (s ? new Date(s).toLocaleString(locale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

  // =====================================================================
  // icons (inline SVG, stroke-based)
  // =====================================================================
  const ICONS = {
    logo: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4M12 16h.01"/>',
    list: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="M3.5 6l1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
    spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 3v4M17 5h4"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
    right: '<path d="M5 12h14M12 5l7 7-7 7"/>',
    left: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    chevrons: '<path d="M11 17l-5-5 5-5M18 17l-5-5 5-5"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
    alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
    play: '<path d="M6 4l14 8-14 8z"/>',
  };
  const ic = (name) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  // =====================================================================
  // shared components
  // =====================================================================
  const scoreCls = (v) => (v === null || v === undefined ? 's-none' : v >= 85 ? 's-good' : v >= 60 ? 's-mid' : 's-bad');
  const scorePill = (v) => `<span class="score ${scoreCls(v)}">${v === null || v === undefined ? '—' : v}</span>`;
  function answerBadge(c, a) {
    if (c.type === 'flag') return a === 'yes' ? '<span class="badge b-flag">Нарушение</span>' : '<span class="badge b-yes">Нет нарушений</span>';
    if (a === 'na') return '<span class="badge b-na">N/A</span>';
    if (a === 'yes') return '<span class="badge b-yes">Да</span>';
    if (a === 'no') return '<span class="badge b-no">Нет</span>';
    return `<span class="badge b-scale">${esc(a)}${c.scale_max ? ' / ' + c.scale_max : ''}</span>`;
  }
  const answerText = (a) => (a === 'yes' ? 'Да' : a === 'no' ? 'Нет' : a === 'na' ? 'N/A' : String(a));
  const speakerLabel = (s) => t('sp.' + s) || s;
  const scaleMax = (c) => (c.type === 'scale' && c.scale && c.scale.length ? Math.max(...c.scale.map((s) => Number(s.value))) : null);

  let ringSeq = 0;
  // Circular progress (SVG): pct 0..100, value text, caption.
  function ring(pct, value, caption, tone) {
    const id = 'rg' + ++ringSeq;
    const r = 52, c = 2 * Math.PI * r;
    const p = pct === null || pct === undefined || Number.isNaN(pct) ? 0 : Math.max(0, Math.min(100, pct));
    const [a, b] = tone === 'alt' ? ['#8b7bff', '#5fa8ff'] : ['#7b70ff', '#5146e8'];
    return `<div class="ring" role="img" aria-label="${esc(caption)}: ${esc(value)}"><svg viewBox="0 0 120 120"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
      <circle class="trk" cx="60" cy="60" r="${r}" stroke-width="11" fill="none"/>
      <circle class="val" cx="60" cy="60" r="${r}" stroke-width="11" fill="none" stroke="url(#${id})" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - p / 100)).toFixed(1)}"/></svg>
      <div class="lbl"><div><b>${esc(value)}</b><small>${esc(caption)}</small></div></div></div>`;
  }

  function openDrawer(html) {
    closeOverlay();
    const s = document.createElement('div');
    s.className = 'scrim';
    const d = document.createElement('aside');
    d.className = 'drawer';
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', 'true');
    d.innerHTML = html;
    root.append(s, d);
    s.onclick = closeOverlay;
    $$('[data-close]', d).forEach((b) => (b.onclick = closeOverlay));
    return d;
  }
  function openModal(html) {
    closeOverlay();
    const s = document.createElement('div');
    s.className = 'scrim';
    const m = document.createElement('div');
    m.className = 'modal';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.innerHTML = html;
    root.append(s, m);
    s.onclick = closeOverlay;
    $$('[data-close]', m).forEach((b) => (b.onclick = closeOverlay));
    return m;
  }
  function closeOverlay() { $$('.scrim, .drawer, .modal').forEach((e) => e.remove()); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlay(); });

  // =====================================================================
  // state + shell
  // =====================================================================
  const state = { config: null, openAppeals: 0, datasets: [], group: null };
  let pollTimer = null;

  async function refreshMeta() {
    try {
      const [config, open, datasets] = await Promise.all([api('/config'), api('/appeals?status=open'), api('/datasets')]);
      state.config = config;
      state.openAppeals = open.length;
      state.datasets = datasets;
      state.group = LS.get('group', null);
      if (!datasets.some((d) => d.group_id === state.group)) state.group = (datasets.find((d) => d.group_id === 'DEV') || datasets[0] || {}).group_id || null;
    } catch (e) { /* the page shows its own error */ }
  }

  function shell(active, crumb, inner) {
    const c = state.config || {};
    const ds = state.datasets.find((d) => d.group_id === state.group);
    const mode = SNAPSHOT ? 'demo' : c.storage === 'mongodb' ? 'online' : 'local';
    const nav = [
      ['overview', '#/overview', 'grid', t('nav.overview'), ''],
      ['dialogs', '#/dialogs', 'chat', t('nav.conversations'), ds ? `<span class="cnt">${ds.total}</span>` : ''],
      ['appeals', '#/appeals', 'shield', t('nav.appeals'), state.openAppeals ? `<span class="cnt hot">${state.openAppeals}</span>` : ''],
      ['checklists', '#/checklists', 'list', t('nav.checklist'), ''],
    ];
    const model = c.provider === 'rules' ? t('top.heuristic') : `${c.provider || '—'} · ${c.model || '—'}`;
    root.innerHTML = `
      <div class="app ${LS.get('collapsed', false) ? 'collapsed' : ''}" id="app">
        <aside class="side" aria-label="${esc(t('nav.menu'))}">
          <div class="brand"><span class="mark">${ic('logo')}</span><div><b>clarity.</b><small>${esc(t('brand.sub'))}</small></div>
            <button class="collapse" id="collapse" title="${esc(t('nav.collapse'))}" aria-label="${esc(t('nav.collapse'))}">${ic('chevrons')}</button></div>
          <div class="navlabel">${esc(t('nav.workspace'))}</div>
          <nav class="nav">${nav.map(([k, href, icon, label, extra]) => `<a href="${href}" class="${active === k ? 'on' : ''}" ${active === k ? 'aria-current="page"' : ''} title="${esc(label)}">${ic(icon)}<span>${esc(label)}</span>${extra}</a>`).join('')}</nav>
          <div class="grow"></div>
          <div class="dscard">
            <div class="row1"><span class="dot ${mode === 'demo' ? 'demo' : ''}"></span>${esc(t('ds.active'))}<span class="tag">${esc(state.group || '—')}</span></div>
            <b>${ds ? `${ds.total} ${esc(t('ds.dialogs'))}` : esc(t('ds.none'))}</b>
            <span class="m">${esc(t('ds.' + mode))}</span>
          </div>
          <div class="profile"><span class="avatar">QA</span><div><b>${esc(t('profile.name'))}</b><small>${esc(t('profile.role'))}</small></div></div>
        </aside>
        <div class="mainwrap">
          <header class="topbar">
            <button class="iconbtn burger" id="burger" aria-label="${esc(t('nav.menu'))}">${ic('menu')}</button>
            <div class="crumbs">${crumb}</div>
            <div class="r">
              <span class="chip hide-sm" title="${esc(t('top.model'))}"><span class="dot ${mode === 'demo' ? 'warn' : ''}"></span>${esc(model)}</span>
              <select class="langsel" id="lang" aria-label="${esc(t('top.lang'))}">${['ru', 'kk', 'en'].map((l) => `<option value="${l}" ${l === LANG ? 'selected' : ''}>${l === 'kk' ? 'KZ' : l.toUpperCase()}</option>`).join('')}</select>
              <a class="iconbtn" href="#/checklists" title="${esc(t('top.settings'))}" aria-label="${esc(t('top.settings'))}">${ic('sliders')}</a>
              <a class="iconbtn" href="https://github.com/AkhmadAssentay/cqa-freedom#readme" target="_blank" rel="noopener" title="${esc(t('top.help'))}" aria-label="${esc(t('top.help'))}">${ic('help')}</a>
            </div>
          </header>
          ${SNAPSHOT ? `<div class="demo-banner">${ic('spark')}<div><b>${esc(t('demo.title'))}</b> · ${esc(t('demo.text'))}</div></div>` : ''}
          <main>${inner}</main>
        </div>
      </div>`;
    $('#collapse').onclick = () => { LS.set('collapsed', !LS.get('collapsed', false)); $('#app').classList.toggle('collapsed'); };
    $('#burger').onclick = () => $('#app').classList.toggle('navopen');
    $$('.nav a').forEach((a) => a.addEventListener('click', () => $('#app').classList.remove('navopen')));
    // on phones the sidebar is an overlay: a tap outside it closes it
    $('.mainwrap').addEventListener('click', (e) => { if ($('#app').classList.contains('navopen') && !e.target.closest('#burger')) $('#app').classList.remove('navopen'); });
    $('#lang').onchange = (e) => { LANG = e.target.value; LS.set('lang', LANG); router(); };
  }
  const crumbs = (...parts) => parts.map((p, i) => (i === parts.length - 1 ? `<b>${esc(p)}</b>` : `<span>${esc(p)}</span><span>/</span>`)).join('');
  const loadingPage = () => `<div class="stack"><div class="skeleton" style="width:30%;height:26px"></div><div class="kpis"><div class="card"><div class="skeleton" style="height:120px"></div></div><div class="card"><div class="skeleton" style="height:120px"></div></div></div><div class="card"><div class="skeleton"></div><div class="skeleton" style="margin-top:12px"></div><div class="skeleton" style="margin-top:12px;width:70%"></div></div></div>`;

  // =====================================================================
  // router
  // =====================================================================
  async function router() {
    clearInterval(pollTimer);
    closeOverlay();
    const h = location.hash.replace(/^#/, '') || '/overview';
    const [pathPart, qs] = h.split('?');
    const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
    const q = new URLSearchParams(qs || '');
    const page = parts[0] || 'overview';
    await refreshMeta();
    if (!q.get('msg') && !q.get('crit')) window.scrollTo(0, 0);
    const active = { dialog: 'dialogs', dialogs: 'dialogs', checklists: 'checklists', appeals: 'appeals' }[page] || 'overview';
    shell(active, crumbs(t('nav.workspace'), t('nav.' + (active === 'dialogs' ? 'conversations' : active === 'checklists' ? 'checklist' : active))), loadingPage());
    try {
      if (page === 'dialog') return await viewDialog(parts[1], parts[2], q);
      if (page === 'dialogs') return await viewDialogs(q);
      if (page === 'checklists') return await viewChecklists(parts[1]);
      if (page === 'appeals') return await viewAppeals(q.get('tab') || 'open');
      return await viewOverview();
    } catch (e) {
      shell(active, crumbs(t('nav.workspace')), `<div class="card empty">${ic('alert')}<div><b>${esc(e.message)}</b></div></div>`);
    }
  }
  window.addEventListener('hashchange', router);

  // =====================================================================
  // OVERVIEW
  // =====================================================================
  function critStats(c, rows) {
    // rows: export entries; per-criterion answers of the latest evaluation of each dialog
    const vals = rows.map((r) => (r.criteria || []).find((x) => x.id === c.id)).filter(Boolean);
    const max = scaleMax(c);
    let pass = 0, fail = 0, partial = 0, na = 0, sum = 0, n = 0, flagged = 0;
    for (const v of vals) {
      const a = v.answer;
      if (c.type === 'flag') { if (a === 'yes') flagged++; continue; }
      if (a === 'na' || a === null || a === undefined) { na++; continue; }
      const f = c.type === 'scale' ? Number(a) / (max || 1) : a === 'yes' ? 1 : 0;
      sum += f; n++;
      if (f >= 1) pass++; else if (f <= 0) fail++; else partial++;
    }
    const pct = n ? (sum / n) * 100 : null;
    let status;
    if (c.type === 'flag') status = flagged ? ['b-critical', `${t('st.critical')}: ${flagged}`] : ['b-pass', t('st.clean')];
    else if (pct === null) status = ['b-na', t('st.na')];
    else if (pct >= 85) status = ['b-pass', t('st.pass')];
    else if (pct >= 60) status = ['b-partial', t('st.partial')];
    else status = ['b-fail', t('st.fail')];
    const result = c.type === 'flag' ? `${flagged} / ${vals.length}` : pct === null ? '—' : c.type === 'scale' ? `${((sum / n) * max).toFixed(1)} / ${max}` : `${pct.toFixed(0)}%`;
    return { vals, pass, fail, partial, na, flagged, pct, status, result, n };
  }

  async function viewOverview() {
    const group = state.group;
    if (!group) {
      return shell('overview', crumbs(t('nav.workspace'), t('nav.overview')), `
        <div class="ph"><div><div class="eyebrow">${esc(t('ov.eyebrow'))}</div><h1>${esc(t('ov.title'))}</h1><p class="sub">${esc(t('ov.sub'))}</p></div></div>
        <div class="card empty">${ic('inbox')}<div><b>${esc(t('conv.noDs'))}</b></div><p><a class="btn primary" href="#/dialogs">${ic('upload')}${esc(t('ov.import'))}</a></p></div>`);
    }
    const [list, exp, open] = await Promise.all([
      api('/conversations?group_id=' + enc(group)),
      api('/export?group_id=' + enc(group)).catch(() => []),
      api('/appeals?status=open').catch(() => []),
    ]);
    const cl = await api('/checklists/' + enc(list.checklist_uid));
    const items = list.items;
    const evaluated = items.filter((i) => i.total !== null);
    const avg = evaluated.length ? evaluated.reduce((s, i) => s + i.total, 0) / evaluated.length : null;
    const coverage = items.length ? (evaluated.length / items.length) * 100 : 0;
    const gross = items.filter((i) => i.gross_error).length;
    const review = items.reduce((s, i) => s + (i.needs_review || 0), 0);
    const errors = items.filter((i) => i.status === 'error').length;
    const rows = exp.filter((r) => r.criteria);
    const stats = cl.criteria.map((c) => ({ c, s: critStats(c, rows) }));
    const attention = evaluated.slice().sort((a, b) => (b.gross_error - a.gross_error) || a.total - b.total).slice(0, 6);

    shell('overview', crumbs(t('nav.workspace'), t('nav.overview')), `
      <div class="ph">
        <div><div class="eyebrow">${esc(t('ov.eyebrow'))}</div><h1>${esc(t('ov.title'))}</h1><p class="sub">${esc(t('ov.sub'))}</p></div>
        <div class="actions">
          <a class="btn" href="#/dialogs?group=${enc(group)}">${ic('upload')}${esc(t('ov.import'))}</a>
          <a class="btn primary" href="#/dialogs?group=${enc(group)}&run=missing">${ic('spark')}${esc(t('ov.run'))}</a>
        </div>
      </div>
      <div class="kpis">
        <section class="card kpi-card"><span class="corner">${esc(group)} · ${esc(cl.uid)}</span>
          <div class="kpi">${ring(avg, avg === null ? '—' : avg.toFixed(1), t('ov.score_lbl'))}
            <div><h3>${esc(t('ov.score'))}</h3><p>${esc(t('ov.score_d'))}</p>
              <div class="meta"><span><i style="background:var(--good)"></i>${evaluated.length} ${esc(t('ov.evaluated'))}</span><span><i style="background:var(--bad)"></i>${gross} ${esc(t('ov.gross'))}</span></div></div></div>
        </section>
        <section class="card kpi-card"><span class="corner">${evaluated.length} / ${items.length}</span>
          <div class="kpi">${ring(coverage, coverage.toFixed(0) + '%', t('ov.cov_lbl'), 'alt')}
            <div><h3>${esc(t('ov.cov'))}</h3><p>${esc(t('ov.cov_d'))}</p>
              <div class="meta"><span><i style="background:var(--brand)"></i>${items.length - evaluated.length} ${esc(t('ov.pending'))}</span>${review ? `<span><i style="background:var(--warn)"></i>${review} ${esc(t('ov.review'))}</span>` : ''}${errors ? `<span><i style="background:var(--bad)"></i>${errors} ${esc(t('ov.errors'))}</span>` : ''}</div></div></div>
        </section>
      </div>
      <section class="tablewrap" style="margin-bottom:18px">
        <div class="card-h" style="padding:18px 20px 0;margin:0"><div><h2>${esc(t('ov.breakdown'))}</h2><p class="sub small">${esc(t('ov.breakdown_d'))}</p></div></div>
        ${rows.length ? `<table class="t" style="margin-top:14px"><thead><tr><th>${esc(t('col.criterion'))}</th><th>${esc(t('col.result'))}</th><th>${esc(t('col.weight'))}</th><th>${esc(t('col.dist'))}</th><th>${esc(t('col.status'))}</th><th style="text-align:right">${esc(t('col.evidence'))}</th></tr></thead><tbody>
          ${stats.map(({ c, s }) => `<tr class="click" data-crit="${esc(c.id)}" tabindex="0">
            <td class="tname"><b>${esc(c.code || c.id)} · ${esc(c.name)}</b><span>${esc(c.type === 'scale' ? 'шкала ' + (c.scale || []).map((x) => x.value).sort((a, b) => a - b).join('/') : c.type === 'flag' ? 'флаг, без баллов' : 'да / нет')}${c.na_allowed ? ' · N/A' : ''}</span></td>
            <td><span class="score ${c.type === 'flag' ? (s.flagged ? 's-bad' : 's-good') : scoreCls(s.pct)}">${esc(s.result)}</span>${c.type !== 'flag' && s.pct !== null ? `<span class="minibar"><i style="width:${s.pct.toFixed(0)}%;background:${s.pct >= 85 ? 'var(--good)' : s.pct >= 60 ? '#f59e0b' : 'var(--bad)'}"></i></span>` : ''}</td>
            <td>${c.type === 'flag' ? '—' : esc(c.weight)}</td>
            <td class="small muted">${c.type === 'flag' ? `${s.flagged} нар. · ${s.vals.length - s.flagged} без` : `✓ ${s.pass}${s.partial ? ` · ◐ ${s.partial}` : ''} · ✕ ${s.fail}${s.na ? ` · N/A ${s.na}` : ''}`}</td>
            <td><span class="badge ${s.status[0]}">${esc(s.status[1])}</span></td>
            <td><div class="acts"><button class="iconbtn" data-ev="${esc(c.id)}" title="${esc(t('act.evidence'))}" aria-label="${esc(t('act.evidence'))}">${ic('eye')}</button><button class="iconbtn" data-det="${esc(c.id)}" title="${esc(t('act.details'))}" aria-label="${esc(t('act.details'))}">${ic('right')}</button></div></td>
          </tr>`).join('')}
        </tbody></table>` : `<div class="empty">${ic('inbox')}<div>${esc(t('ov.no_data'))}</div><p><a class="btn" href="#/dialogs?group=${enc(group)}">${esc(t('ov.go_conv'))}</a></p></div>`}
      </section>
      <div class="grid2">
        <section class="card"><div class="card-h"><div><h2>${esc(t('ov.attention'))}</h2><p class="sub small">${esc(t('ov.attention_d'))}</p></div><div class="spacer"></div><a class="btn small" href="#/dialogs?group=${enc(group)}">${esc(t('act.open'))} ${ic('right')}</a></div>
          ${attention.length ? attention.map((i) => `<a class="listlink" href="#/dialog/${enc(group)}/${enc(i.conversation_id)}">${i.channel === 'voice call' ? ic('phone') : ic('chat')}<div class="grow"><b class="mono">${esc(i.conversation_id)}</b><span>${esc(i.language)} · ${i.messages} ${esc(t('col.msgs').toLowerCase())}${i.gross_error ? ' · ' + esc(t('st.critical')) : ''}</span></div>${i.gross_error ? '<span class="badge b-critical nodot">!</span>' : ''}${scorePill(i.total)}</a>`).join('') : `<div class="empty small">${esc(t('ov.no_data'))}</div>`}
        </section>
        <section class="card"><div class="card-h"><div><h2>${esc(t('ov.appeals'))}</h2><p class="sub small">${esc(t('ov.appeals_d'))}</p></div><div class="spacer"></div><a class="btn small" href="#/appeals">${esc(t('act.open'))} ${ic('right')}</a></div>
          ${open.length ? open.slice(0, 6).map((a) => `<a class="listlink" href="#/appeals">${ic('flag')}<div class="grow"><b class="mono">${esc(a.conversation_id)}</b><span>${esc(a.criterion_name || a.criterion_id)} · «${esc(a.comment)}»</span></div>${scorePill(a.total)}</a>`).join('') : `<div class="empty small">${ic('check')}<div>${esc(t('ov.no_appeals'))}</div></div>`}
        </section>
      </div>`);

    const openCrit = (cid, focusList) => {
      const { c, s } = stats.find((x) => x.c.id === cid);
      const entries = rows.map((r) => ({ r, v: (r.criteria || []).find((x) => x.id === cid) })).filter((e) => e.v);
      const rank = (v) => (c.type === 'flag' ? (v.answer === 'yes' ? 0 : 2) : v.answer === 'na' ? 3 : c.type === 'scale' ? Number(v.answer) / (scaleMax(c) || 1) : v.answer === 'yes' ? 2 : 0);
      entries.sort((a, b) => rank(a.v) - rank(b.v));
      const cx = { ...c, scale_max: scaleMax(c) };
      const d = openDrawer(`
        <div class="dh"><div style="flex:1"><div class="eyebrow">${esc(c.code || c.id)} · ${esc(t('col.criterion'))}</div><h2>${esc(c.name)}</h2>
          <div class="row" style="margin-top:8px"><span class="badge ${s.status[0]}">${esc(s.status[1])}</span><span class="chip">${esc(t('col.weight'))}: ${c.type === 'flag' ? '—' : esc(c.weight)}</span><span class="chip">${esc(t('col.result'))}: ${esc(s.result)}</span></div></div>
          <button class="iconbtn" data-close aria-label="close">${ic('x')}</button></div>
        <div class="db">
          ${c.description ? `<details ${focusList ? '' : 'open'}><summary class="small muted" style="cursor:pointer">Правило оценки</summary><div class="small" style="white-space:pre-wrap;margin-top:6px;color:var(--ink-2)">${esc(c.description)}</div></details>` : ''}
          <div class="small muted" style="margin-top:14px">${entries.length} диалогов · сначала невыполненные</div>
          ${entries.map(({ r, v }) => `<div class="dlg-item">
            <div class="row"><a class="mono" href="#/dialog/${enc(group)}/${enc(r.conversation_id)}?crit=${enc(cid)}${v.evidence && v.evidence[0] ? '&msg=' + v.evidence[0].msg : ''}"><b>${esc(r.conversation_id)}</b></a>${answerBadge(cx, v.answer)}<div class="spacer"></div>${scorePill(r.total)}</div>
            <div class="small" style="margin-top:6px;color:var(--ink-2)">${esc(v.explanation || '')}</div>
            <div>${(v.evidence || []).map((e) => `<a class="ev" href="#/dialog/${enc(group)}/${enc(r.conversation_id)}?crit=${enc(cid)}&msg=${e.msg}"><span class="i">[${e.msg + 1}]</span><span>«${esc((e.quote || '').slice(0, 110))}${(e.quote || '').length > 110 ? '…' : ''}»</span></a>`).join('')}</div>
          </div>`).join('')}
        </div>`);
      $$('a', d).forEach((a) => a.addEventListener('click', closeOverlay));
    };
    $$('tr[data-crit]').forEach((tr) => {
      tr.addEventListener('click', (e) => { if (!e.target.closest('button')) openCrit(tr.dataset.crit, true); });
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') openCrit(tr.dataset.crit, true); });
    });
    $$('[data-ev]').forEach((b) => (b.onclick = () => openCrit(b.dataset.ev, true)));
    $$('[data-det]').forEach((b) => (b.onclick = () => openCrit(b.dataset.det, false)));
  }

  // =====================================================================
  // CONVERSATIONS
  // =====================================================================
  async function viewDialogs(q) {
    const datasets = state.datasets;
    const group = q.get('group') || state.group;
    if (group) { LS.set('group', group); state.group = group; }
    const filters = { lang: '', channel: '', q: '', status: '', score: '', appeal: '', sort: 'id', dir: 1, ...LS.get('filters', {}) };
    let page = 0;
    const PAGE = 20;
    let list = null;
    if (group && datasets.some((d) => d.group_id === group)) list = await api('/conversations?group_id=' + enc(group));
    const items = list ? list.items : [];
    const exportHref = SNAPSHOT ? 'data:application/json;charset=utf-8,' + enc(JSON.stringify(SNAPSHOT.responses['/export?group_id=' + enc(group)] || [])) : `${API}/export?group_id=${enc(group)}`;

    shell('dialogs', crumbs(t('nav.workspace'), t('nav.conversations')), `
      <div class="ph">
        <div><div class="eyebrow">${esc(t('conv.eyebrow'))}${group ? ' · ' + esc(group) : ''}</div><h1>${esc(t('conv.title'))}</h1><p class="sub">${esc(t('conv.sub'))}</p></div>
        ${list ? `<div class="actions">
          <a class="btn" href="${exportHref}" ${SNAPSHOT ? `download="cqa_${esc(group)}.json"` : 'target="_blank"'}>${ic('download')}${esc(t('conv.export'))}</a>
          <button class="btn" id="evalAll">${ic('refresh')}${esc(t('conv.evalAll'))}</button>
          <button class="btn primary" id="evalMissing">${ic('spark')}${esc(t('conv.evalMissing'))}</button></div>` : ''}
      </div>
      <section class="card" style="margin-bottom:16px;padding:16px 18px">
        <div class="row">
          <div style="margin-right:6px"><h3>${esc(t('conv.source'))}</h3><div class="small muted">${list ? `${items.length} · ${esc(list.checklist_uid)}` : ''}</div></div>
          <label class="f">${esc(t('conv.dataset'))}<select id="grp">${datasets.map((d) => `<option ${d.group_id === group ? 'selected' : ''} value="${esc(d.group_id)}">${esc(d.group_id)} · ${d.total}</option>`).join('') || '<option>—</option>'}</select></label>
          <label class="f">${esc(t('conv.gid'))}<input id="gid" type="text" placeholder="DEV" style="width:120px"></label>
          <button class="btn" id="fetch" style="align-self:flex-end">${ic('download')}${esc(t('conv.fetch'))}</button>
          <label class="btn" style="cursor:pointer;align-self:flex-end">${ic('upload')}${esc(t('conv.file'))}<input id="file" type="file" accept=".json,application/json" hidden></label>
          <div class="spacer"></div>
          <div id="job" class="row small" aria-live="polite"></div>
        </div>
      </section>
      ${list ? `
      <div class="toolbar">
        <div class="search">${ic('search')}<input id="fq" type="search" placeholder="${esc(t('conv.search'))}" value="${esc(filters.q)}" aria-label="${esc(t('conv.search'))}"></div>
        <select id="flang" aria-label="${esc(t('col.lang'))}"><option value="">${esc(t('conv.allLang'))}</option>${['RU', 'KZ', 'EN'].map((l) => `<option ${filters.lang === l ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="fch" aria-label="${esc(t('col.channel'))}"><option value="">${esc(t('conv.allCh'))}</option><option value="agent chat" ${filters.channel === 'agent chat' ? 'selected' : ''}>${esc(t('ch.chat'))}</option><option value="voice call" ${filters.channel === 'voice call' ? 'selected' : ''}>${esc(t('ch.call'))}</option></select>
        <select id="fst" aria-label="${esc(t('col.state'))}"><option value="">${esc(t('conv.allSt'))}</option>${['not_evaluated', 'evaluated', 'appealed', 'reviewed', 'error'].map((k) => `<option value="${k}" ${filters.status === k ? 'selected' : ''}>${esc(t('stat.' + k))}</option>`).join('')}</select>
        <select id="fsc" aria-label="${esc(t('col.score'))}"><option value="">${esc(t('conv.allScore'))}</option>${[['good', '≥ 85'], ['mid', '60–85'], ['bad', '< 60'], ['gross', t('st.critical')]].map(([v, l]) => `<option value="${v}" ${filters.score === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <select id="fap" aria-label="${esc(t('col.appeals'))}"><option value="">${esc(t('conv.allAppeal'))}</option><option value="open" ${filters.appeal === 'open' ? 'selected' : ''}>${esc(t('conv.withAppeal'))}</option><option value="none" ${filters.appeal === 'none' ? 'selected' : ''}>${esc(t('conv.noAppeal'))}</option></select>
        <button class="btn ghost small" id="freset">${esc(t('conv.reset'))}</button>
      </div>
      <div class="tablewrap"><table class="t"><thead><tr>
        ${[['id', t('col.id')], ['channel', t('col.channel')], ['language', t('col.lang')], ['messages', t('col.msgs')], ['total', t('col.score')], ['gross', t('col.gross')], ['status', t('col.state')], ['date', t('col.date')], ['appeals', t('col.appeals')]].map(([k, l]) => `<th class="sort" data-sort="${k}" aria-sort="${filters.sort === k ? (filters.dir > 0 ? 'ascending' : 'descending') : 'none'}">${esc(l)}${filters.sort === k ? `<span class="arr">${filters.dir > 0 ? '↑' : '↓'}</span>` : ''}</th>`).join('')}
      </tr></thead><tbody id="rows"></tbody></table><div class="pager" id="pager"></div></div>` : `<div class="card empty">${ic('inbox')}<div><b>${esc(t('conv.noDs'))}</b></div></div>`}`);

    const val = (i, k) => ({ id: i.conversation_id, channel: i.channel, language: i.language, messages: i.messages, total: i.total ?? -1, gross: i.gross_error ? 1 : 0, status: i.status, date: i.evaluated_at || '', appeals: i.open_appeals }[k]);
    function filtered() {
      const f = filters;
      const out = items.filter((i) => (!f.lang || i.language === f.lang) && (!f.channel || i.channel === f.channel) && (!f.status || i.status === f.status)
        && (!f.q || i.conversation_id.toLowerCase().includes(f.q.toLowerCase()))
        && (!f.score || (f.score === 'gross' ? i.gross_error : i.total !== null && (f.score === 'good' ? i.total >= 85 : f.score === 'mid' ? i.total >= 60 && i.total < 85 : i.total < 60)))
        && (!f.appeal || (f.appeal === 'open' ? i.open_appeals > 0 : !i.open_appeals)));
      return out.sort((a, b) => { const x = val(a, f.sort), y = val(b, f.sort); return (x > y ? 1 : x < y ? -1 : 0) * f.dir; });
    }
    function renderRows() {
      const rows = filtered();
      const pages = Math.max(1, Math.ceil(rows.length / PAGE));
      page = Math.min(page, pages - 1);
      const slice = rows.slice(page * PAGE, page * PAGE + PAGE);
      $('#rows').innerHTML = slice.map((i) => `
        <tr class="click" data-id="${esc(i.conversation_id)}" tabindex="0">
          <td class="mono"><b>${esc(i.conversation_id)}</b></td>
          <td><span class="row" style="gap:6px;flex-wrap:nowrap">${i.channel === 'voice call' ? ic('phone') : ic('chat')}${esc(i.channel === 'voice call' ? t('ch.call') : t('ch.chat'))}</span></td>
          <td>${esc(i.language)}</td>
          <td>${i.messages}</td>
          <td>${scorePill(i.total)}</td>
          <td>${i.gross_error ? `<span class="badge b-critical nodot" title="${esc(t('st.critical'))}">!</span>` : i.total !== null ? '<span class="muted">—</span>' : ''}</td>
          <td>${i.status === 'error' ? `<span class="badge b-fail" title="${esc(i.error)}">${esc(t('stat.error'))}</span>` : `<span class="badge ${i.status === 'reviewed' ? 'b-changed' : i.status === 'appealed' ? 'b-open' : i.status === 'evaluated' ? 'b-pass' : 'b-na'}">${esc(t('stat.' + i.status))}</span>`}${i.needs_review ? ` <span class="badge b-open" title="Вторая модель не согласилась по ${i.needs_review} критериям">⚑ ${i.needs_review}</span>` : ''}</td>
          <td class="small muted">${fmtDate(i.evaluated_at)}</td>
          <td>${i.open_appeals ? `<span class="badge b-open">${i.open_appeals}</span>` : ''}</td>
        </tr>`).join('') || `<tr><td colspan="9" class="empty">${ic('search')}<div>${esc(t('conv.nothing'))}</div></td></tr>`;
      $('#pager').innerHTML = `<span>${esc(t('conv.shown'))} ${rows.length ? page * PAGE + 1 : 0}–${Math.min(rows.length, (page + 1) * PAGE)} ${esc(t('conv.of'))} ${rows.length}</span><span class="row"><button class="btn small" id="pprev" ${page === 0 ? 'disabled' : ''}>${ic('left')}${esc(t('conv.prev'))}</button><span>${page + 1} / ${pages}</span><button class="btn small" id="pnext" ${page >= pages - 1 ? 'disabled' : ''}>${esc(t('conv.next'))}${ic('right')}</button></span>`;
      $('#pprev').onclick = () => { page--; renderRows(); };
      $('#pnext').onclick = () => { page++; renderRows(); };
      const go = (id) => (location.hash = `#/dialog/${enc(group)}/${enc(id)}`);
      $$('#rows tr.click').forEach((tr) => { tr.addEventListener('click', () => go(tr.dataset.id)); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(tr.dataset.id); }); });
    }
    if (list) {
      renderRows();
      const bindF = (id, key, ev = 'change') => $(id).addEventListener(ev, (e) => { filters[key] = e.target.value; page = 0; LS.set('filters', filters); renderRows(); });
      bindF('#fq', 'q', 'input'); bindF('#flang', 'lang'); bindF('#fch', 'channel'); bindF('#fst', 'status'); bindF('#fsc', 'score'); bindF('#fap', 'appeal');
      $('#freset').onclick = () => { Object.assign(filters, { lang: '', channel: '', q: '', status: '', score: '', appeal: '' }); LS.set('filters', filters); router(); };
      $$('th.sort').forEach((th) => (th.onclick = () => { const k = th.dataset.sort; filters.dir = filters.sort === k ? -filters.dir : 1; filters.sort = k; LS.set('filters', filters); router(); }));
      $('#evalAll').onclick = () => { if (window.confirm(t('conv.evalAll') + '?')) startBatch(false); };
      $('#evalMissing').onclick = () => startBatch(true);
      const running = LS.get('job', null);
      if (running && running.group === group) pollJob(running.id);
      // "Apply to dataset" from the checklist page and "Evaluate pending" from the overview land here
      const run = q.get('run');
      if (run) { history.replaceState(null, '', `#/dialogs?group=${enc(group)}`); if (run === 'missing' || window.confirm(t('conv.evalAll') + '?')) startBatch(run === 'missing'); }
    }

    $('#grp').onchange = (e) => (location.hash = '#/dialogs?group=' + enc(e.target.value));
    $('#fetch').onclick = async () => {
      const g = $('#gid').value.trim() || 'DEV';
      $('#fetch').disabled = true;
      try {
        const r = await api('/datasets/fetch', { method: 'POST', body: { group_id: g } });
        toast(`Загружено ${r.total} диалогов (${r.group_id})`);
        LS.set('group', r.group_id);
        location.hash = '#/dialogs?group=' + enc(r.group_id);
        router();
      } catch (e) { toast(e.message, true); $('#fetch').disabled = false; }
    };
    $('#file').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const payload = JSON.parse(await file.text());
        // results JSON 1.0 (e.g. results/prod/results.json of the final model) -> import as the latest evaluations
        if (payload && payload.schema_version && Array.isArray(payload.results)) {
          const cur = new URLSearchParams((location.hash.split('?')[1]) || '').get('group') || LS.get('group', '');
          const r = await api('/import-results', { method: 'POST', body: { group_id: cur, payload } });
          toast(`Импортировано оценок: ${r.imported}${r.skipped.length ? ', пропущено: ' + r.skipped.length : ''}`);
          router();
          return;
        }
        const g = $('#gid').value.trim() || payload?.data?.dataset_group_id || file.name.replace(/\.json$/i, '');
        const r = await api('/datasets/upload', { method: 'POST', body: { group_id: g, payload } });
        toast(`Загружено ${r.total} диалогов (${r.group_id})`);
        LS.set('group', r.group_id);
        location.hash = '#/dialogs?group=' + enc(r.group_id);
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
    // Online (serverless) mode: the browser evaluates the dialogs one by one.
    async function runClientBatch(job) {
      const ids = job.conversation_ids;
      if (!ids.length) return toast('Нечего оценивать — всё уже оценено');
      let done = 0;
      const errors = [];
      let cost = 0;
      const show = (note) => {
        const el = $('#job');
        if (!el) return;
        const pct = Math.round((done / ids.length) * 100);
        el.innerHTML = `<div class="progress"><i style="width:${pct}%"></i></div> ${done}/${ids.length}${errors.length ? ` · <span style="color:var(--bad)">ошибок ${errors.length}</span>` : ''}${cost ? ` · $${cost.toFixed(4)}` : ''} · не закрывайте вкладку${note ? ` · <span class="muted">${esc(note)}</span>` : ''}`;
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
              show(`лимит модели, повтор через ${wait} с`);
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
  // CONVERSATION DETAIL
  // =====================================================================
  async function viewDialog(group, convId, q) {
    const conv = await api(`/conversations/${enc(convId)}?group_id=${enc(group)}`);
    const rec = conv.record;
    const cls = await api('/checklists');
    const evId = q.get('ev') || (conv.evaluations.filter((e) => e.status !== 'error').slice(-1)[0] || {}).id;
    const ev = evId ? await api('/evaluations/' + evId) : null;
    const res = ev ? ev.final_result || ev.result : null;
    const isCall = rec.channel === 'voice call';
    // the API's audio_url is an HTML player page; the backend resolves it to the mp3 and streams it
    const audioSrc = rec.audio_url ? `${API}/audio?group_id=${enc(group)}&id=${enc(rec.conversation_id)}` : null;

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
    if (ev) for (const c of ev.checklist.criteria) critById[c.id] = { ...c, scale_max: scaleMax(c) };

    shell('dialogs', crumbs(t('nav.workspace'), t('nav.conversations'), rec.conversation_id), `
      <div class="ph" style="align-items:center">
        <a class="iconbtn" href="#/dialogs?group=${enc(group)}" title="${esc(t('dlg.back'))}" aria-label="${esc(t('dlg.back'))}">${ic('left')}</a>
        <div><h1 class="mono" style="font-size:22px;margin:0">${esc(rec.conversation_id)}</h1>
          <div class="row small muted" style="margin-top:4px;gap:8px"><span class="chip">${isCall ? ic('phone') : ic('chat')}${esc(isCall ? t('ch.call') : t('ch.chat'))}</span><span class="chip">${esc(rec.language)}</span><span class="chip">${msgs.length} ${esc(t('col.msgs').toLowerCase())}</span><span class="chip">${esc(group)}</span></div></div>
        <div class="actions">
          ${conv.evaluations.length > 1 ? `<label class="f">${esc(t('dlg.history'))}<select id="evsel">${conv.evaluations.map((e) => `<option value="${e.id}" ${ev && e.id === ev.id ? 'selected' : ''}>${fmtDate(e.created_at)} · ${esc(e.checklist_uid)} · ${e.total ?? (e.status === 'error' ? 'ошибка' : '—')}</option>`).join('')}</select></label>` : ''}
          <label class="f">${esc(t('dlg.checklist'))}<select id="clsel">${cls.items.map((c) => `<option value="${esc(c.uid)}" ${c.uid === cls.active ? 'selected' : ''}>${esc(c.name)} · v${c.version}</option>`).join('')}</select></label>
          ${res ? `<button class="btn" id="challenge" style="align-self:flex-end">${ic('flag')}${esc(t('dlg.challenge'))}</button>` : ''}
          <button class="btn primary" id="run" style="align-self:flex-end">${ic(ev ? 'refresh' : 'spark')}${esc(ev ? t('dlg.reeval') : t('dlg.eval'))}</button>
        </div>
      </div>
      <div class="card-grid">
        <section class="card transcript" id="tr" aria-label="${esc(t('dlg.transcript'))}">
          ${isCall ? `<div class="audio"><div class="small muted" style="margin-bottom:6px">Запись звонка</div>${rec.audio_url ? `<audio id="aud" controls preload="metadata" src="${esc(audioSrc)}"></audio><div class="small"><a href="${esc(rec.audio_url)}" target="_blank" rel="noopener">Открыть запись в новой вкладке ↗</a></div>` : rec.audio_withheld ? '<span class="muted">Запись звонка в публичной версии не публикуется (реальный голос клиента) — она доступна при локальном запуске.</span>' : '<span class="muted">Ссылка на запись отсутствует</span>'}</div>` : ''}
          <div class="legend"><span><i style="background:#dfe5ff"></i>${esc(t('sp.client'))}</span><span><i style="background:#e5e1ff"></i>${esc(t('sp.operator'))}</span><span><i style="background:#eceff1"></i>${esc(t('sp.bot'))}</span><span><i style="border:1px dashed #c9cede;background:#fff"></i>${esc(t('sp.system'))}</span></div>
          ${msgs.map((m) => `
            <div class="msg ${esc(m.speaker)}" id="m-${m.idx}">
              <div class="n">${m.idx + 1}</div>
              <div><div class="who">${esc(speakerLabel(m.speaker))} <span class="ts">${fmtTs(m)}</span>${isCall && rec.audio_url && m.off !== null ? `<button class="play" data-off="${m.off}">▶ слушать</button>` : ''}</div>
              <div class="txt">${esc(m.text)}</div></div>
            </div>`).join('')}
        </section>
        <section id="res">${res ? renderResult(ev, res, critById) : ev && ev.status === 'error' ? `<div class="card">Ошибка оценки: ${esc(ev.error)}</div>` : `<div class="card empty">${ic('spark')}<div>${esc(t('dlg.notEvaluated'))}</div></div>`}</section>
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
    if (q.get('crit')) setTimeout(() => { const c = $('#crit-' + q.get('crit')); if (c) { c.classList.add('hl'); c.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, 100);
    if (q.get('msg')) setTimeout(() => focusMsg(Number(q.get('msg'))), 250);

    $('#run').onclick = async () => {
      const btn = $('#run');
      btn.disabled = true;
      btn.textContent = 'Оценка…';
      try {
        const out = await api('/evaluate', { method: 'POST', body: { conversation_id: rec.conversation_id, group_id: group, checklist_uid: $('#clsel').value } });
        toast(`Готово: ${out.result.total ?? '—'} баллов`);
        location.hash = `#/dialog/${enc(group)}/${enc(rec.conversation_id)}?ev=${out.id}`;
      } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = ev ? t('dlg.reeval') : t('dlg.eval'); }
    };
    if ($('#evsel')) $('#evsel').onchange = (e) => (location.hash = `#/dialog/${enc(group)}/${enc(rec.conversation_id)}?ev=${e.target.value}`);

    async function submitAppeal(cid, comment, want) {
      if (!comment) { toast('Добавьте комментарий', true); return false; }
      try {
        await api('/appeals', { method: 'POST', body: { evaluation_id: ev.id, criterion_id: cid, comment, requested_answer: want === '' ? null : want } });
        toast('Апелляция сохранена и передана проверяющему');
        closeOverlay();
        router();
        return true;
      } catch (e) { toast(e.message, true); return false; }
    }
    // Appeal for any criterion from the header
    if ($('#challenge')) $('#challenge').onclick = () => {
      const crits = res.criteria;
      const m = openModal(`
        <div class="row"><h2>${esc(t('dlg.challenge'))}</h2><div class="spacer"></div><button class="iconbtn" data-close aria-label="close">${ic('x')}</button></div>
        <p class="sub small" style="margin:0">Выберите критерий, с оценкой которого вы не согласны, и объясните почему. Проверяющий увидит спорную оценку, комментарий и фрагмент диалога.</p>
        <label class="f">${esc(t('col.criterion'))}<select id="mc">${crits.map((r) => `<option value="${esc(r.criterion_id)}">${esc(r.code || r.criterion_id)} · ${esc(r.name)} — ${esc(answerText(r.answer))}</option>`).join('')}</select></label>
        <label class="f">Какой результат считаете верным (необязательно)<span id="mwant"></span></label>
        <label class="f">Комментарий *<textarea id="mcom" placeholder="Почему оценка неверна? Укажите номер реплики."></textarea></label>
        <div class="row"><div class="spacer"></div><button class="btn" data-close>Отмена</button><button class="btn primary" id="msend">${ic('flag')}Отправить апелляцию</button></div>`);
      const syncWant = () => { $('#mwant', m).innerHTML = answerSelect(critById[$('#mc', m).value], '', 'mw', true); };
      syncWant();
      $('#mc', m).onchange = syncWant;
      $('#msend', m).onclick = () => submitAppeal($('#mc', m).value, $('#mcom', m).value.trim(), $('#mw', m).value);
    };
    // Appeal from a criterion card
    $$('[data-appeal]').forEach((b) => (b.onclick = () => {
      const cid = b.dataset.appeal;
      const box = $('#af-' + cid);
      if (box.innerHTML) { box.innerHTML = ''; return; }
      const c = critById[cid];
      box.innerHTML = `<div class="appeal-form">
          <b>Апелляция по критерию «${esc(c.name)}»</b>
          <label class="f">Какой результат считаете верным (необязательно)${answerSelect(c, '', 'ap-want-' + cid, true)}</label>
          <label class="f">Комментарий *<textarea id="ap-c-${cid}" placeholder="Почему оценка неверна? Укажите реплику."></textarea></label>
          <div class="row"><button class="btn primary" id="ap-s-${cid}">${ic('flag')}Отправить апелляцию</button><button class="btn" id="ap-x-${cid}">Отмена</button></div>
        </div>`;
      $('#ap-x-' + cid).onclick = () => (box.innerHTML = '');
      $('#ap-s-' + cid).onclick = () => submitAppeal(cid, $('#ap-c-' + cid).value.trim(), $('#ap-want-' + cid).value);
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
      <div class="card">
        <div class="total">
          ${ring(res.total, res.total === null ? '—' : String(res.total), '/ 100')}
          <div>
            <div class="row"><h2>${esc(t('dlg.total'))}</h2>${ev.status === 'reviewed' ? '<span class="badge b-changed">после пересмотра</span>' : ev.status === 'appealed' ? '<span class="badge b-open">апелляция открыта</span>' : ''}</div>
            ${changed ? `<div class="small" style="margin-top:4px">Исходная оценка ИИ: <b>${orig.total}</b> → финальная после пересмотра: <b>${res.total}</b></div>` : ''}
            <div class="small muted" style="margin-top:4px">Чек-лист <span class="mono">${esc(ev.checklist_uid)}</span> · ${fmtDate(ev.created_at)}</div>
            <div class="small muted">${meta.provider === 'rules' ? 'Эвристика без LLM' : esc((meta.provider || '') + ' · ' + (meta.model || ''))}${meta.fallback_from ? ` <span title="Основная модель была на лимите">(резервная вместо ${esc(meta.fallback_from)})</span>` : ''}${meta.usage ? ` · токены ${meta.usage.input}+${meta.usage.output}` : ''}${meta.cost_usd ? ` · $${meta.cost_usd.toFixed(4)}` : ''}${meta.duration_ms ? ` · ${(meta.duration_ms / 1000).toFixed(1)} с` : ''}</div>
          </div>
        </div>
        ${res.total === null ? '<div class="warn">Нет применимых критериев с весом — итог не рассчитывается.</div>' : ''}
        ${res.gross_error ? `<div class="gross">${ic('alert')}Выявлена грубая ошибка — см. критерий ${res.gross_error_criteria.map((id) => esc(critById[id]?.code || id)).join(', ')}</div>` : ''}
        <div class="sections">${res.sections.filter((s) => s.has_weight).map((s) => `<div class="sec">${esc(s.name)}<b>${s.percent === null ? 'N/A' : s.percent + '%'}</b><span>${s.points === null ? '' : `${s.points} из ${s.max_points} балл.`}</span><div class="bar"><i style="width:${s.percent || 0}%"></i></div></div>`).join('')}</div>
      </div>
      ${res.criteria.map((r) => renderCrit(r, critById[r.criterion_id] || r, orig.criteria.find((o) => o.criterion_id === r.criterion_id), appeals.filter((a) => a.criterion_id === r.criterion_id), ev)).join('')}`;
  }

  function renderCrit(r, c, o, appeals, ev) {
    const open = appeals.find((a) => a.status === 'open');
    const ov = (ev.overrides || {})[r.criterion_id];
    const pts = r.type === 'flag' ? '<span class="muted">без баллов</span>' : r.applicable ? `<b>${r.points}</b> / ${r.effective_weight}<br><span class="muted">вес ${r.base_weight}${r.effective_weight !== r.base_weight ? ' → ' + r.effective_weight : ''}</span>` : `<b>—</b><br><span class="muted">вес ${r.base_weight} перераспределён</span>`;
    const range = r.checked_range ? JSON.stringify(r.checked_range) : '';
    return `
      <div class="crit ${r.type === 'flag' && r.answer === 'yes' ? 'flagged' : ''}" id="crit-${esc(r.criterion_id)}">
        <div class="head">
          <span class="code">${esc(r.code || r.criterion_id)}</span>
          <span class="name">${esc(r.name)}</span>
          ${answerBadge(c, r.answer)}
          ${r.overridden ? '<span class="badge b-changed">изменено проверяющим</span>' : ''}
          <div class="pts">${pts}</div>
        </div>
        <div class="expl">${r.answer === 'na' ? '<b>N/A: </b>' : ''}${esc(o && r.overridden ? o.explanation : r.explanation)}</div>
        <div>${r.evidence.map((e) => `<button class="ev ${e.verified ? '' : 'unv'}" data-goto="${e.msg}" ${range ? `data-range='${range}'` : ''} title="${e.verified ? 'Перейти к реплике' : 'Цитата не найдена дословно'}"><span class="i">[${e.msg + 1}]</span><span>${esc(speakerLabel(e.speaker || ''))} · «${esc(e.quote.length > 140 ? e.quote.slice(0, 140) + '…' : e.quote)}»</span></button>`).join('')}
          ${r.checked_range ? `<button class="ev" data-goto="${r.checked_range[0]}" data-range='${range}' title="Проверенный участок"><span class="i">⟷</span><span>проверенный участок [${r.checked_range[0] + 1}–${r.checked_range[1] + 1}]</span></button>` : ''}
        </div>
        ${(r.warnings || []).filter((w) => !/^Эвристика/.test(w)).map((w) => `<div class="warn">${ic('alert')}<span>${esc(w)}</span></div>`).join('')}
        ${ov ? `<div class="override">Исходно (ИИ): <b>${esc(answerText(o.answer))}</b>${o.points !== null && o.points !== undefined ? ` (${o.points} балл.)` : ''} → решение проверяющего: <b>${esc(answerText(r.answer))}</b>. Причина: ${esc(ov.reason)} <span class="muted">— ${esc(ov.reviewer)}</span></div>` : ''}
        ${appeals.filter((a) => a.status !== 'open' && !(ov && ov.appeal_id === a.id)).map((a) => `<div class="override">Апелляция отклонена, оценка подтверждена. Причина: ${esc(a.decision.reason)} <span class="muted">— ${esc(a.decision.reviewer)}</span></div>`).join('')}
        <div class="row" style="margin-top:10px">
          ${open ? `<span class="badge b-open">Апелляция на рассмотрении</span><span class="small muted">«${esc(open.comment)}»</span><a class="btn small" href="#/appeals">Рассмотреть ${ic('right')}</a>` : `<button class="btn small" data-appeal="${esc(r.criterion_id)}">${ic('flag')}Оспорить</button>`}
        </div>
        <div id="af-${esc(r.criterion_id)}"></div>
      </div>`;
  }

  // =====================================================================
  // CHECKLIST SETTINGS
  // =====================================================================
  async function viewChecklists(uid) {
    const cls = await api('/checklists');
    const sel = uid || cls.active;
    const cl = JSON.parse(JSON.stringify(await api('/checklists/' + enc(sel))));
    shell('checklists', crumbs(t('nav.workspace'), t('nav.checklist')), `
      <div class="ph">
        <div><div class="eyebrow">${esc(t('cl.eyebrow'))}</div><h1>${esc(t('cl.title'))}</h1><p class="sub">${esc(t('cl.sub'))}</p></div>
        <div class="actions">
          ${cl.uid !== cls.active ? '<button class="btn" id="activate">Сделать активным</button>' : ''}
          <button class="btn" id="exp">${ic('download')}Экспорт JSON</button>
          <a class="btn" href="#/dialogs?group=${enc(state.group || '')}&run=all" id="apply" title="Переоценить текущий набор активным чек-листом">${ic('refresh')}${esc(t('cl.apply'))}</a>
          <button class="btn primary" id="save">${ic('check')}${esc(t('cl.save'))}</button>
        </div>
      </div>
      <div class="cl-grid">
        <aside class="card vlist">
          <h2>${esc(t('cl.versions'))}</h2>
          ${cls.items.slice().reverse().map((c) => `<a href="#/checklists/${enc(c.uid)}" class="${c.uid === sel ? 'on' : ''}"><div><b>${esc(c.name)}</b></div><div class="small muted">v${c.version} · ${c.criteria} крит. · ${fmtDate(c.saved_at)} ${c.uid === cls.active ? `· <span style="color:var(--brand-ink);font-weight:600">${esc(t('cl.active'))}</span>` : ''}</div></a>`).join('')}
          <hr style="border:0;border-top:1px solid var(--line);margin:14px 0">
          <label class="btn" style="display:flex;justify-content:center;cursor:pointer">${ic('upload')}Импорт JSON<input id="imp" type="file" accept=".json" hidden></label>
        </aside>
        <section>
          <div class="card">
            <div class="row">
              <label class="f" style="flex:1;min-width:200px">Название<input id="cl-name" type="text" value="${esc(cl.name)}"></label>
              <label class="f">ID семейства<input id="cl-id" type="text" value="${esc(cl.id)}" style="width:170px"></label>
              <label class="f">Порог первой реакции, сек<input id="cl-thr" type="number" value="${cl.settings?.first_response_threshold_sec ?? 180}" style="width:130px"></label>
              <label class="f">Округление<input id="cl-rnd" type="number" min="0" max="4" value="${cl.settings?.rounding ?? 2}" style="width:90px"></label>
            </div>
            <div class="row" style="margin-top:12px">
              <div>Сумма весов активных критериев: <span class="wsum" id="wsum"></span> <span class="muted small">(при N/A веса перераспределяются автоматически, максимум всегда 100)</span></div>
            </div>
          </div>
          <div class="card" style="margin-top:12px">
            <h2>Секции</h2>
            <div id="secs" style="margin-top:8px"></div>
            <button class="btn small" id="addsec" style="margin-top:8px">${ic('plus')}секция</button>
          </div>
          <div id="crits"></div>
          <button class="btn" id="addcrit" style="margin-top:12px">${ic('plus')}Добавить критерий</button>
        </section>
      </div>`);

    cl.sections = cl.sections || [];
    function renderSecs() {
      $('#secs').innerHTML = cl.sections.map((s, i) => `<div class="row" style="margin-top:6px"><input type="text" class="mono" data-sid="${i}" value="${esc(s.id)}" style="width:130px" aria-label="ID секции"><input type="text" data-sname="${i}" value="${esc(s.name)}" style="flex:1" aria-label="Название секции"><button class="btn small danger" data-sdel="${i}" aria-label="Удалить секцию">${ic('x')}</button></div>`).join('');
      $$('[data-sid]').forEach((el) => (el.oninput = () => { cl.sections[el.dataset.sid].id = el.value.trim(); }));
      $$('[data-sid]').forEach((el) => (el.onchange = renderCrits));
      $$('[data-sname]').forEach((el) => (el.oninput = () => { cl.sections[el.dataset.sname].name = el.value; }));
      $$('[data-sdel]').forEach((el) => (el.onclick = () => { cl.sections.splice(Number(el.dataset.sdel), 1); renderSecs(); renderCrits(); }));
    }
    function wsum() {
      const s = cl.criteria.filter((c) => c.type !== 'flag' && c.active !== false).reduce((a, c) => a + (Number(c.weight) || 0), 0);
      const el = $('#wsum');
      el.textContent = s;
      el.className = 'wsum' + (s === 100 ? '' : ' off');
    }
    function renderCrits() {
      $('#crits').innerHTML = cl.criteria.map((c, i) => `
        <div class="ced ${c.active === false ? 'off' : ''}" data-i="${i}">
          <div class="g">
            <label class="f">Код<input type="text" data-k="code" value="${esc(c.code || '')}"></label>
            <label class="f">Название критерия<input type="text" data-k="name" value="${esc(c.name)}"></label>
            <label class="f">Секция<select data-k="section"><option value="">—</option>${cl.sections.map((s) => `<option value="${esc(s.id)}" ${s.id === c.section ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
            <label class="f">Тип ответа<select data-k="type"><option value="binary" ${c.type === 'binary' ? 'selected' : ''}>Да / Нет</option><option value="scale" ${c.type === 'scale' ? 'selected' : ''}>Шкала</option><option value="flag" ${c.type === 'flag' ? 'selected' : ''}>Флаг (без баллов)</option></select></label>
            <label class="f">Вес<input type="number" min="0" data-k="weight" value="${c.type === 'flag' ? 0 : c.weight}" ${c.type === 'flag' ? 'disabled' : ''}></label>
            <div class="row" style="gap:4px">
              <button class="btn small" data-mv="-1" title="Вверх" aria-label="Вверх">↑</button><button class="btn small" data-mv="1" title="Вниз" aria-label="Вниз">↓</button>
              <button class="btn small danger" data-del title="Удалить" aria-label="Удалить">${ic('x')}</button>
            </div>
          </div>
          <label class="f">Правило оценки (что считать «Да» / как ставить баллы)<textarea data-k="description">${esc(c.description || '')}</textarea></label>
          ${Array.isArray(c.checks) && c.checks.length ? (c.checks_signature === [c.name, c.type, String(c.description || '').trim()].join('|')
            ? `<div class="small muted">Подвопросы: ${c.checks.length} (${c.checks.map((qq) => esc(qq.label || qq.id)).join(' · ')}). Модель отвечает на них, итог считается по правилу.</div>`
            : '<div class="small muted">Формулировка изменена — подвопросы отключены, критерий оценивается напрямую по новому правилу.</div>') : ''}
          <div class="g2">
            <label class="switch"><input type="checkbox" data-k="active" ${c.active !== false ? 'checked' : ''}> Активен</label>
            <label class="switch"><input type="checkbox" data-k="na_allowed" ${c.na_allowed ? 'checked' : ''} ${c.type === 'flag' ? 'disabled' : ''}> N/A допустим</label>
            ${c.na_allowed ? `<label class="f">Условие N/A<input type="text" data-k="na_condition" value="${esc(c.na_condition || '')}"></label>` : '<div></div>'}
          </div>
          ${c.type === 'scale' ? `<div><div class="small muted">Шкала (верхняя ступень = полный вес)</div>
            ${(c.scale || []).map((s, j) => `<div class="scale-row"><input type="number" data-sv="${j}" value="${s.value}" aria-label="Значение"><input type="text" data-sl="${j}" value="${esc(s.label)}" aria-label="Описание ступени"><button class="btn small danger" data-sd="${j}" aria-label="Удалить ступень">${ic('x')}</button></div>`).join('')}
            <button class="btn small" data-sa style="margin-top:6px">${ic('plus')}ступень</button></div>` : ''}
          <div class="small muted mono">id: ${esc(c.id)}${c.active === false ? ' · не участвует в оценке' : ''}</div>
        </div>`).join('');
      wsum();
      $$('.ced').forEach((box) => {
        const i = Number(box.dataset.i);
        const c = cl.criteria[i];
        $$('[data-k]', box).forEach((el) => {
          const k = el.dataset.k;
          const handler = () => {
            if (k === 'na_allowed') { c.na_allowed = el.checked; renderCrits(); return; }
            if (k === 'active') { c.active = el.checked; renderCrits(); return; }
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
        $('[data-del]', box).onclick = () => { if (window.confirm(`Удалить критерий «${c.name}»?`)) { cl.criteria.splice(i, 1); renderCrits(); } };
      });
    }
    renderSecs();
    renderCrits();

    $('#addsec').onclick = () => { cl.sections.push({ id: 'sec' + (cl.sections.length + 1), name: 'Новая секция' }); renderSecs(); renderCrits(); };
    $('#addcrit').onclick = () => {
      let n = cl.criteria.length + 1;
      while (cl.criteria.some((c) => c.id === 'c' + String(n).padStart(2, '0'))) n++;
      cl.criteria.push({ id: 'c' + String(n).padStart(2, '0'), code: String(n).padStart(2, '0'), name: 'Новый критерий', section: cl.sections[0]?.id || '', type: 'binary', weight: 10, na_allowed: false, description: '', na_condition: '', active: true });
      renderCrits();
      $$('.ced').slice(-1)[0].scrollIntoView({ behavior: 'smooth' });
    };
    $('#save').onclick = async () => {
      cl.name = $('#cl-name').value.trim();
      cl.id = $('#cl-id').value.trim();
      cl.settings = { ...(cl.settings || {}), first_response_threshold_sec: Number($('#cl-thr').value) || 180, rounding: Number($('#cl-rnd').value) };
      try {
        const saved = await api('/checklists', { method: 'POST', body: { checklist: cl, activate: true } });
        toast(`Сохранено: ${saved.uid} (активный). Нажмите «${t('cl.apply')}», чтобы переоценить набор.`);
        location.hash = '#/checklists/' + enc(saved.uid);
      } catch (e) { toast(e.message, true); }
    };
    $('#apply').onclick = (e) => { if (!state.group) { e.preventDefault(); toast(t('conv.noDs'), true); } };
    if ($('#activate')) $('#activate').onclick = async () => { try { await api('/checklists/' + enc(cl.uid) + '/activate', { method: 'POST', body: {} }); toast('Чек-лист активирован'); router(); } catch (e) { toast(e.message, true); } };
    $('#exp').onclick = () => {
      const { uid: _u, saved_at: _s, ...clean } = cl;
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
        location.hash = '#/checklists/' + enc(saved.uid);
      } catch (err) { toast(err.message, true); }
    };
  }

  // =====================================================================
  // APPEALS (operator files them on the conversation page; reviewer decides here)
  // =====================================================================
  async function viewAppeals(tab) {
    const all = await api('/appeals');
    const groups = { open: (a) => a.status === 'open', accepted: (a) => a.status === 'changed', rejected: (a) => a.status === 'confirmed', closed: (a) => a.status !== 'open' };
    const pick = groups[tab] || groups.open;
    const list = all.filter(pick).reverse();
    const stBadge = (a) => (a.status === 'open' ? `<span class="badge b-open">${esc(t('ap.pending'))}</span>` : a.status === 'changed' ? `<span class="badge b-changed">${esc(t('ap.accepted'))} · оценка изменена</span>` : `<span class="badge b-na">${esc(t('ap.rejected'))} · оценка подтверждена</span>`);
    shell('appeals', crumbs(t('nav.workspace'), t('nav.appeals')), `
      <div class="ph"><div><div class="eyebrow">${esc(t('ap.eyebrow'))}</div><h1>${esc(t('ap.title'))}</h1><p class="sub">${esc(t('ap.sub'))}</p></div></div>
      <div class="tabs" role="tablist">${[['open', t('ap.pending')], ['accepted', t('ap.accepted')], ['rejected', t('ap.rejected')], ['closed', t('ap.resolved')]].map(([k, l]) => `<a role="tab" href="#/appeals?tab=${k}" class="${tab === k ? 'on' : ''}" aria-selected="${tab === k}">${esc(l)} (${all.filter(groups[k]).length})</a>`).join('')}</div>
      <div id="aps">${list.length ? '' : `<div class="card empty">${ic('check')}<div>${esc(t('ap.none'))}</div></div>`}</div>`);
    const box = $('#aps');
    for (const a of list) {
      const [ev, conv] = await Promise.all([api('/evaluations/' + a.evaluation_id), api(`/conversations/${enc(a.conversation_id)}?group_id=${enc(a.group_id)}`)]);
      const c = ev.checklist.criteria.find((x) => x.id === a.criterion_id);
      const row = ev.result.criteria.find((x) => x.criterion_id === a.criterion_id);
      const msgs = conv.record.transcript;
      const idxs = row.evidence.map((e) => e.msg);
      if (row.checked_range) idxs.push(...row.checked_range);
      const lo = Math.max(0, Math.min(...(idxs.length ? idxs : [0])) - 2);
      const hi = Math.min(msgs.length - 1, Math.max(...(idxs.length ? idxs : [msgs.length - 1])) + 2);
      const hl = new Set(row.evidence.map((e) => e.msg));
      const el = document.createElement('div');
      el.className = 'card ap';
      const link = `#/dialog/${enc(a.group_id)}/${enc(a.conversation_id)}?ev=${a.evaluation_id}&crit=${enc(a.criterion_id)}`;
      const cx = { ...c, scale_max: scaleMax(c) };
      el.innerHTML = `
        <div>
          <div class="row"><b class="mono">${esc(a.conversation_id)}</b>${stBadge(a)}<div class="spacer"></div><a class="btn small" href="${link}">Открыть диалог ${ic('right')}</a></div>
          <h2 style="margin-top:12px">${esc(c.code || '')} · ${esc(c.name)}</h2>
          <div class="row small" style="margin-top:6px"><span>Спорная оценка ИИ:</span> ${answerBadge(cx, a.disputed_answer)} ${a.disputed_points !== null && a.disputed_points !== undefined ? `<span class="muted">${a.disputed_points} балл.</span>` : ''} ${a.requested_answer !== null && a.requested_answer !== undefined ? `<span class="muted">· запрошено: <b>${esc(answerText(a.requested_answer))}</b></span>` : ''}</div>
          <div style="margin-top:10px"><b>Обоснование системы:</b> ${esc(row.explanation)}</div>
          <div class="comment"><b>Комментарий (${esc(a.author)}):</b> ${esc(a.comment)}</div>
          ${a.status === 'open' ? `
            <div class="appeal-form">
              <b>Решение проверяющего</b>
              <div class="row"><label class="row small"><input type="radio" name="act-${a.id}" value="confirm"> Подтвердить оценку (отклонить апелляцию)</label><label class="row small"><input type="radio" name="act-${a.id}" value="change"> Изменить на</label>${answerSelect(c, a.requested_answer ?? '', 'ans-' + a.id, false)}</div>
              <label class="f">Причина *<textarea id="rsn-${a.id}" placeholder="Например: системное сообщение [4] подтверждает идентификацию"></textarea></label>
              <div class="row"><button class="btn primary" id="dec-${a.id}">${ic('check')}Сохранить решение</button><span class="small muted">Текущий итог диалога: <b>${a.total ?? '—'}</b></span></div>
            </div>` : `
            <div class="cmp"><div>Исходная оценка ИИ<b>${esc(answerText(a.disputed_answer))}</b></div><div>Решение проверяющего<b>${esc(answerText(a.decision.answer))}</b>${esc(a.decision.reason)}</div><div>Итог диалога<b>${a.decision.total_before} → ${a.decision.total_after}</b>${esc(a.decision.reviewer)} · ${fmtDate(a.decision.decided_at)}</div></div>`}
        </div>
        <div>
          <div class="small muted" style="margin-bottom:6px">Фрагмент диалога [${lo + 1}–${hi + 1}] · выделены реплики-доказательства</div>
          <div class="frag">${msgs.slice(lo, hi + 1).map((m, k) => { const i = lo + k; return `<div class="msg ${esc(m.speaker)} ${hl.has(i) ? 'focus' : ''}"><div class="n">${i + 1}</div><div><div class="who">${esc(speakerLabel(m.speaker))} <span class="ts">${esc(m.timestamp)}</span></div><div class="txt">${esc(m.text)}</div></div></div>`; }).join('')}</div>
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
