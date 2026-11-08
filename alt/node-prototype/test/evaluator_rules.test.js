'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// Run the evaluator with a fake model answer to test numbering, guards and cross-criterion rules.
function run(transcript, modelCriteria) {
  process.env.LLM_PROVIDER = 'groq';
  process.env.GROQ_API_KEY = 'test';
  process.env.LLM_FALLBACK_MODELS = '';
  global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ criteria: modelCriteria }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) });
  for (const m of ['../lib/llm', '../lib/evaluator']) delete require.cache[require.resolve(m)];
  const { evaluate } = require('../lib/evaluator');
  const cl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'checklists', 'default.json'), 'utf8'));
  cl.uid = 'test@v1';
  return evaluate({ conversation_id: 't', channel: 'agent chat', language: 'RU', transcript: transcript.map(([speaker, text], i) => ({ timestamp: `00:${String(i).padStart(2, '0')}`, speaker, text })) }, cl);
}
const base = (over) => ({
  c02: { answer: 'na', explanation: '', evidence: [], checked_range: null },
  c03: { checks: { sensitive: { answer: 'no', msg: null }, verified_before: { answer: 'no', msg: null } }, explanation: '', evidence: [], checked_range: null },
  c04: { answer: '20', explanation: '', evidence: [], checked_range: null },
  c05: { answer: 'yes', explanation: '', evidence: [], checked_range: null },
  c06: { answer: '10', explanation: '', evidence: [], checked_range: null },
  c07: { checks: { summary_or_help: { answer: 'yes', msg: 3 } }, explanation: '', evidence: [], checked_range: null },
  c08: { answer: 'no', explanation: '', evidence: [], checked_range: null },
  ...over,
});
const row = (r, id) => r.result.criteria.find((c) => c.criterion_id === id);

test('model message numbers (from 1) are stored as 0-based indices', async () => {
  const r = await run([['client', 'Где отчёт?'], ['operator', 'Здравствуйте, меня зовут Ая. Меню → Отчёты.'], ['operator', 'Остались вопросы? До свидания!']],
    base({ c04: { answer: '20', explanation: 'ok', evidence: [{ msg: 2, quote: 'Меню → Отчёты.' }], checked_range: null } }));
  assert.equal(row(r, 'c04').evidence[0].msg, 1);
  assert.equal(row(r, 'c04').evidence[0].verified, true);
});

test('discovery "yes" without any operator question becomes N/A', async () => {
  const r = await run([['client', 'Где отчёт брокера в приложении?'], ['operator', 'Здравствуйте, меня зовут Ая. Меню → Отчёты.']], base({ c02: { answer: 'yes', explanation: '', evidence: [], checked_range: null } }));
  assert.equal(row(r, 'c02').answer, 'na');
});

test('account data disclosed without identification: identification "no" and gross error "yes"', async () => {
  const r = await run([['client', 'Какой у меня баланс?'], ['operator', 'Здравствуйте, я Нурлан. На счёте 450 000 тенге.']],
    base({ c03: { checks: { sensitive: { answer: 'yes', msg: 2 }, verified_before: { answer: 'no', msg: null } }, explanation: '', evidence: [], checked_range: null } }));
  assert.equal(row(r, 'c03').answer, 'no');
  assert.equal(row(r, 'c08').answer, 'yes');
  assert.equal(r.result.gross_error, true);
});

test('a system identity confirmation before handling makes identification "yes"', async () => {
  const r = await run([['client', 'Проверьте мой платёж'], ['system', 'Личность клиента подтверждена.'], ['operator', 'Здравствуйте, я Дана. Платёж в обработке.']], base({}));
  assert.equal(row(r, 'c03').answer, 'yes');
  assert.equal(row(r, 'c08').answer, 'no');
});
