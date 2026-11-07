'use strict';
// Checklist decomposition: a criterion may carry simple yes/no sub-questions ("checks") and a fixed
// rule ("logic") that turns their answers into the criterion's answer. The model answers only the
// sub-questions; the verdict is computed here, deterministically.
//
// Why: small models answer one narrow question far more reliably than a whole multi-part criterion
// (CheckEval, TICK), and a locked rule keeps the verdict traceable to the rubric (RULERS).
//
// Checks are bound to the criterion's wording through `checks_signature`. If someone edits the name,
// type or description in the UI (e.g. replaces the criterion), the signature no longer matches and the
// criterion is evaluated directly from its new wording, so stale sub-questions never apply.
//
// logic fields (all optional, each a list of check ids):
//   no_if_any   -> "no" if any of these is "yes"            (checked first)
//   na_unless   -> "na" if any of these is "no"             (only when N/A is allowed)
//   na_if_any   -> "na" if any of these is "yes"            (only when N/A is allowed)
//   yes_if_all  -> required "yes" answers for "yes"
//   yes_if_any  -> at least one must be "yes" for "yes"
//   default     -> answer when no rule fires ("yes" or "no"; default "no")
// For flag criteria "yes" means the violation is present.

function signature(c) {
  return [c.name, c.type, String(c.description || '').trim()].join('|');
}

function usesChecks(c) {
  return c.type !== 'scale' && Array.isArray(c.checks) && c.checks.length > 0 && c.checks_signature === signature(c);
}

const isYes = (v) => String(v).toLowerCase() === 'yes';

function applyLogic(c, answers) {
  const L = c.logic || {};
  const all = (ids) => (ids || []).every((id) => isYes(answers[id]));
  const any = (ids) => (ids || []).some((id) => isYes(answers[id]));
  const anyNo = (ids) => (ids || []).some((id) => !isYes(answers[id]));
  if (L.no_if_any && any(L.no_if_any)) return 'no';
  if (c.na_allowed && L.na_unless && anyNo(L.na_unless)) return 'na';
  if (c.na_allowed && L.na_if_any && any(L.na_if_any)) return 'na';
  const hasYesRule = (L.yes_if_all && L.yes_if_all.length) || (L.yes_if_any && L.yes_if_any.length);
  if (hasYesRule && all(L.yes_if_all) && (!L.yes_if_any || !L.yes_if_any.length || any(L.yes_if_any))) return 'yes';
  return L.default === 'yes' ? 'yes' : 'no';
}

// Deterministic detectors for crisp sub-questions. A check with `detector` is answered by code, not by
// the model: greeting, name and goodbye are reliably recognisable in RU / KZ / EN, and a 7B model
// misreads them surprisingly often.
const GREET = {
  ru: /здравствуй|добр(ый|ое|ого)\s+(день|утр|вечер|времени)|приветствую|привет/i,
  kk: /сәлеметсіз|сәлем|қайырлы\s+(күн|таң|кеш)|армысыз/i,
  en: /\b(hello|hi|hey|good\s+(morning|afternoon|evening)|greetings)\b/i,
};
const NAME = [
  /меня\s+зовут/i, /(^|[\s,.!?])я\s+[А-ЯЁ][а-яё]+/, /(^|[\s,.!?])это\s+[А-ЯЁ][а-яё]+/,
  /менің\s+атым/i, /(^|[\s,.!?])мен\s+[А-ЯЁӘҒҚҢӨҰҮҺІ][^\s,.!?]*/,
  /my\s+name\s+is/i, /\bI'?m\s+[A-Z][a-z]+/, /\bI\s+am\s+[A-Z][a-z]+/, /\bthis\s+is\s+[A-Z][a-z]+/,
  /\[Имя скрыто\]/,
];
const BYE = /до\s+свидания|всего\s+(доброго|хорошего)|хорошего\s+(дня|вечера)|удачного\s+дня|до\s+встречи|благодарю\s+(вас\s+)?за\s+обращение|спасибо\s+за\s+обращение|сау\s+болыңыз|қош\s+болыңыз|күніңіз\s+сәтті|goodbye|\bbye\b|have\s+a\s+(good|nice|great)\s+(day|evening|one)|take\s+care|thank\s+you\s+for\s+contacting/i;

function clientLang(msgs) {
  const t = msgs.filter((m) => m.speaker === 'client').map((m) => m.text).join(' ');
  if (/[әғқңөұүһі]/i.test(t)) return 'kk';
  if (/[а-яё]/i.test(t)) return 'ru';
  if (/[a-z]/i.test(t)) return 'en';
  return null;
}

const DETECTORS = {
  // greeting in the client's language, in the first client-facing operator message
  first_op_greeting(msgs, d) {
    const i = d.first_client_facing_operator_idx;
    if (i === null) return { answer: 'no', msg: null };
    const lang = clientLang(msgs);
    const rx = lang ? GREET[lang] : null;
    const ok = rx ? rx.test(msgs[i].text) : Object.values(GREET).some((r) => r.test(msgs[i].text));
    return { answer: ok ? 'yes' : 'no', msg: i };
  },
  first_op_name(msgs, d) {
    const i = d.first_client_facing_operator_idx;
    if (i === null) return { answer: 'no', msg: null };
    return { answer: NAME.some((r) => r.test(msgs[i].text)) ? 'yes' : 'no', msg: i };
  },
  // goodbye in one of the last two client-facing operator messages
  operator_goodbye(msgs, d) {
    const ops = msgs.filter((m) => m.speaker === 'operator' && !d.internal_idx.includes(m.idx)).slice(-2);
    const hit = ops.reverse().find((m) => BYE.test(m.text));
    return { answer: hit ? 'yes' : 'no', msg: hit ? hit.idx : ops.length ? ops[0].idx : null };
  },
  // the client ended the conversation (or the line dropped) right after their own message,
  // before the operator could close it, and the operator had not said goodbye yet
  client_left_early(msgs, d) {
    if (d.ended_by_client_idx === null) return { answer: 'no', msg: null };
    const before = msgs.slice(0, d.ended_by_client_idx).filter((m) => m.speaker === 'client' || (m.speaker === 'operator' && !d.internal_idx.includes(m.idx)));
    const last = before[before.length - 1];
    const opSaidBye = DETECTORS.operator_goodbye(msgs, d).answer === 'yes';
    return { answer: last && last.speaker === 'client' && !opSaidBye ? 'yes' : 'no', msg: d.ended_by_client_idx };
  },
};

const modelChecks = (c) => (usesChecks(c) ? c.checks.filter((q) => !q.detector) : []);
// Every sub-question is answered by code: the model does not need to see this criterion at all.
const codeOnly = (c) => usesChecks(c) && modelChecks(c).length === 0;

module.exports = { signature, usesChecks, applyLogic, DETECTORS, modelChecks, codeOnly, clientLang };
