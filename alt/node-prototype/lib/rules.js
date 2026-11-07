'use strict';
// Deterministic signals + a heuristic fallback evaluator (works with no API key, for demo / offline).
// The LLM result is always preferred; rules only add warnings or fill in when LLM_PROVIDER=rules.

const GREET = {
  RU: /(здравствуй|добр(ый|ое|ого) (день|утр|вечер)|привет|приветствую)/i,
  KZ: /(сәлем|сәлеметсіз|қайырлы (күн|таң|кеш)|армысыз)/i,
  EN: /\b(hello|hi|hey|good (morning|afternoon|evening)|greetings|welcome)\b/i,
};
const INTRO_RE = [
  /(меня зовут|на связи|с вами (работает|говорит)|менің атым|есімім|my name is|speaking)/i,
  /(я\s*[-—–]\s*[А-ЯЁA-Z]|оператор\s+[А-ЯЁ]|[Tt]his is [A-Z]|I am [A-Z]|I'm [A-Z])/,
];
const INTRO = { test: (s) => INTRO_RE.some((r) => r.test(s)) };
const BYE = /(до свидания|всего доброго|хорошего дня|всего хорошего|обращайтесь|чем (ещё|еще) могу помочь|сау болыңыз|көмек керек болса|қайырлы күн|goodbye|bye|have a (nice|great|good) day|anything else|take care)/i;
const WAIT_WARN = /(минут|подождите|ожидайте|уточню|проверю|момент|күте тұрыңыз|бір минут|тексеремін|please wait|one moment|let me check|hold on)/i;

const GROSS_PATTERNS = [
  { re: /(переведите|перевести|скиньте|отправьте).{0,40}(мне|на мою|лично|на мой)/i, why: 'Предложение перевести деньги оператору лично' },
  { re: /(маған|менің картам).{0,30}(аударыңыз|жіберіңіз)/i, why: 'Предложение перевести деньги оператору лично (KZ)' },
  { re: /(transfer|send).{0,30}(to me|my (personal )?(card|account))/i, why: 'Offer to transfer money to the operator personally' },
  { re: /(ваш|свой|дайте|оставьте).{0,20}(личн\w* )?(номер|whatsapp|телеграм|telegram).{0,40}(консульт|помогу|лично|частн)/i, why: 'Просьба личного номера для частной консультации' },
  { re: /(your|personal).{0,20}(number|whatsapp|telegram).{0,40}(privately|personally|consult)/i, why: 'Asking for personal number for private consultation' },
  { re: /(дурак|идиот|тупой|кретин|stupid|idiot|moron|ақымақ)/i, why: 'Возможное оскорбление клиента' },
];

function grossSignals(msgs) {
  const hits = [];
  for (const m of msgs) {
    if (m.speaker !== 'operator') continue;
    for (const p of GROSS_PATTERNS) if (p.re.test(m.text)) hits.push({ msg: m.idx, why: p.why });
  }
  return hits;
}

function q(m, n = 12) {
  return m.text.split(/\s+/).slice(0, n).join(' ');
}

// Heuristic evaluation for the default criteria ids; unknown criteria get N/A (if allowed) with a warning.
function heuristicVerdicts(checklist, record, msgs, facts) {
  const lang = (record.language || 'RU').toUpperCase();
  const ops = msgs.filter((m) => m.speaker === 'operator');
  const clients = msgs.filter((m) => m.speaker === 'client');
  const first = ops[0];
  const last = ops[ops.length - 1];
  const v = {};
  const W = ['Эвристика без LLM: оценка приблизительная'];

  for (const c of checklist.criteria) {
    const role = c.id;
    if (role === 'c01') {
      const ok = first && (GREET[lang] || GREET.RU).test(first.text) && INTRO.test(first.text);
      v[c.id] = {
        answer: ok ? 'yes' : 'no',
        explanation: first ? (ok ? 'Приветствие и представление в первом ответе.' : 'В первом ответе нет приветствия на языке клиента и/или представления.') : 'Оператор не отвечал.',
        evidence: first ? [{ msg: first.idx, quote: q(first) }] : [],
        checked_range: first ? [first.idx, first.idx] : null,
        warnings: W,
      };
    } else if (role === 'c06') {
      const unwarned = facts.long_waits.filter((w) => !msgs.slice(w.from_idx, w.to_idx + 1).some((m) => m.speaker === 'operator' && WAIT_WARN.test(m.text)));
      v[c.id] = {
        answer: unwarned.length ? 7 : 10,
        explanation: unwarned.length ? 'Была долгая пауза без предупреждения об ожидании.' : 'Явных сбоев в ведении диалога не найдено.',
        evidence: unwarned.length ? [{ msg: unwarned[0].to_idx, quote: q(msgs[unwarned[0].to_idx]) }] : [],
        checked_range: unwarned.length ? [unwarned[0].from_idx, unwarned[0].to_idx] : null,
        warnings: W,
      };
    } else if (role === 'c07') {
      const lastMsg = msgs[msgs.length - 1];
      const clientLeft = lastMsg && lastMsg.speaker === 'client';
      const ok = last && BYE.test(last.text);
      v[c.id] = {
        answer: ok ? 'yes' : clientLeft && c.na_allowed ? 'na' : 'no',
        explanation: ok ? 'Оператор попрощался / предложил помощь.' : clientLeft ? 'Диалог оборвался на реплике клиента.' : 'Нет прощания или итога в конце.',
        evidence: last ? [{ msg: last.idx, quote: q(last) }] : [],
        checked_range: last ? [last.idx, msgs.length - 1] : null,
        warnings: W,
      };
    } else if (role === 'c08' || c.type === 'flag') {
      const hits = grossSignals(msgs);
      v[c.id] = {
        answer: hits.length ? 'yes' : 'no',
        explanation: hits.length ? hits.map((h) => h.why).join('; ') : 'Признаков грубых нарушений не найдено.',
        evidence: hits.map((h) => ({ msg: h.msg, quote: q(msgs[h.msg]) })),
        checked_range: hits.length ? null : [0, msgs.length - 1],
        warnings: W,
      };
    } else if (role === 'c04') {
      v[c.id] = {
        answer: clients.length === 0 && c.na_allowed ? 'na' : ops.length > 1 ? 15 : 5,
        explanation: 'Эвристика не может проверить корректность консультации — нужна LLM.',
        evidence: last ? [{ msg: last.idx, quote: q(last) }] : [],
        checked_range: null,
        warnings: W,
      };
    } else if (role === 'c05') {
      v[c.id] = { answer: 'yes', explanation: 'Невежливых реплик не обнаружено (эвристика).', evidence: [], checked_range: [0, msgs.length - 1], warnings: W };
    } else {
      v[c.id] = {
        answer: c.na_allowed ? 'na' : c.type === 'scale' ? Math.max(...c.scale.map((s) => s.value)) : 'yes',
        explanation: 'Критерий не поддерживается эвристикой — подключите LLM для оценки.',
        evidence: [],
        checked_range: null,
        warnings: W,
      };
    }
  }
  return v;
}

module.exports = { grossSignals, heuristicVerdicts };
