'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { score } = require('../lib/scoring');
const checklist = require('../checklists/default.json');

const all = (overrides = {}) => {
  const base = { c01: 'yes', c02: 'yes', c03: 'yes', c04: 20, c05: 'yes', c06: 10, c07: 'yes', c08: 'no' };
  const v = {};
  for (const [k, a] of Object.entries({ ...base, ...overrides })) v[k] = { answer: a };
  return v;
};

test('perfect chat = 100', () => {
  const r = score(checklist, all());
  assert.strictEqual(r.total, 100);
  assert.strictEqual(r.gross_error, false);
});

test('all no / zero = 0', () => {
  const r = score(checklist, all({ c01: 'no', c02: 'no', c03: 'no', c04: 0, c05: 'no', c06: 0, c07: 'no' }));
  assert.strictEqual(r.total, 0);
});

test('scale converted proportionally: c04=15 -> 15/20*20 = 15 points lost 5', () => {
  const r = score(checklist, all({ c04: 15 }));
  assert.strictEqual(r.total, 95);
  const r2 = score(checklist, all({ c06: 7 }));
  assert.strictEqual(r2.total, 95.5); // 7/10*15 = 10.5
});

test('N/A redistributes weight: identification N/A, everything else perfect = 100', () => {
  const r = score(checklist, all({ c03: 'na' }));
  assert.strictEqual(r.total, 100);
  const c01 = r.criteria.find((c) => c.criterion_id === 'c01');
  assert.strictEqual(c01.effective_weight, 12.5); // 10/80*100
});

test('N/A + one miss: c03 N/A, c01 no -> (80-10)/80*100 = 87.5', () => {
  const r = score(checklist, all({ c03: 'na', c01: 'no' }));
  assert.strictEqual(r.total, 87.5);
});

test('rounding to two digits: c02,c03,c07 N/A (weight 60 left), c06 = 7', () => {
  // applicable: c01 10, c04 20, c05 15, c06 15 = 60; c06 earns 0.7*15 = 10.5 -> 55.5/60*100 = 92.5
  const r = score(checklist, all({ c02: 'na', c03: 'na', c07: 'na', c06: 7 }));
  assert.strictEqual(r.total, 92.5);
  // c04=5 -> 5/20*20=5; c06=4 -> 6; c01 yes 10; c05 no -> (10+5+6)/60*100 = 35
  const r2 = score(checklist, all({ c02: 'na', c03: 'na', c07: 'na', c04: 5, c06: 4, c05: 'no' }));
  assert.strictEqual(r2.total, 35);
  // weights 10,15,20 + 5 N/A elsewhere: odd fraction
  const r3 = score(checklist, all({ c04: 'na', c06: 4, c02: 'no' }));
  // applicable 80: earned 10+0+20+15+6+5 = 56 -> 70
  assert.strictEqual(r3.total, 70);
  const r4 = score(checklist, all({ c02: 'na', c06: 7, c07: 'no' }));
  // applicable 85: earned 10+20+20+15+10.5+0 = 75.5 -> 88.8235... -> 88.82
  assert.strictEqual(r4.total, 88.82);
});

test('N/A not allowed is coerced with warning', () => {
  const r = score(checklist, all({ c01: 'na' }));
  const c01 = r.criteria.find((c) => c.criterion_id === 'c01');
  assert.strictEqual(c01.answer, 'no');
  assert.ok(c01.warnings.length > 0);
  assert.strictEqual(r.total, 90);
});

test('gross error is a separate flag, does not change total', () => {
  const r = score(checklist, all({ c08: 'yes' }));
  assert.strictEqual(r.total, 100);
  assert.strictEqual(r.gross_error, true);
});

test('off-scale value snaps to nearest step', () => {
  const r = score(checklist, all({ c06: 8 }));
  const c06 = r.criteria.find((c) => c.criterion_id === 'c06');
  assert.strictEqual(c06.answer, 7);
});

test('no applicable weighted criteria -> total null', () => {
  const cl = {
    settings: { rounding: 2 },
    criteria: [
      { id: 'a', type: 'binary', weight: 50, na_allowed: true },
      { id: 'b', type: 'flag', weight: 0 },
    ],
  };
  const r = score(cl, { a: { answer: 'na' }, b: { answer: 'no' } });
  assert.strictEqual(r.total, null);
});

test('sections computed', () => {
  const r = score(checklist, all({ c01: 'no' }));
  const s = r.sections.find((x) => x.id === 'start');
  assert.strictEqual(s.percent, 60); // 15 of 25
});
