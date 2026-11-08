'use strict';
// Checks a results.json against the organizers' format (JSON 1.0, CQA Student Guide appendix).
//   node alt/node-prototype/scripts/validate_results.js results/dev/results.json [--expect 65] [--dataset path/to/api_response.json]
// --expect N: exact number of records (prod: 10). --dataset: the organizers' API response, to check that
// IDs match exactly and that evidence_turns point inside each transcript.

const fs = require('fs');

const args = process.argv.slice(2);
const file = args[0];
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const expect = arg('--expect') ? Number(arg('--expect')) : null;
const datasetFile = arg('--dataset');

const SPEC = {
  contact: { values: [true, false], weight: 10 },
  discovery: { values: [true, false, null], weight: 15 },
  identification: { values: [true, false, null], weight: 20 },
  consultation: { values: [0, 5, 10, 15, 20, null], weight: 20, max: 20 },
  empathy: { values: [true, false], weight: 15 },
  dialogue: { values: [0, 4, 7, 10], weight: 15, max: 10 },
  closure: { values: [true, false, null], weight: 5 },
  critical: { values: [true, false], weight: 0 },
};

const errors = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

const raw = fs.readFileSync(file);
if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) err('file', 'UTF-8 BOM в начале файла');
let doc;
try { doc = JSON.parse(raw.toString('utf8')); } catch (e) { console.error('Невалидный JSON:', e.message); process.exit(1); }

if (doc.schema_version !== '1.0') err('root', 'schema_version должен быть "1.0"');
if (typeof doc.team_name !== 'string' || !doc.team_name.trim()) err('root', 'нет team_name');
if (!doc.model || !['local', 'external_api', 'hybrid'].includes(doc.model.mode)) err('root', 'model.mode: local | external_api | hybrid');
if (!doc.model || typeof doc.model.name !== 'string' || !doc.model.name.trim()) err('root', 'нет model.name');
if (!Array.isArray(doc.results)) { err('root', 'results должен быть массивом'); }

let dataset = null;
if (datasetFile) {
  const d = JSON.parse(fs.readFileSync(datasetFile, 'utf8'));
  const records = Array.isArray(d) ? d : d.data ? d.data.records : d.records;
  dataset = Object.fromEntries(records.map((r) => [r.conversation_id, r]));
}

const seen = new Set();
for (const [i, r] of (doc.results || []).entries()) {
  const at = `results[${i}] ${r.conversation_id || '?'}`;
  if (typeof r.conversation_id !== 'string' || !r.conversation_id) err(at, 'нет conversation_id');
  if (seen.has(r.conversation_id)) err(at, 'повторяющийся conversation_id');
  seen.add(r.conversation_id);
  if (dataset && !dataset[r.conversation_id]) err(at, 'ID нет в наборе API');
  if (r.status === 'error') {
    if (!Array.isArray(r.criteria) || r.criteria.length) err(at, 'у ошибки criteria должен быть пустым массивом');
    if (r.score !== null) err(at, 'у ошибки score должен быть null');
    if (typeof r.error !== 'string' || !r.error) err(at, 'у ошибки нужна причина в error');
    continue;
  }
  if (r.status !== 'ok') { err(at, `status должен быть "ok" или "error", а не ${JSON.stringify(r.status)}`); continue; }
  if (!Array.isArray(r.criteria) || r.criteria.length !== 8) err(at, 'нужно ровно 8 критериев');
  const byId = {};
  for (const c of r.criteria || []) {
    const cat = `${at} ${c.criterion_id}`;
    if (!SPEC[c.criterion_id]) { err(cat, 'неизвестный criterion_id'); continue; }
    if (byId[c.criterion_id]) err(cat, 'критерий повторяется');
    byId[c.criterion_id] = c;
    if (!SPEC[c.criterion_id].values.some((v) => v === c.value)) err(cat, `недопустимое value ${JSON.stringify(c.value)}`);
    if (typeof c.rationale !== 'string' || !c.rationale.trim()) err(cat, 'пустой rationale');
    if (!Array.isArray(c.evidence_turns) || c.evidence_turns.some((n) => !Number.isInteger(n) || n < 1)) err(cat, 'evidence_turns: целые числа с 1');
    else if (dataset && dataset[r.conversation_id]) {
      const len = dataset[r.conversation_id].transcript.length;
      for (const n of c.evidence_turns) if (n > len) err(cat, `реплики ${n} нет (в транскрипте ${len})`);
    }
  }
  for (const id of Object.keys(SPEC)) if (!byId[id]) err(at, `нет критерия ${id}`);
  if (!r.score || typeof r.score !== 'object') { err(at, 'нет score'); continue; }
  // final_score recomputed from the values: N/A excluded, weights redistributed, max 100, 2 decimals
  let applicable = 0, got = 0;
  for (const [id, s] of Object.entries(SPEC)) {
    const c = byId[id];
    if (!c || !s.weight || c.value === null) continue;
    applicable += s.weight;
    got += s.max ? (c.value / s.max) * s.weight : c.value === true ? s.weight : 0;
  }
  const expected = applicable ? round2((got / applicable) * 100) : null;
  if (typeof r.score.final_score !== 'number' && expected !== null) err(at, 'final_score должен быть числом');
  else if (expected !== null && Math.abs(r.score.final_score - expected) > 0.011) err(at, `final_score ${r.score.final_score}, по значениям выходит ${expected}`);
  if (typeof r.score.final_score === 'number' && (r.score.final_score < 0 || r.score.final_score > 100 || round2(r.score.final_score) !== r.score.final_score)) err(at, 'final_score: от 0 до 100, два знака');
  if (byId.critical && r.score.critical_flag !== byId.critical.value) err(at, 'critical_flag должен совпадать с value критерия critical');
}
if (expect !== null && (doc.results || []).length !== expect) err('results', `ожидалось ${expect} записей, есть ${(doc.results || []).length}`);
if (dataset) for (const id of Object.keys(dataset)) if (!seen.has(id)) err('results', `нет записи для ${id}`);

const n = (doc.results || []).length;
const ok = (doc.results || []).filter((r) => r.status === 'ok').length;
if (errors.length) {
  console.log(`НЕ ПРОЙДЕНО: ${errors.length} ошибок (${n} записей)`);
  for (const e of errors.slice(0, 40)) console.log(' -', e);
  process.exit(1);
}
console.log(`OK: ${n} записей (${ok} ok, ${n - ok} error), формат JSON 1.0 соблюдён`);
