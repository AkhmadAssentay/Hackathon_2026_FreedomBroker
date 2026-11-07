'use strict';
// Exports evaluated results of a dataset to one JSON file for the repository.
//   node scripts/export_results.js --api https://cqa-freedom.vercel.app --group DEV --out ../../results/dev/results.json
// Main results come from a running app (--api: the online Vercel + MongoDB deployment, or a local server).
// If data/db.json exists, the local evaluations of the same dialogs are added for comparison
// (--local-checklist picks the local checklist version; default: the latest one with results).
// Call recording links are never exported.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const SITE = arg('--api', 'https://cqa-freedom.vercel.app').replace(/\/$/, '');
const GROUP = arg('--group', 'DEV');
const OUT = path.resolve(arg('--out', path.join(__dirname, '..', '..', '..', 'results', GROUP.toLowerCase(), 'results.json')));
const LOCAL_DB = path.join(__dirname, '..', 'data', 'db.json');

const round2 = (x) => (x === null || x === undefined ? null : Math.round(x * 100) / 100);
async function get(p) {
  const r = await fetch(SITE + '/api' + p);
  if (!r.ok) throw new Error(`GET ${p}: HTTP ${r.status}`);
  return r.json();
}

function criteriaOf(ev) {
  const ai = ev.result ? ev.result.criteria : [];
  const fin = (ev.final_result || ev.result || {}).criteria || [];
  return ai.map((c) => {
    const f = fin.find((x) => x.criterion_id === c.criterion_id) || c;
    return {
      id: c.criterion_id,
      code: c.code,
      name: c.name,
      type: c.type,
      answer_ai: c.answer,
      answer_final: f.answer,
      changed_on_appeal: String(f.answer) !== String(c.answer),
      points_final: f.points,
      effective_weight: f.effective_weight,
      explanation: c.explanation,
      evidence: (c.evidence || []).map((e) => ({ msg: e.msg, speaker: e.speaker, timestamp: e.timestamp, quote: e.quote, verified: e.verified })),
      checked_range: c.checked_range || null,
      sub_questions: c.check_answers || undefined,
      needs_review: c.needs_review || undefined,
      warnings: c.warnings && c.warnings.length ? c.warnings : undefined,
    };
  });
}

function localResults(ids) {
  if (!fs.existsSync(LOCAL_DB)) return { checklist: null, byId: {} };
  const db = JSON.parse(fs.readFileSync(LOCAL_DB, 'utf8'));
  const evs = db.evaluations.filter((e) => e.group_id === GROUP && e.result && e.status !== 'error' && ids.has(e.conversation_id));
  const uid = arg('--local-checklist') || (evs.length ? evs[evs.length - 1].checklist_uid : null);
  const byId = {};
  for (const e of evs) if (e.checklist_uid === uid) byId[e.conversation_id] = e; // latest wins
  return { checklist: uid, byId };
}

async function main() {
  const config = await get('/config');
  const list = await get('/conversations?group_id=' + encodeURIComponent(GROUP));
  const ids = new Set(list.items.map((i) => i.conversation_id));
  const local = localResults(ids);
  const dialogs = [];
  const models = {};
  let cost = 0;
  for (const item of list.items) {
    const d = { conversation_id: item.conversation_id, channel: item.channel, language: item.language, messages: item.messages };
    if (item.evaluation_id) {
      const ev = await get('/evaluations/' + item.evaluation_id);
      const fin = ev.final_result || ev.result;
      const m = (ev.meta && ev.meta.model) || null;
      if (m) models[m] = (models[m] || 0) + 1;
      if (ev.meta && ev.meta.cost_usd) cost += ev.meta.cost_usd;
      d.result = {
        source: 'online',
        evaluation_id: ev.id,
        evaluated_at: ev.created_at,
        checklist: ev.checklist_uid,
        model: m,
        fallback_from: (ev.meta && ev.meta.fallback_from) || undefined,
        tokens: ev.meta && ev.meta.usage ? { input: ev.meta.usage.input, output: ev.meta.usage.output } : undefined,
        cost_usd: ev.meta ? round2((ev.meta.cost_usd || 0) * 1e4) / 1e4 : null,
        status: ev.status,
        total_ai: ev.result ? ev.result.total : null,
        total_final: fin ? fin.total : null,
        gross_error: fin ? fin.gross_error : null,
        sections: fin ? fin.sections : undefined,
        criteria: criteriaOf(ev),
        appeals: (ev.appeals || []).map((a) => ({ criterion: a.criterion_id, status: a.status, comment: a.comment, requested: a.requested_answer, decision: a.decision || null })),
      };
    } else d.result = null;
    const le = local.byId[item.conversation_id];
    if (le) {
      d.local_comparison = {
        source: 'local',
        model: (le.meta && le.meta.model) || null,
        checklist: le.checklist_uid,
        total: le.result.total,
        gross_error: le.result.gross_error,
        answers: Object.fromEntries(le.result.criteria.map((c) => [c.criterion_id, c.answer])),
      };
    }
    dialogs.push(d);
  }

  const done = dialogs.filter((d) => d.result && d.result.total_final !== null);
  const avg = (arr) => (arr.length ? round2(arr.reduce((s, x) => s + x, 0) / arr.length) : null);
  const by = (key) => Object.fromEntries([...new Set(done.map((d) => d[key]))].map((k) => [k, { dialogs: done.filter((d) => d[key] === k).length, avg_total: avg(done.filter((d) => d[key] === k).map((d) => d.result.total_final)) }]));
  const out = {
    dataset: GROUP,
    generated_at: new Date().toISOString(),
    source: { site: SITE, storage: config.storage, provider: config.provider, primary_model: config.model, checklist: list.checklist_uid },
    notes: [
      'result: evaluation from the online app (Vercel + MongoDB). total_ai is the model\'s score, total_final includes reviewers\' appeal decisions.',
      'local_comparison: the same dialog evaluated locally (Qwen 2.5 7B via Ollama), answers only.',
      'Evidence "msg" numbers refer to the dialog\'s transcript lines (0-based). Call recording links are not exported.',
    ],
    summary: {
      dialogs: dialogs.length,
      evaluated: done.length,
      avg_total_final: avg(done.map((d) => d.result.total_final)),
      avg_total_ai: avg(done.map((d) => d.result.total_ai)),
      gross_error_dialogs: done.filter((d) => d.result.gross_error).map((d) => d.conversation_id),
      changed_by_appeals: done.filter((d) => d.result.total_final !== d.result.total_ai).map((d) => d.conversation_id),
      by_language: by('language'),
      by_channel: by('channel'),
      models_used: models,
      total_cost_usd: round2(cost * 1e4) / 1e4,
      local_comparison: local.checklist ? { checklist: local.checklist, dialogs: Object.keys(local.byId).length, avg_total: avg(Object.values(local.byId).map((e) => e.result.total)) } : null,
    },
    dialogs,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`${GROUP}: ${done.length}/${dialogs.length} evaluated -> ${path.relative(process.cwd(), OUT)} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
  console.log(JSON.stringify({ ...out.summary, by_language: undefined, by_channel: undefined }, null, 1));
}

main().catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });
