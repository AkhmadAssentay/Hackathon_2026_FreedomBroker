'use strict';
// Provider-agnostic LLM call. Zero dependencies: uses global fetch (Node 18+).
// Provider is chosen by LLM_PROVIDER = anthropic | openai | gemini | rules.

const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-4.1-mini',
  gemini: 'gemini-2.5-flash',
};

function config() {
  const provider = (process.env.LLM_PROVIDER || autodetect()).toLowerCase();
  const model = process.env.LLM_MODEL || DEFAULT_MODELS[provider] || '';
  return {
    provider,
    model,
    // Prices in USD per 1M tokens — set them in .env to get a per-evaluation cost estimate.
    priceIn: Number(process.env.PRICE_INPUT_PER_MTOK || 0),
    priceOut: Number(process.env.PRICE_OUTPUT_PER_MTOK || 0),
  };
}

function autodetect() {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return 'rules';
}

async function postJson(url, headers, body, timeoutMs = 120000) {
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
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

async function callAnthropic({ system, user }, model) {
  const data = await postJson(
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    { model, max_tokens: 4000, temperature: 0, system, messages: [{ role: 'user', content: user }] }
  );
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, usage: { input: data.usage?.input_tokens || 0, output: data.usage?.output_tokens || 0 } };
}

async function callOpenAI({ system, user }, model) {
  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const data = await postJson(
    `${base}/chat/completions`,
    { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    {
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }
  );
  return {
    text: data.choices?.[0]?.message?.content || '',
    usage: { input: data.usage?.prompt_tokens || 0, output: data.usage?.completion_tokens || 0 },
  };
}

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

function extractJson(text) {
  if (!text) throw new Error('Пустой ответ модели');
  const cleaned = text.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('В ответе модели нет JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function complete(prompt) {
  const cfg = config();
  const fn = { anthropic: callAnthropic, openai: callOpenAI, gemini: callGemini }[cfg.provider];
  if (!fn) throw new Error(`Неизвестный LLM_PROVIDER: ${cfg.provider}`);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fn(prompt, cfg.model);
      const json = extractJson(r.text);
      const cost = (r.usage.input * cfg.priceIn + r.usage.output * cfg.priceOut) / 1e6;
      return { json, usage: r.usage, cost_usd: cfg.priceIn || cfg.priceOut ? cost : null, model: cfg.model, provider: cfg.provider };
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

module.exports = { complete, config, extractJson };
