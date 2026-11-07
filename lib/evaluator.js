'use strict';
const { indexTranscript, timingFacts, normText } = require('./transcript');
const { buildPrompt } = require('./prompt');
const llm = require('./llm');
const { score } = require('./scoring');
const { grossSignals, heuristicVerdicts } = require('./rules');

// Check that every evidence quote really exists in the transcript; fix the index if the quote
// is found in another message, otherwise mark it as unverified.
function verifyEvidence(evidence, msgs) {
  const out = [];
  for (const e of evidence || []) {
    let msg = Number.isInteger(e.msg) ? e.msg : parseInt(e.msg, 10);
    const quote = String(e.quote || '').trim();
    const nq = normText(quote);
    let verified = false;
    if (msgs[msg] && nq && normText(msgs[msg].text).includes(nq)) verified = true;
    else if (nq) {
      const found = msgs.find((m) => normText(m.text).includes(nq));
      if (found) {
        msg = found.idx;
        verified = true;
      } else if (msgs[msg]) {
        // Fuzzy: >= 60% of quote words present in the referenced message.
        const words = nq.split(' ').filter((w) => w.length > 2);
        const t = normText(msgs[msg].text);
        const hit = words.filter((w) => t.includes(w)).length;
        verified = words.length > 0 && hit / words.length >= 0.6;
      }
    } else if (msgs[msg]) verified = true; // only index given
    if (!msgs[msg]) continue;
    out.push({ msg, quote: quote || msgs[msg].text.slice(0, 160), verified, timestamp: msgs[msg].timestamp, offset_sec: msgs[msg].offset_sec, speaker: msgs[msg].speaker });
  }
  return out;
}

function sanitizeRange(r, n) {
  if (!Array.isArray(r) || r.length !== 2) return null;
  let [a, b] = r.map((x) => parseInt(x, 10));
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  a = Math.max(0, Math.min(n - 1, a));
  b = Math.max(0, Math.min(n - 1, b));
  return a <= b ? [a, b] : [b, a];
}

async function evaluate(record, checklist) {
  const msgs = indexTranscript(record);
  const threshold = (checklist.settings && checklist.settings.first_response_threshold_sec) || 180;
  const facts = timingFacts(msgs, threshold);
  const cfg = llm.config();
  const started = Date.now();

  let verdicts = {};
  let meta = { provider: cfg.provider, model: cfg.model, usage: null, cost_usd: null };

  if (cfg.provider === 'rules') {
    verdicts = heuristicVerdicts(checklist, record, msgs, facts);
  } else {
    const prompt = buildPrompt({ checklist, record, msgs, facts });
    const r = await llm.complete(prompt);
    meta = { provider: r.provider, model: r.model, usage: r.usage, cost_usd: r.cost_usd };
    const raw = r.json.criteria;
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.entries(raw).map(([id, v]) => ({ ...v, id })) : [];
    for (const item of list) if (item && item.id) verdicts[item.id] = item;
    for (const c of checklist.criteria) {
      if (!verdicts[c.id]) verdicts[c.id] = { answer: null, explanation: 'Модель не вернула оценку по критерию.', warnings: ['Нет ответа модели'] };
    }
  }

  // Post-process: verify evidence, sanitize ranges, add deterministic cross-checks.
  const gross = grossSignals(msgs);
  for (const c of checklist.criteria) {
    const v = verdicts[c.id];
    v.warnings = v.warnings || [];
    v.evidence = verifyEvidence(v.evidence, msgs);
    v.checked_range = sanitizeRange(v.checked_range, msgs.length);
    if (v.evidence.some((e) => !e.verified)) v.warnings.push('Часть цитат не найдена в транскрипте дословно — проверьте вручную');
    if (c.type === 'flag' && gross.length && String(v.answer).toLowerCase() !== 'yes' && cfg.provider !== 'rules') {
      v.warnings.push('Правила нашли подозрительные реплики: ' + gross.map((g) => `[${g.msg}] ${g.why}`).join('; '));
    }
  }

  const result = score(checklist, verdicts);
  return {
    result,
    facts,
    meta: { ...meta, duration_ms: Date.now() - started },
  };
}

module.exports = { evaluate, verifyEvidence };
