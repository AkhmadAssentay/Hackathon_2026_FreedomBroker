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
  'groq:openai/gpt-oss-20b': [0.075, 0.3],
};

// Fallback models: each hosted model has its own rate-limit quota, so when one runs out (tokens per
// day / per minute, or a request is too large for it) the next one takes over. LLM_FALLBACK_MODELS
// overrides the list (comma-separated; empty string disables fallback).
const DEFAULT_FALLBACKS = { groq: ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b'] };
function fallbackModels(provider, primary) {
  const env = process.env.LLM_FALLBACK_MODELS;
  const list = env !== undefined ? env.split(',').map((x) => x.trim()).filter(Boolean) : DEFAULT_FALLBACKS[provider] || [];
  return list.filter((m) => m !== primary);
}
function priceFor(provider, model) {
  const known = DEFAULT_PRICES[`${provider}:${model}`];
  if (process.env.PRICE_INPUT_PER_MTOK || process.env.PRICE_OUTPUT_PER_MTOK) return [Number(process.env.PRICE_INPUT_PER_MTOK || 0), Number(process.env.PRICE_OUTPUT_PER_MTOK || 0)];
  return known || [0, 0];
}

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
  // gpt-oss models "think" before answering and those tokens count toward rate limits. The task is
  // already split into narrow questions, so low reasoning effort keeps quality and saves most of them.
  const effort = /gpt-oss/.test(model) ? process.env.LLM_REASONING_EFFORT || 'low' : null;
  // Qwen 3.x thinks in <think> blocks: keep them out of the answer (and out of the JSON).
  const hideReasoning = /qwen3/i.test(model);
  const body = (format) => ({
    model,
    temperature: 0,
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(hideReasoning ? { reasoning_format: 'hidden' } : {}),
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
    // cached input tokens do not count toward Groq rate limits and cost less
    usage: { input: data.usage?.prompt_tokens || 0, output: data.usage?.completion_tokens || 0, cached: data.usage?.prompt_tokens_details?.cached_tokens || 0 },
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

// Models known to have run out of quota, with the time they become usable again (per instance).
const exhausted = (globalThis.__cqaExhausted = globalThis.__cqaExhausted || new Map());

async function complete(prompt, { model } = {}) {
  const cfg = config();
  const fn = { anthropic: callAnthropic, openai: callOpenAI, groq: callGroq, gemini: callGemini }[cfg.provider];
  if (!fn) throw new Error(`Неизвестный LLM_PROVIDER: ${cfg.provider}`);
  // An explicit model (second-opinion jury) is used alone; otherwise the primary model, then fallbacks.
  const models = model ? [model] : [cfg.model, ...fallbackModels(cfg.provider, cfg.model)];
  // A serverless function has a hard time limit, so it must not sit out a long rate-limit wait:
  // past this budget the 429 goes back to the caller, which retries later.
  const started = Date.now();
  const waitBudgetMs = Number(process.env.LLM_MAX_WAIT_SEC || (process.env.VERCEL ? 25 : 300)) * 1000;
  let lastErr;
  let soonest = null; // earliest moment any model frees up, for the caller's retry hint
  const skipped = [];
  const reasons = []; // per-model reason, shown to the user when every model is unavailable
  for (const m of models) {
    const until = exhausted.get(m);
    if (until && until > Date.now() && models.length > 1) {
      skipped.push(m);
      soonest = Math.min(soonest ?? until, until);
      reasons.push(`${m}: лимит, освободится через ${Math.ceil((until - Date.now()) / 1000)} с`);
      continue;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fn(prompt, m);
        const json = extractJson(r.text);
        const [pIn, pOut] = priceFor(cfg.provider, m);
        const cached = r.usage.cached || 0;
        const cost = ((r.usage.input - cached) * pIn + cached * pIn * 0.5 + r.usage.output * pOut) / 1e6;
        // A model served locally (Ollama, vLLM) costs nothing per call.
        const costUsd = isLocal() ? 0 : pIn || pOut ? cost : null;
        exhausted.delete(m);
        return { json, usage: r.usage, cost_usd: costUsd, model: m, provider: cfg.provider, local: isLocal(), ...(m !== models[0] ? { fallback_from: models[0], skipped } : {}) };
      } catch (e) {
        lastErr = e;
        const waitMs = e.status === 429 ? Math.min((e.retryAfterSec || 10) * 1000, 60000) : 1500 * (attempt + 1);
        // Out of quota (long wait) or request too large for this model's limit: move on to the next model.
        const quotaGone = e.status === 413 || (e.status === 429 && (e.retryAfterSec || 0) * 1000 > waitBudgetMs);
        if (quotaGone) {
          reasons.push(`${m}: ${e.status === 413 ? 'запрос больше лимита модели' : `лимит, повтор через ${e.retryAfterSec} с`} (${String(e.message).replace(/^LLM HTTP \d+: /, '').slice(0, 160)})`);
          const freeAt = Date.now() + (e.retryAfterSec ? e.retryAfterSec * 1000 : 60000);
          exhausted.set(m, freeAt);
          soonest = Math.min(soonest ?? freeAt, freeAt);
          skipped.push(m);
          break;
        }
        if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) {
          // bad request / auth on this model: try the next one, report if none works
          reasons.push(`${m}: HTTP ${e.status} ${String(e.message).replace(/^LLM HTTP \d+: /, '').slice(0, 160)}`);
          break;
        }
        if (e.status === 429 && Date.now() - started + waitMs > waitBudgetMs) {
          reasons.push(`${m}: лимит в минуту, повтор через ${Math.ceil(waitMs / 1000)} с`);
          soonest = Math.min(soonest ?? Date.now() + waitMs, Date.now() + waitMs);
          break;
        }
        await new Promise((res) => setTimeout(res, waitMs));
      }
    }
  }
  // Every model is rate-limited right now: tell the caller when to come back, and why.
  if (soonest !== null) {
    throw Object.assign(new Error(`Все модели сейчас недоступны по лимиту: ${reasons.join('; ')}`), {
      status: 429,
      retryAfterSec: Math.max(5, Math.ceil((soonest - Date.now()) / 1000)),
    });
  }
  if (lastErr) throw Object.assign(new Error(reasons.length ? `Модель не ответила: ${reasons.join('; ')}` : lastErr.message), { status: lastErr.status });
  throw new Error('Модель не ответила');
}

module.exports = { complete, config, extractJson, isLocal };
