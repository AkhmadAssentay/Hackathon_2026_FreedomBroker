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
//   na_if_none  -> "na" if none of these is "yes"           (only when N/A is allowed)
//   yes_if_all  -> required "yes" answers for "yes"
//   yes_if_any  -> at least one must be "yes" for "yes"
//   default     -> answer when no rule fires ("yes" or "no"; default "no")
// For flag criteria "yes" means the violation is present.

function signature(c) {
  return [c.name, c.type, String(c.description || '').trim()].join('|');
}

function codeRulesActive(c) {
  return !!c && c.checks_signature === signature(c);
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
  if (c.na_allowed && L.na_if_none && L.na_if_none.length && !any(L.na_if_none)) return 'na';
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
  /меня\s+зовут/i, /(^|[\s,.!?])[Яя]\s+[А-ЯЁ][а-яё]+/, /(^|[\s,.!?])[Ээ]то\s+[А-ЯЁ][а-яё]+/,
  /менің\s+атым/i, /(^|[\s,.!?])[Мм]ен\s+[А-ЯЁӘҒҚҢӨҰҮҺІ][^\s,.!?]*/,
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
  // the client ended the conversation (or the line dropped) before the operator closed it:
  // the operator had not said goodbye by then, so closing could not be evaluated (N/A, not "no")
  client_left_early(msgs, d) {
    if (d.ended_by_client_idx === null) return { answer: 'no', msg: null };
    const before = msgs.slice(0, d.ended_by_client_idx);
    const opSaidBye = DETECTORS.operator_goodbye(before, { ...d, internal_idx: d.internal_idx }).answer === 'yes';
    return { answer: opSaidBye ? 'no' : 'yes', msg: d.ended_by_client_idx };
  },
};

const CLARIFY_NOT = /чем\s+(я\s+)?(могу|можем)\s+(вам\s+)?помочь|с\s+чем\s+помочь|how\s+can\s+i\s+help|what\s+can\s+i\s+do|қалай\s+көмектесе|остал\S*(\s+\S+){0,3}\s+вопрос|(есть|будут)\s+(ли\s+)?(ещё|еще)\s+вопрос|anything\s+else|басқа\s+сұрақ|вы\s+на\s+линии|are\s+you\s+there/i;
Object.assign(DETECTORS, {
  // identity confirmed by a system event (e.g. «Личность клиента подтверждена.»)
  system_verified(msgs, d) {
    return { answer: d.id_confirmed_idx !== null ? 'yes' : 'no', msg: d.id_confirmed_idx };
  },
  // the operator asked the client a real clarifying question (not «чем могу помочь?» / «остались вопросы?»)
  operator_clarifying_question(msgs, d) {
    const q = msgs.find((m) => m.speaker === 'operator' && !d.internal_idx.includes(m.idx) && /\?/.test(m.text) && !CLARIFY_NOT.test(m.text));
    return { answer: q ? 'yes' : 'no', msg: q ? q.idx : null };
  },
});

const modelChecks = (c) => (usesChecks(c) ? c.checks.filter((q) => !q.detector) : []);
// Every sub-question is answered by code: the model does not need to see this criterion at all.
const codeOnly = (c) => usesChecks(c) && modelChecks(c).length === 0;

module.exports = { signature, codeRulesActive, usesChecks, applyLogic, DETECTORS, modelChecks, codeOnly, clientLang };
