'use strict';
// Provider-agnostic LLM call. Zero dependencies: uses global fetch (Node 18+).
// Provider is chosen by LLM_PROVIDER = anthropic | openai | groq | gemini | rules.

const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-4.1-mini',
  // Groq: fast hosted open models behind an OpenAI-compatible API (override with LLM_MODEL)
  groq: 'openai/gpt-oss-120b',
  gemini: 'gemini-2.5-flash',
};

// Known list prices, USD per 1M tokens [input, output] (Groq model page, Nov 2026).
// PRICE_INPUT_PER_MTOK / PRICE_OUTPUT_PER_MTOK in .env override them.
const DEFAULT_PRICES = {
  'groq:openai/gpt-oss-120b': [0.15, 0.6],
};

function config() {
  const provider = (process.env.LLM_PROVIDER || autodetect()).toLowerCase();
  const model = process.env.LLM_MODEL || DEFAULT_MODELS[provider] || '';
  const known = DEFAULT_PRICES[`${provider}:${model}`] || [0, 0];
  return {
    provider,
    model,
    priceIn: Number(process.env.PRICE_INPUT_PER_MTOK || known[0]),
    priceOut: Number(process.env.PRICE_OUTPUT_PER_MTOK || known[1]),
  };
}

function autodetect() {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return 'rules';
}

async function postJson(url, headers, body, timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 120000)) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
      err.status = res.status;
      err.retryAfterSec = Number(res.headers.get('retry-after')) || null;
      throw err;
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

async function callAnthropic({ system, user, schema }, model) {
  const data = await postJson(
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    // Current Claude models reject non-default temperature; thinking is adaptive, so leave room for it.
    { model, max_tokens: 16000, system, messages: [{ role: 'user', content: user }], ...(schema ? { output_config: { format: { type: 'json_schema', schema } } } : {}) }
  );
  if (data.stop_reason === 'max_tokens') throw new Error('Ответ модели обрезан (max_tokens)');
  if (data.stop_reason === 'refusal') throw new Error('Модель отказалась оценивать диалог');
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, usage: { input: data.usage?.input_tokens || 0, output: data.usage?.output_tokens || 0 } };
}

// OpenAI-compatible chat completions (OpenAI, Groq, Ollama, vLLM).
async function chatCompletions(base, key, { system, user, schema }, model) {
  const body = (format) => ({
    model,
    temperature: 0,
    response_format: format,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  let data;
  try {
    data = await postJson(`${base}/chat/completions`, { authorization: `Bearer ${key}` },
      body(schema ? { type: 'json_schema', json_schema: { name: 'evaluation', strict: true, schema } } : { type: 'json_object' }));
  } catch (e) {
    // Some hosted models do not support strict JSON schemas: fall back to plain JSON mode.
    if (!(schema && e.status === 400)) throw e;
    data = await postJson(`${base}/chat/completions`, { authorization: `Bearer ${key}` }, body({ type: 'json_object' }));
  }
  return {
    text: data.choices?.[0]?.message?.content || '',
    usage: { input: data.usage?.prompt_tokens || 0, output: data.usage?.completion_tokens || 0 },
  };
}

const callOpenAI = (prompt, model) => chatCompletions(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', process.env.OPENAI_API_KEY, prompt, model);
const callGroq = (prompt, model) => chatCompletions(process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1', process.env.GROQ_API_KEY, prompt, model);

async function callGemini({ system, user }, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const data = await postJson(url, {}, {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  });
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  return {
    text,
    usage: { input: data.usageMetadata?.promptTokenCount || 0, output: data.usageMetadata?.candidatesTokenCount || 0 },
  };
}

function isLocal() {
  return config().provider === 'openai' && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(process.env.OPENAI_BASE_URL || '');
}

function extractJson(text) {
  if (!text) throw new Error('Пустой ответ модели');
  const cleaned = text.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('В ответе модели нет JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function complete(prompt, { model } = {}) {
  const cfg = config();
  const fn = { anthropic: callAnthropic, openai: callOpenAI, groq: callGroq, gemini: callGemini }[cfg.provider];
  if (!fn) throw new Error(`Неизвестный LLM_PROVIDER: ${cfg.provider}`);
  let lastErr;
  // A serverless function has a hard time limit, so it must not sit out a long rate-limit wait:
  // past this budget the 429 goes back to the caller, which retries later.
  const started = Date.now();
  const waitBudgetMs = Number(process.env.LLM_MAX_WAIT_SEC || (process.env.VERCEL ? 25 : 300)) * 1000;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fn(prompt, model || cfg.model);
      const json = extractJson(r.text);
      const cost = (r.usage.input * cfg.priceIn + r.usage.output * cfg.priceOut) / 1e6;
      // A model served locally (Ollama, vLLM) costs nothing per call.
      const costUsd = isLocal() ? 0 : cfg.priceIn || cfg.priceOut ? cost : null;
      return { json, usage: r.usage, cost_usd: costUsd, model: model || cfg.model, provider: cfg.provider, local: isLocal() };
    } catch (e) {
      lastErr = e;
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) break; // bad request / auth: retrying will not help
      // Rate limits (free Groq tier): wait as long as the API asks, capped.
      const waitMs = e.status === 429 ? Math.min((e.retryAfterSec || 10) * 1000, 60000) : 1500 * (attempt + 1);
      if (e.status === 429 && Date.now() - started + waitMs > waitBudgetMs) break;
      await new Promise((res) => setTimeout(res, waitMs));
    }
  }
  throw lastErr;
}

module.exports = { complete, config, extractJson, isLocal };
