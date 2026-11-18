// Calls LLM APIs straight from the browser and streams the reply text back.
// Claude, OpenAI and Gemini use their own APIs; MiniMax, DeepSeek and the rest
// go through the OpenAI-compatible /chat/completions format. Every API here
// allows cross-origin requests, so no server sits in between: the API key goes
// from this page to the provider only.

const CLAUDE_VERSION = '2026-10-21';
// Claude models that take output_config.effort.
const CLAUDE_EFFORT = /^claude-(opus-(4-[5-9]|[5-9])|sonnet-(4-[6-9]|[5-9])|haiku-[5-9]|fable|mythos)/;
// Claude models whose safety-classifier refusals can be retried server-side on another model.
const CLAUDE_FALLBACK = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

const trimSlash = url => url.replace(/\/+$/, '');

/**
 * A provider that speaks the OpenAI Chat Completions format at `baseUrl`.
 * `tune(model)` returns provider-specific request fields that keep translation
 * fast; they are dropped automatically if the API rejects them.
 */
function compatible({ label, name = label, baseUrl = '', keyUrl = '', models = [], tune }) {
  return {
    label,
    name, // used in messages
    group: 'compatible',
    baseUrl,
    keyPlaceholder: 'API 키',
    keyUrl,
    models,
    thinkTags: true,

    request({ apiKey, model, baseUrl, system, prompt, tuned }) {
      const body = {
        model,
        stream: true,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        ...(tuned && tune?.(model)),
      };
      return {
        url: `${trimSlash(baseUrl)}/chat/completions`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body,
      };
    },

    parseEvent(msg) {
      // MiniMax reports errors in base_resp, sometimes inside an HTTP 200 reply.
      if (msg.base_resp?.status_code) throw baseRespError(name, msg.base_resp);
      if (msg.error) throw new ApiError(`${name} 오류: ${msg.error.message || JSON.stringify(msg.error)}`, { retry: true });
      const choice = msg.choices?.[0];
      if (choice?.finish_reason === 'content_filter') {
        throw new ApiError(`${name}의 콘텐츠 필터가 응답을 중단했습니다.`, { content: true });
      }
      // Reasoning arrives in reasoning_content and is skipped; a reply that
      // ignored stream: true has message instead of delta.
      return choice?.delta?.content || choice?.message?.content || '';
    },

    modelsRequest: (apiKey, baseUrl) => ({ url: `${trimSlash(baseUrl)}/models`, headers: { authorization: `Bearer ${apiKey}` } }),
    parseModels: json => (json.data || []).map(m => m.id).filter(Boolean),
  };
}

function baseRespError(label, { status_code: code, status_msg: message = '' }) {
  const detail = `${label} 오류 ${code}: ${message}`;
  if (code === 1004) return new ApiError(`API 키가 올바르지 않습니다. 설정에서 키를 확인하세요. (${detail})`, { fatal: true });
  if (code === 1008) return new ApiError(`계정 잔액이 부족합니다. (${detail})`, { fatal: true });
  if (code === 2013) return new ApiError(`요청 형식 오류, invalid params (${detail})`, { fatal: true, status: 400 });
  if (code === 1027) return new ApiError(`민감한 내용으로 판단되어 응답이 거절되었습니다. (${detail})`, { content: true });
  return new ApiError(detail, { retry: true });
}

export const PROVIDERS = {
  anthropic: {
    label: 'Claude',
    group: 'main',
    keyPlaceholder: 'sk-ant-…',
    keyUrl: 'https://platform.claude.com/settings/keys',
    models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'],

    request({ apiKey, model, system, prompt, tuned }) {
      const headers = {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': CLAUDE_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      };
      const body = { model, max_tokens: 16000, stream: true, system, messages: [{ role: 'user', content: prompt }] };
      if (tuned && CLAUDE_EFFORT.test(model)) body.output_config = { effort: 'low' }; // translation needs little thinking
      if (tuned && CLAUDE_FALLBACK.has(model)) {
        headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
        body.fallbacks = 'default';
      }
      return { url: 'https://api.anthropic.com/v1/messages', headers, body };
    },

    // Thinking deltas and the `fallback` marker block carry no text and are skipped.
    // After a fallback the stream simply continues, so the text deltas still join up.
    parseEvent(msg) {
      if (msg.type === 'content_block_delta' && msg.delta?.type === 'text_delta') return msg.delta.text;
      if (msg.type === 'message_delta' && msg.delta?.stop_reason === 'refusal') {
        const category = msg.delta.stop_details?.category;
        throw new ApiError(`모델이 이 부분의 번역을 거절했습니다${category ? ` (${category})` : ''}.`, { content: true });
      }
      if (msg.type === 'error') throw new ApiError(msg.error?.message || 'Claude API 오류', { retry: true });
      return '';
    },

    modelsRequest(apiKey) {
      return {
        url: 'https://api.anthropic.com/v1/models?limit=100',
        headers: { 'x-api-key': apiKey, 'anthropic-version': CLAUDE_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' },
      };
    },
    parseModels: json => json.data.map(m => m.id),
  },

  openai: {
    label: 'OpenAI',
    group: 'main',
    keyPlaceholder: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.2-sol', 'gpt-6.2-astra'],

    request({ apiKey, model, system, prompt, tuned }) {
      const body = { model, instructions: system, input: prompt, stream: true, store: false };
      // Luna and Terra can skip reasoning entirely; the larger models go no lower than low.
      if (tuned && /^(gpt-[5-9]|o\d)/.test(model)) body.reasoning = { effort: /luna|terra/.test(model) ? 'none' : 'low' };
      return {
        url: 'https://api.openai.com/v1/responses',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body,
      };
    },

    parseEvent(msg) {
      switch (msg.type) {
        case 'response.output_text.delta':
          return msg.delta;
        case 'response.failed':
          throw new ApiError(msg.response?.error?.message || 'OpenAI 응답이 실패했습니다.', { retry: true });
        case 'response.incomplete':
          // Running out of output tokens leaves some paragraphs untranslated; they get retried.
          if (msg.response?.incomplete_details?.reason === 'content_filter') {
            throw new ApiError('OpenAI가 콘텐츠 필터로 응답을 중단했습니다.', { content: true });
          }
          return '';
        case 'error':
          throw new ApiError(msg.message || msg.error?.message || 'OpenAI API 오류', { retry: true });
        default:
          return '';
      }
    },

    modelsRequest: apiKey => ({ url: 'https://api.openai.com/v1/models', headers: { authorization: `Bearer ${apiKey}` } }),
    parseModels: json => json.data.map(m => m.id)
      .filter(id => /^(gpt|o\d|chatgpt)/.test(id) && !/audio|realtime|tts|transcribe|image|search|embedding|instruct/.test(id)),
  },

  gemini: {
    label: 'Gemini',
    group: 'main',
    keyPlaceholder: 'AIza…',
    keyUrl: 'https://aistudio.google.com/apikey',
    models: ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-4-hydrogen', 'gemini-4-argon'],

    request({ apiKey, model, system, prompt, tuned }) {
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      };
      // Flash-Lite models take "minimal" (near-off thinking); the others go no lower than "low".
      if (tuned && /^gemini-([3-9]|\d\d)/.test(model)) {
        body.generationConfig = { thinkingConfig: { thinkingLevel: /lite/.test(model) ? 'minimal' : 'low' } };
      }
      const name = encodeURIComponent(model.replace(/^models\//, ''));
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${name}:streamGenerateContent?alt=sse`,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body,
      };
    },

    parseEvent(msg) {
      if (msg.error) throw new ApiError(msg.error.message || 'Gemini API 오류', { retry: true });
      if (msg.promptFeedback?.blockReason) {
        throw new ApiError(`Gemini가 요청을 차단했습니다 (${msg.promptFeedback.blockReason}).`, { content: true });
      }
      const candidate = msg.candidates?.[0];
      const text = (candidate?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
      const reason = candidate?.finishReason;
      if (!text && reason && !['STOP', 'MAX_TOKENS', 'FINISH_REASON_UNSPECIFIED'].includes(reason)) {
        throw new ApiError(`Gemini가 응답을 중단했습니다 (${reason}).`, { content: true });
      }
      return text;
    },

    modelsRequest: apiKey => ({
      url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
      headers: { 'x-goog-api-key': apiKey },
    }),
    parseModels: json => json.models
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(id => id.startsWith('gemini')),
  },

  minimax: compatible({
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.io/v1',
    keyUrl: 'https://platform.minimax.io/console/keys',
    models: ['MiniMax-M3.1-Flash', 'MiniMax-M3'],
    // M3.1-Flash always thinks (at "max" by default); M3 can skip thinking.
    // reasoning_split keeps any thinking out of the reply text.
    tune: model => ({
      reasoning_split: true,
      ...(/flash/i.test(model) ? { reasoning_effort: 'low' } : model === 'MiniMax-M3' ? { thinking: { type: 'disabled' } } : {}),
    }),
  }),
  deepseek: compatible({
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
  }),
  qwen: compatible({
    label: 'Qwen (Alibaba Model Studio)',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://modelstudio.console.alibabacloud.com/',
  }),
  kimi: compatible({ label: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.ai/v1', keyUrl: 'https://platform.kimi.ai/console/api-keys' }),
  mistral: compatible({ label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys' }),
  xai: compatible({ label: 'Grok (xAI)', baseUrl: 'https://api.x.ai/v1', keyUrl: 'https://console.x.ai/' }),
  groq: compatible({ label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' }),
  openrouter: compatible({ label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/settings/keys' }),
  upstage: compatible({ label: 'Upstage Solar', baseUrl: 'https://api.upstage.ai/v1', keyUrl: 'https://console.upstage.ai/api-keys' }),
  together: compatible({ label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', keyUrl: 'https://api.together.ai/settings/api-keys' }),
  custom: compatible({ label: '직접 입력 (OpenAI 호환)', name: 'API' }),
};

export class ApiError extends Error {
  /**
   * retry: worth trying again later. fatal: every request will fail the same way (bad key, bad model).
   * content: the model or a filter declined this text; resending it as is won't help.
   */
  constructor(message, { retry = false, fatal = false, content = false, status = 0 } = {}) {
    super(message);
    this.retry = retry;
    this.fatal = fatal;
    this.content = content;
    this.status = status;
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(signal.reason);
  }, { once: true });
});

const connectError = (label, err) => new ApiError(
  `${label}에 연결하지 못했습니다 (${err.message}). API 주소가 맞는지, 그 API가 브라우저에서 바로 호출하는 것(CORS)을 허용하는지 확인하세요.`,
  { fatal: true },
);

/**
 * Sends one prompt and calls onText(chunk) as the reply streams in.
 * Rate limits and server errors are retried with backoff.
 * @returns {Promise<string>} the whole reply
 */
export async function streamCompletion({ provider, apiKey, model, baseUrl, system, prompt, signal, onText }) {
  const api = PROVIDERS[provider];
  let tuned = true;
  for (let attempt = 0; ; attempt++) {
    const req = api.request({ apiKey, model, baseUrl, system, prompt, tuned });
    let res;
    try {
      res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      // Failing twice in a row is usually a wrong address or an API that blocks browsers, not a blip.
      if (attempt >= 1) throw connectError(api.name ?? api.label, err);
      await sleep(2000, signal);
      continue;
    }

    let error;
    if (res.ok) {
      let delivered = false;
      try {
        return await readStream(res, api, chunk => {
          delivered = true;
          onText(chunk);
        });
      } catch (err) {
        // An error that arrives before any text (MiniMax sends some with HTTP 200) is handled like a failed request.
        if (delivered || !(err instanceof ApiError)) throw err;
        error = err;
      }
    } else {
      error = await toApiError(res, api);
    }
    // An older or newer model may not take the effort/thinking setting; send the plain request instead.
    if (res.status === 400 || error.status === 400) {
      if (tuned && /effort|thinking|reasoning|fallback|output_config|beta|param/i.test(error.message)) {
        tuned = false;
        continue;
      }
    }
    if (!error.retry || attempt >= 3) throw error;
    await sleep(2000 * 2 ** attempt, signal);
  }
}

async function readStream(res, api, onText) {
  const think = api.thinkTags ? new ThinkFilter() : null;
  let text = '';
  const deliver = chunk => {
    if (chunk) {
      text += chunk;
      onText(chunk);
    }
  };
  const emit = chunk => deliver(think && chunk ? think.push(chunk) : chunk);
  const handle = data => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return; // "[DONE]" and keep-alive comments
    }
    emit(api.parseEvent(msg));
  };

  if (/event-stream/i.test(res.headers.get('content-type') || '')) {
    for await (const data of sseData(res.body)) handle(data);
  } else {
    // Not a stream: an error sent with HTTP 200, a reply that ignored
    // stream: true, or a stream sent under the wrong content type.
    const raw = (await res.text()).trim();
    const events = raw.match(/^data:.*$/gm);
    if (events) events.forEach(line => handle(line.slice(5).trim()));
    else if (raw.startsWith('{')) handle(raw);
    else if (raw) throw new ApiError(`${api.name ?? api.label}에서 알 수 없는 응답이 왔습니다: ${raw.slice(0, 200)}`, { retry: true });
  }
  if (think) deliver(think.end());
  return text;
}

/** Yields the data payload of each server-sent event. */
async function* sseData(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let data = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split(/\r\n|\r|\n/);
    buffer = lines.pop();
    for (const line of lines) {
      if (line === '') {
        if (data.length) yield data.join('\n');
        data = [];
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
  if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
  if (data.length) yield data.join('\n');
}

/** Drops <think>…</think> sections that some models write into the reply text, even when a tag is split across chunks. */
class ThinkFilter {
  inside = false;
  pending = '';

  push(chunk) {
    let rest = this.pending + chunk;
    let out = '';
    this.pending = '';
    for (;;) {
      const tag = this.inside ? '</think>' : '<think>';
      const at = rest.indexOf(tag);
      if (at >= 0) {
        if (!this.inside) out += rest.slice(0, at);
        rest = rest.slice(at + tag.length);
        this.inside = !this.inside;
        continue;
      }
      // Hold back what could be the start of a tag until the next chunk shows.
      let keep = Math.min(tag.length - 1, rest.length);
      while (keep > 0 && !tag.startsWith(rest.slice(-keep))) keep--;
      if (!this.inside) out += rest.slice(0, rest.length - keep);
      this.pending = rest.slice(rest.length - keep);
      return out;
    }
  }

  end() {
    const out = this.inside ? '' : this.pending;
    this.pending = '';
    return out;
  }
}

async function toApiError(res, api) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      const err = Array.isArray(json) ? json[0]?.error : json.error;
      detail = err?.message || json.message || json.base_resp?.status_msg || text;
    } catch {
      detail = text;
    }
  } catch {
    // keep the status-based message
  }
  detail = String(detail).slice(0, 300);
  const name = api.name ?? api.label;
  const status = res.status;
  if (status === 401 || status === 403) {
    return new ApiError(`API 키가 올바르지 않거나 권한이 없습니다 (${name}). 설정에서 키를 확인하세요. (${detail})`, { fatal: true, status });
  }
  if (status === 404) {
    return new ApiError(`${name}: 모델이나 API 주소를 찾을 수 없습니다. 설정을 확인하세요. (${detail})`, { fatal: true, status });
  }
  if (status === 429) return new ApiError(`${name} 요청 한도를 넘었습니다. 잠시 후 다시 시도하세요. (${detail})`, { retry: true, status });
  if (status >= 500) return new ApiError(`${name} 서버 오류 (${status}): ${detail}`, { retry: true, status });
  return new ApiError(`${name} 요청 오류 (${status}): ${detail}`, { fatal: status === 400, status });
}

/** Model IDs the key can use, for the model picker. */
export async function listModels(provider, apiKey, baseUrl) {
  const api = PROVIDERS[provider];
  const { url, headers } = api.modelsRequest(apiKey, baseUrl);
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    throw connectError(api.name ?? api.label, err);
  }
  if (!res.ok) throw await toApiError(res, api);
  return api.parseModels(await res.json()).sort();
}
