'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { signature, usesChecks, applyLogic, DETECTORS } = require('../lib/checks');
const { indexTranscript, dialogFacts } = require('../lib/transcript');

const dlg = (lines) => {
  const msgs = indexTranscript({ transcript: lines.map(([speaker, text], i) => ({ timestamp: `00:${String(i).padStart(2, '0')}`, speaker, text })) });
  return { msgs, d: dialogFacts(msgs) };
};

test('greeting and name are detected in the first operator message, in RU / KZ / EN', () => {
  for (const [client, op] of [
    ['Где мой тариф?', 'Здравствуйте! Меня зовут Алина. Откройте «Кабинет».'],
    ['Тариф қайда?', 'Сәлеметсіз бе, мен Аружан. «Кабинет» бөлімін ашыңыз.'],
    ['Where is my plan?', "Hi, I'm Alex. Open the Cabinet tab."],
  ]) {
    const { msgs, d } = dlg([['client', client], ['bot', 'Hello!'], ['operator', op]]);
    assert.equal(DETECTORS.first_op_greeting(msgs, d).answer, 'yes', op);
    assert.equal(DETECTORS.first_op_name(msgs, d).answer, 'yes', op);
  }
});

test('greeting in the wrong language or without a name does not count', () => {
  let x = dlg([['client', 'Тариф қайда?'], ['operator', 'Здравствуйте, меня зовут Алина.']]);
  assert.equal(DETECTORS.first_op_greeting(x.msgs, x.d).answer, 'no');
  x = dlg([['client', 'Где вход?'], ['operator', 'Привет, где именно ищете?']]);
  assert.equal(DETECTORS.first_op_name(x.msgs, x.d).answer, 'no');
  // "Я посмотрел" is not an introduction
  x = dlg([['client', 'Что со счётом?'], ['operator', 'Здравствуйте. Я посмотрел ваш счёт.']]);
  assert.equal(DETECTORS.first_op_name(x.msgs, x.d).answer, 'no');
});

test('operator lines while the client is on hold are internal', () => {
  const { d } = dlg([
    ['operator', 'Здравствуйте, меня зовут Марат.'],
    ['system', 'Клиент находится на удержании.'],
    ['operator', 'Коллега, подскажи по бумаге.'],
    ['system', 'Клиент больше не находится на удержании.'],
    ['operator', 'Спасибо за ожидание.'],
  ]);
  assert.deepEqual(d.internal_idx, [2]);
  assert.equal(d.last_operator_idx, 4);
});

test('client left early only when the client ended right after their own message', () => {
  let x = dlg([['operator', 'Передам в отдел.'], ['client', 'Всё, спасибо'], ['system', 'Клиент завершил разговор.']]);
  assert.equal(DETECTORS.client_left_early(x.msgs, x.d).answer, 'yes');
  x = dlg([['client', 'Понял'], ['operator', 'До свидания!'], ['system', 'Клиент завершил разговор.']]);
  assert.equal(DETECTORS.client_left_early(x.msgs, x.d).answer, 'no');
});

test('rules turn sub-answers into the criterion answer', () => {
  const c07 = { na_allowed: true, logic: { na_if_any: ['left'], yes_if_all: ['bye', 'help'], default: 'no' } };
  assert.equal(applyLogic(c07, { left: 'no', bye: 'yes', help: 'yes' }), 'yes');
  assert.equal(applyLogic(c07, { left: 'no', bye: 'yes', help: 'no' }), 'no');
  assert.equal(applyLogic(c07, { left: 'yes', bye: 'no', help: 'no' }), 'na');
  const c03 = { na_allowed: true, logic: { na_unless: ['sensitive'], yes_if_all: ['verified'], default: 'no' } };
  assert.equal(applyLogic(c03, { sensitive: 'no', verified: 'no' }), 'na');
  assert.equal(applyLogic(c03, { sensitive: 'yes', verified: 'no' }), 'no');
  // N/A is never produced where it is not allowed
  assert.equal(applyLogic({ ...c07, na_allowed: false }, { left: 'yes', bye: 'no', help: 'no' }), 'no');
});

test('sub-questions switch off when the criterion wording is changed in the UI', () => {
  const c = { name: 'Завершение', type: 'binary', description: 'Да — попрощался.', checks: [{ id: 'bye', q: '?' }] };
  c.checks_signature = signature(c);
  assert.equal(usesChecks(c), true);
  assert.equal(usesChecks({ ...c, description: 'Да — оператор отправил ссылку на опрос.' }), false);
  assert.equal(usesChecks({ ...c, name: 'Новый критерий' }), false);
});
