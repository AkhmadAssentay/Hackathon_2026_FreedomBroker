'use strict';
// Builds a results.json (format JSON 1.0) from per-dialog criterion values written by an evaluator
// (e.g. Claude evaluating transcripts directly), computing final_score and critical_flag in code.
//   node alt/node-prototype/scripts/build_results_from_labels.js --dataset <api_response.json> \
//        --labels-dir dir --model claude-opus-5-5 --mode external_api --out results/dev/results.json
// Records follow the dataset order; a dialog without a complete evaluation is exported as status "error".

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const datasetFile = arg('--dataset');
const labelsDir = arg('--labels-dir');
const OUT = path.resolve(arg('--out', 'results.json'));

const IDS = ['contact', 'discovery', 'identification', 'consultation', 'empathy', 'dialogue', 'closure', 'critical'];
const W = { contact: 10, discovery: 15, identification: 20, consultation: 20, empathy: 15, dialogue: 15, closure: 5 };
const MAX = { consultation: 20, dialogue: 10 };
const ALLOWED = {
  contact: [true, false], discovery: [true, false, null], identification: [true, false, null],
  consultation: [0, 5, 10, 15, 20, null], empathy: [true, false], dialogue: [0, 4, 7, 10],
  closure: [true, false, null], critical: [true, false],
};

// N/A excluded, weights redistributed among applicable criteria, maximum 100, two decimals
function finalScore(values) {
  let app = 0, got = 0;
  for (const [id, w] of Object.entries(W)) {
    const v = values[id];
    if (v === null) continue;
    app += w;
    got += MAX[id] ? (v / MAX[id]) * w : v === true ? w : 0;
  }
  return app ? Math.round(((got / app) * 100 + Number.EPSILON) * 100) / 100 : null;
}

const ds = JSON.parse(fs.readFileSync(datasetFile, 'utf8'));
const records = Array.isArray(ds) ? ds : ds.data ? ds.data.records : ds.records;
const labels = {};
for (const f of fs.readdirSync(labelsDir).filter((x) => /^batch_\d+\.json$/.test(x))) {
  for (const r of JSON.parse(fs.readFileSync(path.join(labelsDir, f), 'utf8'))) labels[r.conversation_id] = r;
}

const results = records.map((rec) => {
  const id = rec.conversation_id;
  const l = labels[id];
  const fail = (why) => ({ conversation_id: id, status: 'error', criteria: [], score: null, error: why });
  if (!l || !Array.isArray(l.criteria)) return fail('Диалог не оценён.');
  const byId = Object.fromEntries(l.criteria.map((c) => [c.criterion_id, c]));
  const criteria = [];
  for (const cid of IDS) {
    const c = byId[cid];
    if (!c) return fail(`Нет оценки по критерию ${cid}.`);
    if (!ALLOWED[cid].some((v) => v === c.value)) return fail(`Недопустимое значение ${JSON.stringify(c.value)} для ${cid}.`);
    const turns = [...new Set((c.evidence_turns || []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= rec.transcript.length))].sort((a, b) => a - b);
    criteria.push({ criterion_id: cid, value: c.value, rationale: String(c.rationale || '').replace(/\s+/g, ' ').trim(), evidence_turns: turns });
  }
  const values = Object.fromEntries(criteria.map((c) => [c.criterion_id, c.value]));
  return { conversation_id: id, status: 'ok', criteria, score: { final_score: finalScore(values), critical_flag: values.critical === true } };
});

const out = { schema_version: '1.0', team_name: arg('--team', 'Kaira'), model: { mode: arg('--mode', 'external_api'), name: arg('--model', 'claude-opus-5-5') }, results };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
const ok = results.filter((r) => r.status === 'ok').length;
console.log(`${results.length} records (${ok} ok, ${results.length - ok} error) -> ${path.relative(process.cwd(), OUT)}`);
