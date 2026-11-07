// Deterministic scoring per the checklist PDF rules.
// The LLM only returns verdicts (yes / no / na / scale step); all arithmetic lives here.
//
// 1. Applicability: N/A only where allowed.
// 2. "Yes" = full weight, "No" = 0; scale -> chosen step.
// 3. Scale converted proportionally to weight (top step = full weight).
// 4. N/A criteria excluded, their weight redistributed proportionally (max stays 100).
// 5. Round total to `rounding` digits. No applicable weighted criteria -> total = null.
//    Gross errors (flag type) are reported separately, without points.

'use strict';

function round(x, digits) {
  const m = Math.pow(10, digits);
  return Math.round((x + Number.EPSILON) * m) / m;
}

function scaleMax(criterion) {
  const vals = (criterion.scale || []).map((s) => Number(s.value));
  return vals.length ? Math.max(...vals) : 0;
}

// Normalise a raw verdict to one allowed by the criterion type. Returns {answer, warning}.
function normalizeAnswer(criterion, raw) {
  let a = raw;
  if (typeof a === 'string') a = a.trim().toLowerCase();
  if (a === 'n/a' || a === 'н/п' || a === 'na' || a === null || a === undefined) a = 'na';
  if (a === 'да' || a === 'true' || a === true) a = 'yes';
  if (a === 'нет' || a === 'false' || a === false) a = 'no';

  if (a === 'na') {
    if (criterion.na_allowed) return { answer: 'na' };
    // Model said N/A where it isn't allowed: binary -> no, scale -> lowest, flag -> no.
    if (criterion.type === 'scale') {
      const min = Math.min(...criterion.scale.map((s) => Number(s.value)));
      return { answer: min, warning: 'N/A не разрешён для критерия — выставлена нижняя ступень' };
    }
    return { answer: 'no', warning: 'N/A не разрешён для критерия — выставлено «Нет»' };
  }

  if (criterion.type === 'scale') {
    const n = Number(a);
    const steps = criterion.scale.map((s) => Number(s.value));
    if (Number.isNaN(n)) {
      return { answer: Math.min(...steps), warning: `Некорректный балл «${raw}» — выставлена нижняя ступень` };
    }
    if (steps.includes(n)) return { answer: n };
    // Snap to the nearest step (ties -> lower, conservative).
    let best = steps[0];
    for (const s of steps) {
      if (Math.abs(s - n) < Math.abs(best - n) || (Math.abs(s - n) === Math.abs(best - n) && s < best)) best = s;
    }
    return { answer: best, warning: `Балл ${n} не является ступенью шкалы — округлён до ${best}` };
  }

  if (a === 'yes' || a === 'no') return { answer: a };
  return { answer: 'no', warning: `Некорректный ответ «${raw}» — выставлено «Нет»` };
}

// Fraction of the criterion's weight earned (0..1), or null for N/A / flags.
function fraction(criterion, answer) {
  if (answer === 'na') return null;
  if (criterion.type === 'flag') return null;
  if (criterion.type === 'scale') {
    const max = scaleMax(criterion);
    return max > 0 ? Number(answer) / max : 0;
  }
  return answer === 'yes' ? 1 : 0;
}

/**
 * @param {object} checklist  checklist config
 * @param {object} verdicts   { [criterion_id]: { answer, explanation, evidence, checked_range, ... } }
 * @returns {object} full scored result
 */
function score(checklist, verdicts) {
  const digits = checklist.settings && Number.isInteger(checklist.settings.rounding) ? checklist.settings.rounding : 2;
  const rows = [];
  for (const c of checklist.criteria) {
    const v = verdicts[c.id] || {};
    const norm = normalizeAnswer(c, v.answer);
    const frac = fraction(c, norm.answer);
    rows.push({
      criterion_id: c.id,
      code: c.code,
      name: c.name,
      section: c.section || null,
      type: c.type,
      base_weight: c.type === 'flag' ? 0 : Number(c.weight) || 0,
      answer: norm.answer,
      applicable: frac !== null,
      fraction: frac,
      explanation: v.explanation || '',
      evidence: Array.isArray(v.evidence) ? v.evidence : [],
      checked_range: v.checked_range || null,
      warnings: [...(v.warnings || []), ...(norm.warning ? [norm.warning] : [])],
      overridden: !!v.overridden,
      needs_review: !!v.needs_review,
      jury_answer: v.jury_answer ?? null,
      check_answers: v.check_answers || null,
    });
  }

  const weighted = rows.filter((r) => r.type !== 'flag' && r.base_weight > 0);
  const applicableWeight = weighted.filter((r) => r.applicable).reduce((s, r) => s + r.base_weight, 0);
  const maxBase = weighted.reduce((s, r) => s + r.base_weight, 0);

  let total = null;
  if (applicableWeight > 0) {
    let sum = 0;
    for (const r of rows) {
      if (r.type === 'flag' || r.base_weight <= 0) {
        r.effective_weight = 0;
        r.points = null;
        continue;
      }
      if (!r.applicable) {
        r.effective_weight = 0;
        r.points = null;
        continue;
      }
      // Redistribute N/A weight proportionally so the maximum stays 100.
      r.effective_weight = (r.base_weight / applicableWeight) * 100;
      r.points_raw = r.fraction * r.effective_weight;
      r.points = round(r.points_raw, digits);
      sum += r.points_raw;
    }
    total = round(sum, digits);
  } else {
    for (const r of rows) {
      r.effective_weight = 0;
      r.points = null;
    }
  }
  for (const r of rows) {
    if (r.effective_weight) r.effective_weight = round(r.effective_weight, digits);
    // Points before redistribution, for transparency ("из N по весу").
    r.base_points = r.applicable && r.type !== 'flag' ? round(r.fraction * r.base_weight, digits) : null;
    delete r.points_raw;
  }

  // Section results: share of achievable points in the section, in % and in redistributed points.
  const sections = (checklist.sections || []).map((s) => {
    const inSec = rows.filter((r) => r.section === s.id && r.type !== 'flag' && r.base_weight > 0);
    const app = inSec.filter((r) => r.applicable);
    const appW = app.reduce((a, r) => a + r.base_weight, 0);
    const got = app.reduce((a, r) => a + r.fraction * r.base_weight, 0);
    const flags = rows.filter((r) => r.section === s.id && r.type === 'flag');
    return {
      id: s.id,
      name: s.name,
      has_weight: inSec.length > 0,
      percent: appW > 0 ? round((got / appW) * 100, digits) : null,
      points: total === null || appW === 0 ? null : round(app.reduce((a, r) => a + r.fraction * r.effective_weight, 0), digits),
      max_points: total === null || appW === 0 ? null : round(app.reduce((a, r) => a + r.effective_weight, 0), digits),
      flag_raised: flags.some((f) => f.answer === 'yes'),
    };
  });

  const grossRows = rows.filter((r) => r.type === 'flag' && r.answer === 'yes');
  return {
    total,
    max_total: total === null ? null : 100,
    base_max: maxBase,
    applicable_base_weight: applicableWeight,
    gross_error: grossRows.length > 0,
    gross_error_criteria: grossRows.map((r) => r.criterion_id),
    sections,
    criteria: rows,
  };
}

module.exports = { score, normalizeAnswer, round, scaleMax };
