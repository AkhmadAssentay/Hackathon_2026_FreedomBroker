'use strict';
// Exports a dataset's evaluations in the organizers' results format (JSON 1.0, CQA Student Guide appendix).
//   node alt/node-prototype/scripts/export_results.js --api https://cqa-freedom.vercel.app --group DEV --out results/dev/results.json
//   node alt/node-prototype/scripts/export_results.js --group <control group_id> --out results/prod/results.json
// One record per dialog of the dataset, in API order; a dialog that could not be evaluated is exported
// as status "error" (never hidden, never a zero score). Validate with scripts/validate_results.js.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const SITE = arg('--api', 'https://cqa-freedom.vercel.app').replace(/\/$/, '');
const GROUP = arg('--group', 'DEV');
const OUT = path.resolve(arg('--out', 'results.json'));
const TEAM = arg('--team', 'Kaira');

// checklist criterion code -> criterion_id of the results format
const CODE_TO_ID = { '01': 'contact', '02': 'discovery', '03': 'identification', '04': 'consultation', '05': 'empathy', '06': 'dialogue', '07': 'closure', '08': 'critical' };
const ORDER = Object.values(CODE_TO_ID);

async function get(p) {
  const r = await fetch(SITE + '/api' + p);
  if (!r.ok) throw new Error(`GET ${p}: HTTP ${r.status}`);
  return r.json();
}

// our answer -> value: true = Да, false = Нет, null = N/A, number = scale step (before weighting)
function toValue(row) {
  const a = row.answer;
  if (a === 'na' || a === null || a === undefined) return null;
  if (row.type === 'scale') return Number(a);
  return a === 'yes';
}

function toRecord(conversationId, ev) {
  if (!ev || ev.status === 'error' || !(ev.final_result || ev.result)) {
    return { conversation_id: conversationId, status: 'error', criteria: [], score: null, error: (ev && ev.error) || 'Диалог не оценён.' };
  }
  const fin = ev.final_result || ev.result;
  const criteria = [];
  for (const row of fin.criteria) {
    const id = CODE_TO_ID[row.code];
    if (!id) continue;
    criteria.push({
      criterion_id: id,
      value: toValue(row),
      rationale: String(row.explanation || '').replace(/\s+/g, ' ').trim(),
      // 1-based numbers over the original transcript array (client, bot, system and operator)
      evidence_turns: [...new Set((row.evidence || []).map((e) => Number(e.msg) + 1).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b),
    });
  }
  criteria.sort((a, b) => ORDER.indexOf(a.criterion_id) - ORDER.indexOf(b.criterion_id));
  const critical = criteria.find((c) => c.criterion_id === 'critical');
  if (criteria.length !== 8) {
    return { conversation_id: conversationId, status: 'error', criteria: [], score: null, error: `Оценка содержит ${criteria.length} из 8 критериев.` };
  }
  return {
    conversation_id: conversationId,
    status: 'ok',
    criteria,
    score: { final_score: fin.total, critical_flag: critical ? critical.value === true : false },
  };
}

async function main() {
  const list = await get('/conversations?group_id=' + encodeURIComponent(GROUP));
  const results = [];
  const models = new Set();
  for (const item of list.items) {
    let ev = null;
    if (item.evaluation_id) {
      ev = await get('/evaluations/' + item.evaluation_id);
      if (ev.meta && ev.meta.model && ev.status !== 'error') models.add(ev.meta.model);
    }
    results.push(toRecord(item.conversation_id, ev));
  }
  const config = await get('/config');
  const local = config.provider === 'rules' || /localhost|127\.0\.0\.1/.test(SITE);
  const out = {
    schema_version: '1.0',
    team_name: TEAM,
    model: { mode: config.provider === 'rules' ? 'local' : local ? 'local' : 'external_api', name: [...models].join(', ') || config.model },
    results,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  const ok = results.filter((r) => r.status === 'ok').length;
  console.log(`${GROUP}: ${results.length} records (${ok} ok, ${results.length - ok} error) -> ${path.relative(process.cwd(), OUT)}; model: ${out.model.mode} / ${out.model.name}`);
}

main().catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });
