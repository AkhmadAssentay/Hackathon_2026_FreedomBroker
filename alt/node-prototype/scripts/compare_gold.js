'use strict';
// Compares a results.json (format JSON 1.0) with the reference labels in eval/gold_labels.json.
//   node alt/node-prototype/scripts/compare_gold.js results/dev/results.json [eval/gold_labels.json]
// Prints accuracy per criterion and language, main confusions (gold -> ours) and the mean absolute
// error of final_score against the score computed from the reference labels.

const fs = require('fs');
const path = require('path');

const resultsFile = process.argv[2];
const goldFile = process.argv[3] || path.join(__dirname, '..', '..', '..', 'eval', 'gold_labels.json');
const res = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
const gold = JSON.parse(fs.readFileSync(goldFile, 'utf8')).labels;

const IDS = ['contact', 'discovery', 'identification', 'consultation', 'empathy', 'dialogue', 'closure', 'critical'];
const W = { contact: 10, discovery: 15, identification: 20, consultation: 20, empathy: 15, dialogue: 15, closure: 5 };
const MAX = { consultation: 20, dialogue: 10 };
const label = (v) => (v === null ? 'na' : v === true ? 'yes' : v === false ? 'no' : String(v));
const toValue = (id, l) => (l === 'na' ? null : MAX[id] ? Number(l) : l === 'yes');
function finalScore(values) {
  let app = 0, got = 0;
  for (const [id, w] of Object.entries(W)) {
    const v = values[id];
    if (v === null || v === undefined) continue;
    app += w;
    got += MAX[id] ? (v / MAX[id]) * w : v === true ? w : 0;
  }
  return app ? Math.round((got / app) * 10000) / 100 : null;
}

const per = Object.fromEntries(IDS.map((id) => [id, { n: 0, ok: 0 }]));
const byLang = {};
const conf = {};
let n = 0, ok = 0, absErr = 0, scored = 0;
for (const [cid, g] of Object.entries(gold)) {
  const r = res.results.find((x) => x.conversation_id === cid);
  if (!r || r.status !== 'ok') continue;
  const lang = cid.startsWith('p4') ? 'CALL' : cid.split('-')[1].toUpperCase();
  byLang[lang] = byLang[lang] || { n: 0, ok: 0 };
  const goldValues = {};
  IDS.forEach((id, k) => {
    const gl = String(g.labels['c' + (k + 1)]).toLowerCase();
    goldValues[id] = toValue(id, gl);
    const ours = label((r.criteria.find((c) => c.criterion_id === id) || {}).value);
    per[id].n++; byLang[lang].n++; n++;
    if (gl === ours) { per[id].ok++; byLang[lang].ok++; ok++; } else conf[`${id} ${gl}→${ours}`] = (conf[`${id} ${gl}→${ours}`] || 0) + 1;
  });
  const gs = finalScore(goldValues);
  if (gs !== null && r.score) { absErr += Math.abs(gs - r.score.final_score); scored++; }
}
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '—');
console.log(`dialogs ${scored}, labels ${n}: overall ${pct(ok, n)}, final_score MAE ${(absErr / (scored || 1)).toFixed(2)}`);
for (const id of IDS) console.log(`  ${id.padEnd(15)} ${pct(per[id].ok, per[id].n)}`);
console.log('  ' + Object.entries(byLang).map(([k, v]) => `${k} ${pct(v.ok, v.n)}`).join(' | '));
console.log('  confusions (gold→ours): ' + Object.entries(conf).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}×${v}`).join(', '));
