'use strict';
// Builds the evaluation prompt from the checklist CONFIG, so any edited / new criterion
// is applied without code changes.
const { fmtSec } = require('./transcript');
const { usesChecks, modelChecks, codeOnly } = require('./checks');

const LANG_NAMES = { RU: 'русский', KZ: 'казахский', EN: 'английский' };

function describeCriterion(c) {
  const lines = [];
  lines.push(`### ${c.id} — ${c.code ? c.code + '. ' : ''}${c.name}`);
  // Criteria decided by sub-questions: the model needs only the sub-questions (the verdict, N/A and
  // the rule are applied in code), which keeps the prompt short for rate-limited hosted models.
  if (usesChecks(c)) {
    lines.push('Подвопросы (ответь на КАЖДЫЙ "yes" или "no" и укажи номер реплики-основания msg или null; итог по критерию вычислит система, поле answer не нужно):');
    for (const q of modelChecks(c)) lines.push(`  - ${q.id}: ${q.q}`);
    return lines.join('\n');
  }
  if (c.type === 'binary') lines.push(`Тип: ДА/НЕТ${c.na_allowed ? '/N/A' : ''}. Поле answer: "yes" | "no"${c.na_allowed ? ' | "na"' : ''}.`);
  if (c.type === 'flag') lines.push('Тип: флаг грубого нарушения (без баллов). Поле answer: "yes" (нарушение есть) | "no".');
  if (c.type === 'scale') {
    const steps = c.scale.map((s) => s.value).join(', ');
    lines.push(`Тип: шкала. Поле answer: одно из чисел [${steps}]${c.na_allowed ? ' или "na"' : ''}.`);
    lines.push('Ступени шкалы:');
    for (const s of [...c.scale].sort((a, b) => b.value - a.value)) lines.push(`  ${s.value} — ${s.label}`);
  }
  if (c.description) lines.push(`Правило: ${c.description}`);
  if (c.na_allowed) lines.push(`N/A допустим ТОЛЬКО если: ${c.na_condition || '(условие не задано — используйте N/A только если критерий объективно неприменим)'}`);
  else lines.push('N/A для этого критерия НЕ допускается.');
  return lines.join('\n');
}

function buildPrompt({ checklist, record, msgs, facts }) {
  const threshold = (checklist.settings && checklist.settings.first_response_threshold_sec) || 180;
  const system = [
    'Ты — эксперт отдела контроля качества (QA) брокерской компании Freedom Broker.',
    'Ты оцениваешь работу ОПЕРАТОРА в диалоге с клиентом строго по чек-листу.',
    'Правила:',
    '- Оценивается только оператор (speaker = operator). Реплики bot и system — контекст (например, системное сообщение о прохождении идентификации считается подтверждением).',
    '- Диалог может быть на русском, казахском или английском. Оценивай по одинаковым правилам.',
    '- «Нет» — действие было нужно, но пропущено или выполнено неправильно. N/A — только если выполнено условие неприменимости критерия.',
    '- Каждый вывод подтверждай ТОЧНОЙ цитатой из транскрипта (дословный фрагмент реплики, 3–25 слов) и номером реплики [n].',
    '- Если действие пропущено — укажи checked_range: [начало, конец] номеров реплик, где оно ожидалось, и объясни.',
    '- Если N/A — объясни, какое условие неприменимости выполнено.',
    '- Не придумывай факты, которых нет в транскрипте.',
    `- Порог первой реакции: ${threshold} сек. Теги и вложения в оценку не входят.`,
    '- Объяснения пиши на русском языке, кратко (1–3 предложения), в стиле: «<Критерий> — <ответ>. <Почему>. Основание — <какая реплика>».',
    '- Объяснение должно описывать, что КОНКРЕТНО сделал или не сделал оператор в ЭТОМ диалоге (кто, что сказал, в какой реплике). Не переписывай текст правила или ступени шкалы.',
    '- Ставь «да» / высший балл только если каждое условие правила выполнено. Например, для завершения нужны и прощание, и итог или предложение дальнейшей помощи.',
    'Ответ — СТРОГО один JSON-объект без markdown. Ключи объекта criteria — id критериев, формат:',
    '{"criteria":{"<id критерия>":{"answer":<см. тип>,"explanation":"...","evidence":[{"msg":<номер>,"quote":"<дословная цитата>"}],"checked_range":[<от>,<до>] | null}}}',
    'Для критериев с подвопросами вместо answer верни "checks":{"<id подвопроса>":{"answer":"yes"|"no","msg":<номер>|null}}.',
    '- Реплики, помеченные ВНУТРЕННИЙ, — разговор оператора с коллегой, пока клиент на удержании. Клиент их не слышит; не оценивай их как общение с клиентом.',
    'Заполни запись для КАЖДОГО критерия из чек-листа.',
  ].join('\n');

  const crit = checklist.criteria.filter((c) => !codeOnly(c)).map(describeCriterion).join('\n\n');

  const internal = new Set((facts.dialog && facts.dialog.internal_idx) || []);
  // Keep the prompt compact (hosted models have per-request token limits): calls show the offset from
  // the start instead of the full ISO timestamp, and the operator's internal talk with a colleague while
  // the client is on hold is collapsed into one line. Message numbers stay the same.
  const lines = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (internal.has(m.idx)) {
      let j = i;
      while (j + 1 < msgs.length && (internal.has(msgs[j + 1].idx) || (msgs[j + 1].speaker === 'system' && internal.has(msgs[j + 2]?.idx)))) j++;
      lines.push(`[${m.idx + 1}–${msgs[j].idx + 1}] (${j - i + 1} реплик) ВНУТРЕННИЙ разговор оператора с коллегой, клиент на удержании и не слышит — опущен, не оценивается`);
      i = j;
      continue;
    }
    const ts = /^\d{4}-\d{2}-\d{2}T/.test(String(m.timestamp || '')) ? fmtSec(m.offset_sec) : `${m.timestamp ?? ''} (${fmtSec(m.offset_sec)})`;
    lines.push(`[${m.idx + 1}] ${ts} ${m.speaker}: ${m.text.replace(/\s+/g, ' ')}`);
  }

  const factLines = [];
  factLines.push(`Канал: ${record.channel}. Язык диалога: ${LANG_NAMES[record.language] || record.language}.`);
  if (facts.first_operator_idx !== null) factLines.push(`Первая реплика оператора: [${facts.first_operator_idx + 1}].`);
  else factLines.push('Оператор в диалоге не отвечал.');
  if (facts.first_response_sec !== null) factLines.push(`Время первой реакции оператора: ${fmtSec(facts.first_response_sec)} (порог ${fmtSec(threshold)}).`);
  if (facts.long_waits.length)
    factLines.push(
      'Паузы ответа оператора длиннее порога: ' +
        facts.long_waits.map((w) => `[${w.from_idx + 1}]→[${w.to_idx + 1}] ${fmtSec(w.gap_sec)}`).join('; ') +
        '. Проверь, предупреждал ли оператор об ожидании.'
    );
  else factLines.push('Пауз ответа длиннее порога не обнаружено.');
  const d = facts.dialog;
  if (d) {
    if (d.first_client_facing_operator_idx !== null) factLines.push(`Первая реплика оператора клиенту: [${d.first_client_facing_operator_idx + 1}]. Последняя реплика оператора клиенту: [${d.last_operator_idx + 1}].`);
    if (d.holds.length) factLines.push(`Клиент на удержании: ${d.holds.map(([a, b]) => `[${a + 1}]–[${b + 1}]`).join(', ')}. Реплики оператора внутри — внутренний разговор с коллегой.`);
    factLines.push(d.id_confirmed_idx !== null ? `Система подтвердила личность клиента в реплике [${d.id_confirmed_idx + 1}].` : 'Системного сообщения о подтверждении личности нет (проверка могла пройти голосом оператора — смотри реплики).');
    if (d.closed_by_operator_idx !== null) factLines.push(`Чат закрыл оператор: [${d.closed_by_operator_idx + 1}].`);
    if (d.ended_by_client_idx !== null) factLines.push(`Разговор завершил клиент или связь прервалась: [${d.ended_by_client_idx + 1}].`);
  }

  const user = [
    `# Чек-лист: ${checklist.name} (версия ${checklist.version})`,
    crit,
    '',
    '# Автоматически вычисленные факты (используй как подсказку)',
    factLines.join('\n'),
    '',
    `# Транскрипт ${record.conversation_id}`,
    'Формат: [номер реплики, с 1] метка_времени (смещение от начала; у звонков только смещение) роль: текст',
    lines.join('\n'),
    '',
    'Верни JSON.',
  ].join('\n');

  return { system, user, schema: buildSchema(checklist) };
}

// JSON schema of the answer: one required entry per criterion, answer limited to the allowed values.
// Providers that support structured output (Ollama/OpenAI-compatible, Anthropic) then cannot skip a criterion.
function answerEnum(c) {
  const vals = c.type === 'scale' ? c.scale.map((s) => String(s.value)) : ['yes', 'no'];
  if (c.na_allowed) vals.push('na');
  return vals;
}
function buildSchema(checklist) {
  const props = {};
  for (const c of checklist.criteria) {
    if (codeOnly(c)) continue; // answered entirely by code, not asked of the model
    if (usesChecks(c)) {
      const cp = {};
      for (const q of modelChecks(c)) cp[q.id] = { type: 'object', properties: { answer: { type: 'string', enum: ['yes', 'no'] }, msg: { anyOf: [{ type: 'integer' }, { type: 'null' }] } }, required: ['answer', 'msg'], additionalProperties: false };
      props[c.id] = {
        type: 'object',
        properties: {
          checks: { type: 'object', properties: cp, required: Object.keys(cp), additionalProperties: false },
          explanation: { type: 'string' },
          evidence: { type: 'array', items: { type: 'object', properties: { msg: { type: 'integer' }, quote: { type: 'string' } }, required: ['msg', 'quote'], additionalProperties: false } },
          checked_range: { anyOf: [{ type: 'array', items: { type: 'integer' } }, { type: 'null' }] },
        },
        required: ['checks', 'explanation', 'evidence', 'checked_range'],
        additionalProperties: false,
      };
      if (!Object.keys(cp).length) {
        delete props[c.id].properties.checks;
        props[c.id].required = ['explanation', 'evidence', 'checked_range'];
      }
      continue;
    }
    props[c.id] = {
      type: 'object',
      properties: {
        answer: { type: 'string', enum: answerEnum(c) },
        explanation: { type: 'string' },
        evidence: {
          type: 'array',
          items: { type: 'object', properties: { msg: { type: 'integer' }, quote: { type: 'string' } }, required: ['msg', 'quote'], additionalProperties: false },
        },
        checked_range: { anyOf: [{ type: 'array', items: { type: 'integer' } }, { type: 'null' }] },
      },
      required: ['answer', 'explanation', 'evidence', 'checked_range'],
      additionalProperties: false,
    };
  }
  return {
    type: 'object',
    properties: { criteria: { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false } },
    required: ['criteria'],
    additionalProperties: false,
  };
}

module.exports = { buildPrompt, buildSchema };
