'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Fake Groq: answers per model from a script, records which models were called and with what body.
function fakeGroq(script) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    const step = script[body.model];
    const r = typeof step === 'function' ? step(body) : step;
    return {
      ok: r.status === 200,
      status: r.status,
      headers: { get: (h) => (h === 'retry-after' && r.retryAfter ? String(r.retryAfter) : null) },
      text: async () => JSON.stringify(r.status === 200
        ? { choices: [{ message: { content: '{"criteria":{}}' } }], usage: { prompt_tokens: 5000, completion_tokens: 600, prompt_tokens_details: { cached_tokens: 3000 } } }
        : { error: { message: 'rate limit' } }),
    };
  };
  return calls;
}

function freshLlm() {
  delete require.cache[require.resolve('../lib/llm')];
  globalThis.__cqaExhausted = new Map();
  process.env.LLM_PROVIDER = 'groq';
  process.env.GROQ_API_KEY = 'test';
  process.env.LLM_MAX_WAIT_SEC = '5'; // as on serverless: never sit out long rate-limit waits in tests
  delete process.env.LLM_MODEL;
  delete process.env.LLM_FALLBACK_MODELS;
  delete process.env.PRICE_INPUT_PER_MTOK;
  delete process.env.PRICE_OUTPUT_PER_MTOK;
  return require('../lib/llm');
}

test('daily limit on the main model switches to the fallback model, and the next call skips it', async () => {
  const llm = freshLlm();
  const calls = fakeGroq({ 'openai/gpt-oss-120b': { status: 429, retryAfter: 900 }, 'openai/gpt-oss-20b': { status: 200 } });
  const r1 = await llm.complete({ system: 's', user: 'u' });
  assert.equal(r1.model, 'openai/gpt-oss-20b');
  assert.equal(r1.fallback_from, 'openai/gpt-oss-120b');
  assert.deepEqual(calls.map((c) => c.model), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
  await llm.complete({ system: 's', user: 'u' });
  assert.deepEqual(calls.slice(2).map((c) => c.model), ['openai/gpt-oss-20b'], 'exhausted model is not called again');
});

test('gpt-oss requests use low reasoning effort; cached input is cheaper', async () => {
  const llm = freshLlm();
  const calls = fakeGroq({ 'openai/gpt-oss-120b': { status: 200 } });
  const r = await llm.complete({ system: 's', user: 'u' });
  assert.equal(calls[0].reasoning_effort, 'low');
  // (2000 uncached * 0.15 + 3000 cached * 0.075 + 600 * 0.60) / 1e6
  assert.ok(Math.abs(r.cost_usd - (2000 * 0.15 + 3000 * 0.075 + 600 * 0.6) / 1e6) < 1e-12);
});

test('when every model is out of quota the caller gets 429 with a retry hint', async () => {
  const llm = freshLlm();
  fakeGroq({ 'openai/gpt-oss-120b': { status: 429, retryAfter: 900 }, 'openai/gpt-oss-20b': { status: 429, retryAfter: 300 } });
  await assert.rejects(llm.complete({ system: 's', user: 'u' }), (e) => e.status === 429 && e.retryAfterSec >= 290 && e.retryAfterSec <= 300);
});

test('request too large (413) for one model moves on to the next', async () => {
  const llm = freshLlm();
  fakeGroq({ 'openai/gpt-oss-120b': { status: 413 }, 'openai/gpt-oss-20b': { status: 200 } });
  const r = await llm.complete({ system: 's', user: 'u' });
  assert.equal(r.model, 'openai/gpt-oss-20b');
});
