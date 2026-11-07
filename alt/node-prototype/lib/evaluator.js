'use strict';
const { indexTranscript, timingFacts, dialogFacts, normText } = require('./transcript');
const { usesChecks, applyLogic, DETECTORS, codeOnly } = require('./checks');
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
  facts.dialog = dialogFacts(msgs);
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
    verdicts = toVerdicts(r.json, checklist, msgs, facts);
    // Second opinion from a model of another family (PoLL / multilingual-judge ensembles). Where the two
    // disagree, the criterion is flagged for human review; the primary model's answer stays in the score.
    const juryModel = process.env.JURY_MODEL;
    const juryScope = (process.env.JURY_SCOPE || 'all').toUpperCase();
    if (juryModel && (juryScope === 'ALL' || juryScope.split(',').includes(String(record.language).toUpperCase()))) {
      try {
        const j = await llm.complete(prompt, { model: juryModel });
        const jv = toVerdicts(j.json, checklist, msgs, facts);
        meta.jury = { model: j.model, usage: j.usage, disagreements: [] };
        if (j.cost_usd !== null && meta.cost_usd !== null) meta.cost_usd += j.cost_usd;
        const label = (a) => ({ yes: 'да', no: 'нет', na: 'N/A' })[a] || String(a);
        for (const c of checklist.criteria) {
          const a = verdicts[c.id].answer, b = jv[c.id] && jv[c.id].answer;
          if (b === undefined || b === null || String(a) === String(b)) continue;
          meta.jury.disagreements.push(c.id);
          verdicts[c.id].needs_review = true;
          verdicts[c.id].jury_answer = b;
          verdicts[c.id].warnings = [...(verdicts[c.id].warnings || []), `Второе мнение (${j.model}) не совпало: ${label(a)} vs ${label(b)} — проверьте вручную`];
        }
      } catch (e) {
        meta.jury = { model: juryModel, error: String(e.message || e) };
      }
    }
  }

  return finish(checklist, verdicts, msgs, facts, meta, cfg, started);
}

// Model JSON -> { [criterion_id]: verdict }, with sub-question rules and evidence grounding applied.
function toVerdicts(json, checklist, msgs, facts) {
  const verdicts = {};
  {
    const raw = json.criteria;
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.entries(raw).map(([id, v]) => ({ ...v, id })) : [];
    for (const item of list) if (item && item.id) verdicts[item.id] = item;
    for (const c of checklist.criteria) {
      if (!verdicts[c.id] && codeOnly(c)) verdicts[c.id] = { explanation: '', evidence: [] }; // decided by code below
      if (!verdicts[c.id]) verdicts[c.id] = { answer: null, explanation: 'Модель не вернула оценку по критерию.', warnings: ['Нет ответа модели'] };
      const v = verdicts[c.id];
      if (usesChecks(c)) {
        v.checks = v.checks && typeof v.checks === 'object' ? v.checks : {};
        for (const q of c.checks) if (q.detector && DETECTORS[q.detector]) v.checks[q.id] = { ...DETECTORS[q.detector](msgs, facts.dialog), by_code: true };
        // The model answered the sub-questions; the criterion's answer comes from the locked rule.
        const answers = {};
        const parts = [];
        v.evidence = Array.isArray(v.evidence) ? v.evidence : [];
        const d = facts.dialog;
        const opIdx = new Set(msgs.filter((m) => m.speaker === 'operator' && !d.internal_idx.includes(m.idx)).map((m) => m.idx));
        for (const q of c.checks) {
          const a = v.checks[q.id] || {};
          answers[q.id] = String(a.answer || 'no').toLowerCase();
          // Evidence grounding: a "yes" about the operator's own action must cite a client-facing operator
          // message (for the greeting: the first one). Otherwise it is not supported by the transcript.
          if (answers[q.id] === 'yes' && q.evidence_from && Number.isInteger(a.msg)) {
            const ok = q.evidence_from === 'first_operator' ? a.msg === d.first_client_facing_operator_idx : opIdx.has(a.msg);
            if (!ok) {
              answers[q.id] = 'no';
              v.warnings = [...(v.warnings || []), `«${q.label || q.id}»: модель сослалась на [${a.msg}], это не ${q.evidence_from === 'first_operator' ? 'первая реплика оператора' : 'реплика оператора клиенту'} — засчитано «нет»`];
            }
          }
          parts.push(`${q.label || q.id} — ${answers[q.id] === 'yes' ? 'да' : 'нет'}${Number.isInteger(a.msg) ? ` [${a.msg}]` : ''}${a.by_code ? ' (проверено кодом)' : ''}`);
          if (Number.isInteger(a.msg) && msgs[a.msg] && !v.evidence.some((e) => Number(e.msg) === a.msg)) v.evidence.push({ msg: a.msg, quote: '' });
        }
        v.answer = applyLogic(c, answers);
        v.check_answers = answers;
        v.explanation = `${v.explanation || ''}${v.explanation ? ' ' : ''}Проверки: ${parts.join('; ')}.`;
      }
    }
  }

  return verdicts;
}

function finish(checklist, verdicts, msgs, facts, meta, cfg, started) {
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
