// Calls Claude, OpenAI and Gemini straight from the browser and streams the
// reply text back. All three APIs allow cross-origin requests, so no server
// sits in between: the API key goes from this page to the provider only.

const CLAUDE_VERSION = '2026-10-21';
// Claude models that take output_config.effort.
const CLAUDE_EFFORT = /^claude-(opus-(4-[5-9]|[5-9])|sonnet-(4-[6-9]|[5-9])|haiku-[5-9]|fable|mythos)/;
// Claude models whose safety-classifier refusals can be retried server-side on another model.
const CLAUDE_FALLBACK = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export const PROVIDERS = {
  anthropic: {
    label: 'Claude',
    keyPlaceholder: 'sk-ant-…',
    keyUrl: 'https://platform.claude.com/settings/keys',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],

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
    keyPlaceholder: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: ['gpt-6.1-terra', 'gpt-6-luna', 'gpt-6.2-sol', 'gpt-6.2-astra'],

    request({ apiKey, model, system, prompt, tuned }) {
      const body = { model, instructions: system, input: prompt, stream: true, store: false };
      if (tuned && /^(gpt-[5-9]|o\d)/.test(model)) body.reasoning = { effort: 'low' };
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
    keyPlaceholder: 'AIza…',
    keyUrl: 'https://aistudio.google.com/apikey',
    models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-4-hydrogen', 'gemini-4-argon'],

    request({ apiKey, model, system, prompt, tuned }) {
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      };
      if (tuned && /^gemini-([3-9]|\d\d)/.test(model)) body.generationConfig = { thinkingConfig: { thinkingLevel: 'low' } };
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

/**
 * Sends one prompt and calls onText(chunk) as the reply streams in.
 * Rate limits and server errors are retried with backoff.
 * @returns {Promise<string>} the whole reply
 */
export async function streamCompletion({ provider, apiKey, model, system, prompt, signal, onText }) {
  const api = PROVIDERS[provider];
  let tuned = true;
  for (let attempt = 0; ; attempt++) {
    const req = api.request({ apiKey, model, system, prompt, tuned });
    let res;
    try {
      res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (attempt >= 3) throw new ApiError(`네트워크 오류: ${err.message}`, { retry: true });
      await sleep(2000 * 2 ** attempt, signal);
      continue;
    }
    if (res.ok) return readStream(res, api, onText);

    const error = await toApiError(res, provider);
    // An older or newer model may not take the effort/thinking setting; send the plain request instead.
    if (res.status === 400 && tuned && /effort|thinking|reasoning|fallback|output_config|beta/i.test(error.message)) {
      tuned = false;
      continue;
    }
    if (!error.retry || attempt >= 3) throw error;
    await sleep(2000 * 2 ** attempt, signal);
  }
}

async function readStream(res, api, onText) {
  let text = '';
  for await (const data of sseData(res.body)) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      continue; // "[DONE]" and keep-alive comments
    }
    const chunk = api.parseEvent(msg);
    if (chunk) {
      text += chunk;
      onText(chunk);
    }
  }
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

async function toApiError(res, provider) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      const err = Array.isArray(json) ? json[0]?.error : json.error;
      detail = err?.message || json.message || text;
    } catch {
      detail = text;
    }
  } catch {
    // keep the status-based message
  }
  detail = String(detail).slice(0, 300);
  const name = PROVIDERS[provider].label;
  const status = res.status;
  if (status === 401 || status === 403) {
    return new ApiError(`${name} API 키가 올바르지 않거나 권한이 없습니다. 설정에서 키를 확인하세요. (${detail})`, { fatal: true, status });
  }
  if (status === 404) return new ApiError(`모델을 찾을 수 없습니다. 설정에서 모델 이름을 확인하세요. (${detail})`, { fatal: true, status });
  if (status === 429) return new ApiError(`${name} 요청 한도를 넘었습니다. 잠시 후 다시 시도하세요. (${detail})`, { retry: true, status });
  if (status >= 500) return new ApiError(`${name} 서버 오류 (${status}): ${detail}`, { retry: true, status });
  return new ApiError(`${name} 요청 오류 (${status}): ${detail}`, { fatal: status === 400, status });
}

/** Model IDs the key can use, for the model picker. */
export async function listModels(provider, apiKey) {
  const api = PROVIDERS[provider];
  const { url, headers } = api.modelsRequest(apiKey);
  const res = await fetch(url, { headers });
  if (!res.ok) throw await toApiError(res, provider);
  return api.parseModels(await res.json()).sort();
}
