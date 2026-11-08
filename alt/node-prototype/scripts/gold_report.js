'use strict';
// Compares the model's evaluations with human labels from gold/gold_labels.csv.
// Usage: npm run gold  [-- --checklist freedom-default@v2]
// Env: GOLD_FILE (default gold/gold_labels.csv), DATA_DIR (default data/).
// Uses the model's ORIGINAL answers (before appeals), from the latest evaluation of each dialog.

const fs = require('fs');
const path = require('path');
const { score } = require('../lib/scoring');

const ROOT = path.join(__dirname, '..');
const GOLD_FILE = process.env.GOLD_FILE || path.join(ROOT, 'gold', 'gold_labels.csv');
const DB_FILE = path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'db.json');


const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const argUid = arg('--checklist');
// --split dev|test: tune on dev, report the honest number on test (gold/splits.json).
const argSplit = arg('--split');

function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const sep = lines[0].includes(';') ? ';' : ',';
  const head = lines[0].split(sep).map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const cells = l.split(sep);
    return Object.fromEntries(head.map((h, i) => [h, (cells[i] || '').trim()]));
  });
}

// Human label -> canonical value ('yes' | 'no' | 'na' | number), or null if empty / unknown.
function canon(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (['yes', 'y', 'да', 'д', 'true', '1+'].includes(s)) return 'yes';
  if (['no', 'n', 'нет', 'н', 'false'].includes(s)) return 'no';
  if (['na', 'n/a', 'н/п', 'н/a', 'нп', '-'].includes(s)) return 'na';
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
const modelCanon = (a) => (a === null || a === undefined ? null : typeof a === 'number' ? a : canon(a));

function kappa(pairs) {
  if (!pairs.length) return null;
  const cats = [...new Set(pairs.flat().map(String))];
  const n = pairs.length;
  const po = pairs.filter(([a, b]) => String(a) === String(b)).length / n;
  let pe = 0;
  for (const c of cats) pe += (pairs.filter(([a]) => String(a) === c).length / n) * (pairs.filter(([, b]) => String(b) === c).length / n);
  return pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe);
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const r2 = (x) => (x === null || x === undefined ? '—' : (Math.round(x * 100) / 100).toString());

// --api <site>: read checklists and the latest evaluations from a running app (e.g. the online
// Vercel + MongoDB deployment) instead of the local data/db.json.
async function loadFromApi(site, group) {
  const base = site.replace(/\/$/, '') + '/api';
  const get = async (p) => { const r = await fetch(base + p); if (!r.ok) throw new Error(`GET ${p}: HTTP ${r.status}`); return r.json(); };
  const cls = await get('/checklists');
  const checklists = [];
  for (const c of cls.items) checklists.push(await get('/checklists/' + encodeURIComponent(c.uid)));
  const uid = argUid || cls.active;
  const list = await get(`/conversations?group_id=${encodeURIComponent(group)}&checklist=${encodeURIComponent(uid)}`);
  const evaluations = [];
  for (const i of list.items) if (i.evaluation_id) evaluations.push(await get('/evaluations/' + i.evaluation_id));
  return { checklists, evaluations, active_checklist: cls.active };
}

async function main() {
  const apiSite = arg('--api');
  let db;
  if (apiSite) db = await loadFromApi(apiSite, arg('--group') || 'DEV');
  else {
    if (!fs.existsSync(DB_FILE)) throw new Error(`Нет базы ${DB_FILE}: сначала запустите приложение и оцените диалоги`);
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  }
  const uid = argUid || db.active_checklist;
  const checklist = db.checklists.find((c) => c.uid === uid);
  if (!checklist) throw new Error(`Чек-лист ${uid} не найден`);

  let gold = readCsv(GOLD_FILE).filter((row) => checklist.criteria.some((c) => canon(row[c.id]) !== null));
  if (argSplit) {
    const splits = JSON.parse(fs.readFileSync(path.join(ROOT, 'gold', 'splits.json'), 'utf8'));
    if (!splits[argSplit]) throw new Error(`Нет выборки ${argSplit} в gold/splits.json`);
    gold = gold.filter((row) => splits[argSplit].includes(row.conversation_id));
  }
  const OUT_FILE = path.join(path.dirname(GOLD_FILE), `report${argSplit ? '_' + argSplit : ''}${argUid ? '_' + argUid.replace(/[^\w.-]/g, '_') : ''}.md`);
  const latest = {};
  for (const e of db.evaluations) {
    if (e.checklist_uid !== uid || e.status === 'error' || !e.result) continue;
    latest[e.conversation_id] = e; // evaluations are stored in time order
  }

  const per = Object.fromEntries(checklist.criteria.map((c) => [c.id, { c, n: 0, agree: 0, falseNo: 0, falseYes: 0, naErr: 0, low: 0, high: 0, absDiff: 0, pairs: [], misses: [] }]));
  const byLang = {};
  const totals = [];
  const missing = [];

  for (const row of gold) {
    const ev = latest[row.conversation_id];
    if (!ev) { missing.push(row.conversation_id); continue; }
    const lang = row.language || '?';
    byLang[lang] = byLang[lang] || { n: 0, agree: 0 };
    const goldVerdicts = {};
    for (const c of checklist.criteria) {
      const g = canon(row[c.id]);
      if (g === null) continue;
      goldVerdicts[c.id] = { answer: g };
      const mRow = ev.result.criteria.find((x) => x.criterion_id === c.id);
      const m = modelCanon(mRow ? mRow.answer : null);
      const s = per[c.id];
      s.n++; byLang[lang].n++;
      s.pairs.push([g, m]);
      if (String(g) === String(m)) { s.agree++; byLang[lang].agree++; continue; }
      s.misses.push(`${row.conversation_id}: человек ${g}, модель ${m}`);
      if (g === 'na' || m === 'na') s.naErr++;
      else if (c.type === 'scale') { if (m < g) s.low++; else s.high++; }
      else if (g === 'yes' && m === 'no') s.falseNo++;
      else if (g === 'no' && m === 'yes') s.falseYes++;
    }
    for (const c of checklist.criteria) {
      const s = per[c.id];
      const g = canon(row[c.id]);
      const m = modelCanon((ev.result.criteria.find((x) => x.criterion_id === c.id) || {}).answer);
      if (c.type === 'scale' && typeof g === 'number' && typeof m === 'number') s.absDiff += Math.abs(g - m);
    }
    if (checklist.criteria.every((c) => goldVerdicts[c.id])) {
      const gt = score(checklist, goldVerdicts).total;
      totals.push({ id: row.conversation_id, gold: gt, model: ev.result.total });
    }
  }

  const L = [];
  L.push(`# Сравнение с эталонной разметкой`, '');
  L.push(`${argSplit ? `Выборка: **${argSplit}**. ` : ''}Чек-лист: \`${uid}\`. Модель: \`${(Object.values(latest)[0] || {}).meta?.model || '?'}\`. Размечено диалогов: ${gold.length}, из них оценено моделью: ${gold.length - missing.length}.`);
  if (missing.length) L.push('', `Не оценены моделью (оцените их в приложении): ${missing.join(', ')}`);
  L.push('', '## По критериям', '');
  L.push('| Критерий | n | Совпадение | Каппа | Ложное «Нет» | Ложное «Да» | Ошибки N/A | Шкала: ниже / выше человека |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const s of Object.values(per)) {
    if (!s.n) continue;
    const flag = s.c.type === 'flag';
    const k = kappa(s.pairs);
    L.push(`| ${s.c.code || s.c.id} ${s.c.name} | ${s.n} | ${pct(s.agree, s.n)} | ${k === null ? '—' : r2(k)} | ${s.c.type === 'scale' ? '—' : flag ? `пропуск: ${s.falseNo}` : s.falseNo} | ${s.c.type === 'scale' ? '—' : flag ? `ложная тревога: ${s.falseYes}` : s.falseYes} | ${s.naErr} | ${s.c.type === 'scale' ? `${s.low} / ${s.high}` : '—'} |`);
  }
  L.push('', '«Ложное «Нет»» — модель сняла баллы там, где человек поставил «Да» (несправедливо к оператору). «Ложное «Да»» — модель пропустила проблему. Для критерия 08 «Да» означает найденное нарушение.');
  L.push('', '## По языкам', '', '| Язык | Ответов | Совпадение |', '|---|---|---|');
  for (const [lang, v] of Object.entries(byLang)) L.push(`| ${lang} | ${v.n} | ${pct(v.agree, v.n)} |`);
  if (totals.length) {
    const mae = totals.reduce((a, t) => a + Math.abs((t.gold ?? 0) - (t.model ?? 0)), 0) / totals.length;
    L.push('', '## Итоговый балл', '', `Средняя разница итога «модель − человек» по модулю: **${r2(mae)}** балла (на ${totals.length} полностью размеченных диалогах).`, '');
    L.push('| Диалог | Человек | Модель |', '|---|---|---|');
    for (const t of totals) L.push(`| ${t.id} | ${r2(t.gold)} | ${r2(t.model)} |`);
  }
  L.push('', '## Расхождения', '');
  for (const s of Object.values(per)) if (s.misses.length) L.push(`**${s.c.code || s.c.id} ${s.c.name}**`, ...s.misses.map((m) => `- ${m}`), '');

  const md = L.join('\n') + '\n';
  fs.writeFileSync(OUT_FILE, md);
  console.log(md);
  console.log(`Сохранено: ${path.relative(ROOT, OUT_FILE)}`);
}

main().catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });
