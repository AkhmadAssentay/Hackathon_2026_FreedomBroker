'use strict';
// CQA — Conversation Quality Analytics prototype (Node 18+). Runs as a local server (npm start) or as a
// Vercel serverless function (api/index.js at the repository root) with MongoDB storage.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

// ---- minimal .env loader ----
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const store = require('./lib/store');
const { evaluate } = require('./lib/evaluator');
const { score } = require('./lib/scoring');
const llm = require('./lib/llm');

const PORT = Number(process.env.PORT || 3000);
const ORG_API_URL =
  process.env.ORG_API_URL ||
  'https://ec88f21f1accecf38e20095a9fe175.a5.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/11/workflows/b3d2a68006a24662be2b721454cb4e00/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=5Sog2MThgCRTlk3HObv70LRmRk6u7IOwzlwMpe804qo';
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY || 4);
// On serverless hosting a request cannot keep working after its response, so batches run client-side.
const SERVERLESS = !!process.env.VERCEL;

// Seed the default checklist and bundled sample data on first run (once per process).
let seeded = null;
function ensureSeeded() {
  if (!seeded) {
    seeded = (async () => {
      if (!(await store.listChecklists()).length) {
        await store.seedChecklist(JSON.parse(fs.readFileSync(path.join(__dirname, 'checklists', 'default.json'), 'utf8')));
      }
      const sampleFile = path.join(__dirname, 'samples', 'SAMPLE.json');
      if (!(await store.listDatasets()).length && fs.existsSync(sampleFile)) {
        await store.saveDataset('SAMPLE', JSON.parse(fs.readFileSync(sampleFile, 'utf8')).data.records);
      }
    })().catch((e) => { seeded = null; throw e; });
  }
  return seeded;
}

// ---------------- helpers ----------------
function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, {
    'content-type': isStr ? headers['content-type'] || 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body));
}
const fail = (res, status, msg) => send(res, status, { error: msg });

function readBody(req) {
  // On Vercel the runtime parses JSON bodies itself and exposes them as req.body.
  if (process.env.VERCEL && req.body !== undefined) {
    return Promise.resolve(typeof req.body === 'string' ? (req.body ? JSON.parse(req.body) : {}) : req.body || {});
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 50 * 1024 * 1024) reject(new Error('Body too large'));
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function validateChecklist(cl) {
  const errs = [];
  if (!cl || typeof cl !== 'object') return ['Пустой чек-лист'];
  if (!cl.id) errs.push('Нужен id чек-листа');
  if (!cl.name) errs.push('Нужно название');
  if (!Array.isArray(cl.criteria) || !cl.criteria.length) errs.push('Нужен хотя бы один критерий');
  const ids = new Set();
  for (const c of cl.criteria || []) {
    if (!c.id) errs.push('У критерия нет id');
    if (ids.has(c.id)) errs.push(`Повторяющийся id критерия: ${c.id}`);
    ids.add(c.id);
    if (!c.name) errs.push(`Критерий ${c.id}: нет названия`);
    if (!['binary', 'scale', 'flag'].includes(c.type)) errs.push(`Критерий ${c.id}: неизвестный тип ${c.type}`);
    if (c.type !== 'flag' && !(Number(c.weight) >= 0)) errs.push(`Критерий ${c.id}: некорректный вес`);
    if (c.type === 'scale' && (!Array.isArray(c.scale) || c.scale.length < 2)) errs.push(`Критерий ${c.id}: у шкалы должно быть ≥ 2 ступеней`);
    if (c.type === 'scale' && c.scale && c.scale.some((s) => Number.isNaN(Number(s.value)))) errs.push(`Критерий ${c.id}: ступени шкалы должны быть числами`);
  }
  return errs;
}

// Strip a raw organizer API response down to records.
function extractRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && payload.data && Array.isArray(payload.data.records)) return payload.data.records;
  if (payload && Array.isArray(payload.records)) return payload.records;
  throw new Error('Не найден массив records в ответе');
}

function summarize(rec, ev, openAppeals) {
  const fin = ev ? ev.final_result || ev.result : null;
  return {
    conversation_id: rec.conversation_id,
    channel: rec.channel,
    language: rec.language,
    messages: (rec.transcript || []).length,
    has_audio: !!rec.audio_url,
    evaluation_id: ev ? ev.id : null,
    total: fin ? fin.total : null,
    gross_error: fin ? fin.gross_error : false,
    // criteria where the second-opinion model disagreed with the primary one
    needs_review: fin ? fin.criteria.filter((c) => c.needs_review).length : 0,
    status: ev ? ev.status || 'evaluated' : 'not_evaluated',
    open_appeals: openAppeals || 0,
    error: ev ? ev.error || null : null,
  };
}

// Rebuild verdicts from an evaluation (original result + reviewer overrides) and re-score.
function recompute(ev) {
  const verdicts = {};
  for (const r of ev.result.criteria) {
    verdicts[r.criterion_id] = { answer: r.answer, explanation: r.explanation, evidence: r.evidence, checked_range: r.checked_range, warnings: r.warnings };
  }
  for (const [cid, o] of Object.entries(ev.overrides || {})) {
    if (!verdicts[cid]) continue;
    verdicts[cid] = { ...verdicts[cid], answer: o.answer, overridden: true };
  }
  return score(ev.checklist, verdicts);
}

async function runEvaluation(record, groupId, checklist) {
  try {
    const out = await evaluate(record, checklist);
    return await store.addEvaluation({
      conversation_id: record.conversation_id,
      group_id: groupId,
      checklist_uid: checklist.uid,
      checklist,
      result: out.result,
      final_result: out.result,
      overrides: {},
      facts: out.facts,
      meta: out.meta,
      status: 'evaluated',
    });
  } catch (e) {
    // A rate limit is not an evaluation result: report it so the caller can retry later.
    if (e.status === 429) throw Object.assign(new Error('Лимит запросов модели исчерпан, повторите позже'), { status: 429, retryAfterSec: e.retryAfterSec || 20 });
    return await store.addEvaluation({
      conversation_id: record.conversation_id,
      group_id: groupId,
      checklist_uid: checklist.uid,
      checklist,
      result: null,
      final_result: null,
      status: 'error',
      error: String(e.message || e),
    });
  }
}

// ---------------- batch jobs ----------------
const jobs = new Map();
async function runBatch(job, records, groupId, checklist) {
  let i = 0;
  async function worker() {
    while (i < records.length && !job.cancelled) {
      const rec = records[i++];
      const ev = await runEvaluation(rec, groupId, checklist);
      job.done++;
      if (ev.status === 'error') job.errors.push({ conversation_id: rec.conversation_id, error: ev.error });
      if (ev.meta && ev.meta.cost_usd) job.cost_usd += ev.meta.cost_usd;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, records.length || 1) }, worker));
  job.status = job.cancelled ? 'cancelled' : 'done';
  job.finished_at = new Date().toISOString();
}

// ---------------- routes ----------------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/config', async () => {
  const c = llm.config();
  return { provider: c.provider, model: c.model, price_configured: !!(c.priceIn || c.priceOut), active_checklist: (await store.activeChecklist())?.uid, storage: store.backend, serverless: SERVERLESS };
});

// active (or requested) checklist
async function pickChecklist(uid) {
  return (uid && (await store.getChecklist(uid))) || (await store.activeChecklist());
}

// datasets
route('GET', '/api/datasets', () => store.listDatasets());
route('POST', '/api/datasets/fetch', async ({ body }) => {
  const g = String(body.group_id || 'DEV').trim();
  const url = ORG_API_URL + (ORG_API_URL.includes('?') ? '&' : '?') + 'group_id=' + encodeURIComponent(g);
  const r = await fetch(url);
  const txt = await r.text();
  if (!r.ok) throw Object.assign(new Error(`API организаторов: HTTP ${r.status} ${txt.slice(0, 200)}`), { status: 502 });
  const payload = JSON.parse(txt);
  if (payload.isSuccess === false) throw Object.assign(new Error('API организаторов: ' + (payload.error || 'isSuccess=false')), { status: 502 });
  const records = extractRecords(payload);
  await store.saveDataset(g, records);
  return { group_id: g, total: records.length };
});
route('POST', '/api/datasets/upload', async ({ body }) => {
  const records = extractRecords(body.payload);
  const g = String(body.group_id || body.payload?.data?.dataset_group_id || 'UPLOAD').trim();
  await store.saveDataset(g, records);
  return { group_id: g, total: records.length };
});

// conversations
route('GET', '/api/conversations', async ({ query }) => {
  const g = query.get('group_id');
  const cl = await pickChecklist(query.get('checklist'));
  const ds = await store.getDataset(g);
  if (!ds) throw Object.assign(new Error('Набор не найден'), { status: 404 });
  // two queries for the whole list instead of two per dialog
  const latest = await store.latestEvaluations(ds.records.map((r) => r.conversation_id), cl.uid);
  const evIds = Object.values(latest).map((e) => e.id);
  const open = {};
  for (const a of await store.listAppeals({ status: 'open', evaluation_ids: evIds })) open[a.evaluation_id] = (open[a.evaluation_id] || 0) + 1;
  return { group_id: g, checklist_uid: cl.uid, items: ds.records.map((r) => { const e = latest[r.conversation_id] || null; return summarize(r, e, e ? open[e.id] : 0); }) };
});
route('GET', '/api/conversations/:id', async ({ params, query }) => {
  const f = await store.findConversation(decodeURIComponent(params.id), query.get('group_id'));
  if (!f) throw Object.assign(new Error('Диалог не найден'), { status: 404 });
  const evals = (await store.listEvaluations({ conversation_id: f.record.conversation_id })).map((e) => ({ id: e.id, checklist_uid: e.checklist_uid, created_at: e.created_at, status: e.status, total: (e.final_result || e.result || {}).total ?? null }));
  return { group_id: f.group_id, record: f.record, evaluations: evals };
});

// checklists
route('GET', '/api/checklists', async () => ({ active: (await store.activeChecklist())?.uid, items: (await store.listChecklists()).map((c) => ({ uid: c.uid, id: c.id, name: c.name, version: c.version, saved_at: c.saved_at, criteria: c.criteria.length })) }));
route('GET', '/api/checklists/:uid', async ({ params }) => {
  const c = await store.getChecklist(decodeURIComponent(params.uid));
  if (!c) throw Object.assign(new Error('Чек-лист не найден'), { status: 404 });
  return c;
});
route('POST', '/api/checklists', ({ body }) => {
  const errs = validateChecklist(body.checklist);
  if (errs.length) throw Object.assign(new Error(errs.join('; ')), { status: 400 });
  const { uid, saved_at, version, ...clean } = body.checklist;
  return store.saveChecklist(clean, { activate: body.activate !== false });
});
route('POST', '/api/checklists/:uid/activate', async ({ params }) => {
  if (!(await store.setActive(decodeURIComponent(params.uid)))) throw Object.assign(new Error('Чек-лист не найден'), { status: 404 });
  return { active: decodeURIComponent(params.uid) };
});

// evaluation
route('POST', '/api/evaluate', async ({ body }) => {
  const f = await store.findConversation(body.conversation_id, body.group_id);
  if (!f) throw Object.assign(new Error('Диалог не найден'), { status: 404 });
  const cl = await pickChecklist(body.checklist_uid);
  const ev = await runEvaluation(f.record, f.group_id, cl);
  if (ev.status === 'error') throw Object.assign(new Error(ev.error), { status: 502 });
  return ev;
});
route('POST', '/api/evaluate-batch', async ({ body }) => {
  const ds = await store.getDataset(body.group_id);
  if (!ds) throw Object.assign(new Error('Набор не найден'), { status: 404 });
  const cl = await pickChecklist(body.checklist_uid);
  let records = ds.records;
  if (body.only_missing) {
    const latest = await store.latestEvaluations(records.map((r) => r.conversation_id), cl.uid);
    records = records.filter((r) => { const e = latest[r.conversation_id]; return !e || e.status === 'error'; });
  }
  // Serverless: the browser drives the batch, one /api/evaluate call per dialog.
  if (SERVERLESS) return { client_side: true, group_id: body.group_id, checklist_uid: cl.uid, conversation_ids: records.map((r) => r.conversation_id) };
  const job = { id: 'job_' + Date.now(), group_id: body.group_id, checklist_uid: cl.uid, total: records.length, done: 0, errors: [], cost_usd: 0, status: 'running', started_at: new Date().toISOString() };
  jobs.set(job.id, job);
  runBatch(job, records, body.group_id, cl);
  return job;
});
route('GET', '/api/jobs/:id', ({ params }) => {
  const j = jobs.get(params.id);
  if (!j) throw Object.assign(new Error('Задача не найдена'), { status: 404 });
  return j;
});
route('POST', '/api/jobs/:id/cancel', ({ params }) => {
  const j = jobs.get(params.id);
  if (j) j.cancelled = true;
  return j || {};
});
route('GET', '/api/evaluations/:id', async ({ params }) => {
  const e = await store.getEvaluation(params.id);
  if (!e) throw Object.assign(new Error('Оценка не найдена'), { status: 404 });
  return { ...e, appeals: await store.listAppeals({ evaluation_id: e.id }) };
});

// appeals
route('POST', '/api/appeals', async ({ body }) => {
  const ev = await store.getEvaluation(body.evaluation_id);
  if (!ev || !ev.result) throw Object.assign(new Error('Оценка не найдена'), { status: 404 });
  const row = ev.result.criteria.find((c) => c.criterion_id === body.criterion_id);
  if (!row) throw Object.assign(new Error('Критерий не найден'), { status: 400 });
  if (!String(body.comment || '').trim()) throw Object.assign(new Error('Нужен комментарий'), { status: 400 });
  if ((await store.listAppeals({ evaluation_id: ev.id, status: 'open' })).some((a) => a.criterion_id === body.criterion_id))
    throw Object.assign(new Error('По этому критерию уже есть открытая апелляция'), { status: 409 });
  const current = (ev.final_result || ev.result).criteria.find((c) => c.criterion_id === body.criterion_id);
  const ap = await store.addAppeal({
    evaluation_id: ev.id,
    conversation_id: ev.conversation_id,
    group_id: ev.group_id,
    criterion_id: body.criterion_id,
    criterion_name: row.name,
    disputed_answer: current.answer,
    disputed_points: current.points,
    requested_answer: body.requested_answer ?? null,
    comment: String(body.comment).trim(),
    author: body.author || 'Оператор',
  });
  await store.updateEvaluation(ev.id, { status: 'appealed' });
  return ap;
});
route('GET', '/api/appeals', async ({ query }) => {
  const list = await store.listAppeals({ status: query.get('status') || undefined });
  return Promise.all(list.map(async (a) => {
    const ev = await store.getEvaluation(a.evaluation_id);
    return { ...a, total: ev ? (ev.final_result || ev.result).total : null };
  }));
});
route('POST', '/api/appeals/:id/decision', async ({ params, body }) => {
  const ap = await store.getAppeal(params.id);
  if (!ap) throw Object.assign(new Error('Апелляция не найдена'), { status: 404 });
  if (ap.status !== 'open') throw Object.assign(new Error('Апелляция уже рассмотрена'), { status: 409 });
  if (!String(body.reason || '').trim()) throw Object.assign(new Error('Укажите причину решения'), { status: 400 });
  const ev = await store.getEvaluation(ap.evaluation_id);
  const before = (ev.final_result || ev.result).total;
  const overrides = { ...(ev.overrides || {}) };
  let action = body.action === 'change' ? 'change' : 'confirm';
  if (action === 'change') {
    overrides[ap.criterion_id] = { answer: body.answer, reason: body.reason, reviewer: body.reviewer || 'Проверяющий', appeal_id: ap.id, at: new Date().toISOString() };
  }
  const tmp = { ...ev, overrides };
  const final = recompute(tmp);
  const newAnswer = final.criteria.find((c) => c.criterion_id === ap.criterion_id).answer;
  if (action === 'change' && String(newAnswer) === String(ap.disputed_answer)) action = 'confirm';
  const remainingOpen = (await store.listAppeals({ evaluation_id: ev.id, status: 'open' })).filter((a) => a.id !== ap.id).length;
  await store.updateEvaluation(ev.id, { overrides, final_result: final, status: remainingOpen ? 'appealed' : 'reviewed' });
  return store.updateAppeal(ap.id, {
    status: action === 'change' ? 'changed' : 'confirmed',
    decision: { action, answer: newAnswer, reason: String(body.reason).trim(), reviewer: body.reviewer || 'Проверяющий', decided_at: new Date().toISOString(), total_before: before, total_after: final.total },
  });
});

// export: final results of a group for the active (or given) checklist
route('GET', '/api/export', async ({ query }) => {
  const g = query.get('group_id');
  const cl = await pickChecklist(query.get('checklist'));
  const ds = await store.getDataset(g);
  if (!ds) throw Object.assign(new Error('Набор не найден'), { status: 404 });
  const latest = await store.latestEvaluations(ds.records.map((r) => r.conversation_id), cl.uid);
  return ds.records.map((r) => {
    const e = latest[r.conversation_id];
    const fin = e && (e.final_result || e.result);
    return {
      conversation_id: r.conversation_id,
      checklist: cl.uid,
      total: fin ? fin.total : null,
      gross_error: fin ? fin.gross_error : null,
      criteria: fin ? fin.criteria.map((c) => ({ id: c.criterion_id, answer: c.answer, points: c.points, explanation: c.explanation, evidence: c.evidence.map((x) => ({ msg: x.msg, quote: x.quote })) })) : null,
    };
  });
});

// ---------------- call audio ----------------
// audio_url from the organizers' API is an HTML player page whose <source> holds a signed mp3 link
// that expires after about an hour. Resolve it on the server (no CORS) and stream the mp3, with
// Range support so the player can seek to a message.
const audioCache = new Map(); // audio_url -> { src, exp }
async function resolveAudio(pageUrl, force = false) {
  const hit = audioCache.get(pageUrl);
  if (!force && hit && hit.exp > Date.now()) return hit.src;
  const r = await fetch(pageUrl);
  if (!r.ok) throw Object.assign(new Error(`Страница записи: HTTP ${r.status}`), { status: 502 });
  let src = pageUrl;
  if (!(r.headers.get('content-type') || '').startsWith('audio/')) {
    const html = await r.text();
    const m = html.match(/<source[^>]*\ssrc="([^"]+)"/i) || html.match(/<audio[^>]*\ssrc="([^"]+)"/i);
    if (!m) throw Object.assign(new Error('На странице записи не найдена ссылка на аудио'), { status: 502 });
    src = m[1].replace(/&amp;/g, '&');
  } else r.body?.cancel();
  let exp = Date.now() + 10 * 60 * 1000;
  try { const se = Date.parse(new URL(src).searchParams.get('se')); if (se) exp = se - 2 * 60 * 1000; } catch {}
  audioCache.set(pageUrl, { src, exp });
  return src;
}
async function serveAudio(req, res, url) {
  const f = await store.findConversation(url.searchParams.get('id') || '', url.searchParams.get('group_id'));
  if (!f || !f.record.audio_url) return fail(res, 404, 'У диалога нет записи');
  const headers = req.headers.range ? { range: req.headers.range } : {};
  let up = await fetch(await resolveAudio(f.record.audio_url), { headers });
  if (up.status === 401 || up.status === 403) up = await fetch(await resolveAudio(f.record.audio_url, true), { headers });
  const out = { 'content-type': up.headers.get('content-type') || 'audio/mpeg', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  for (const h of ['content-length', 'content-range']) if (up.headers.get(h)) out[h] = up.headers.get(h);
  res.writeHead(up.status, out);
  if (up.body) Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
  else res.end();
}

// ---------------- static ----------------
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
function serveStatic(req, res, pathname) {
  let p = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!p.startsWith(PUBLIC)) return fail(res, 403, 'Forbidden');
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(PUBLIC, 'index.html');
  // no-cache: after an update the browser revalidates instead of running a stale app.js
  send(res, 200, fs.readFileSync(p), { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache' });
}

// Request handler shared by the local server and the Vercel function (api/index.js).
async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  try { await ensureSeeded(); } catch (e) { return fail(res, 503, 'Хранилище недоступно: ' + (e.message || e)); }
  if (req.method === 'GET' && url.pathname === '/api/audio') return serveAudio(req, res, url).catch((e) => (res.headersSent ? res.destroy() : fail(res, e.status || 502, e.message)));
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => (params[k] = m[i + 1]));
    try {
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const out = await r.handler({ params, query: url.searchParams, body, req });
      return send(res, 200, out);
    } catch (e) {
      return send(res, e.status || 500, { error: e.message || String(e), ...(e.retryAfterSec ? { retry_after: e.retryAfterSec } : {}) });
    }
  }
  fail(res, 404, 'Not found');
}
const server = http.createServer(handler);

if (require.main === module) {
  server.listen(PORT, () => {
    const c = llm.config();
    console.log(`CQA running: http://localhost:${PORT}  (LLM: ${c.provider}${c.model ? ' / ' + c.model : ''}, storage: ${store.backend})`);
  });
}
module.exports = { server, handler, recompute, validateChecklist };
