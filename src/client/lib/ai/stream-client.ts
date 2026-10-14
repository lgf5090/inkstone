import type {
  AIConnectionTestResult,
  AIMessage,
  AIProviderConfig,
  AIStreamOptions,
  AIUsageInfo,
} from './types';

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function buildEndpoint(config: AIProviderConfig): string {
  const base = normalizeBaseUrl(config.baseURL || 'https://api.deepseek.com');
  if (config.provider === 'anthropic') {
    return `${base}/v1/messages`;
  }
  if (base.endsWith('/chat/completions')) {
    return base;
  }
  return `${base}/chat/completions`;
}

export function extractCodeBlock(content: string, language = 'mermaid'): string {
  const regex = new RegExp(`\`\`\`(?:${language})?\\s*\\n?([\\s\\S]*?)\`\`\``, 'i');
  const match = content.match(regex);
  if (match?.[1]?.trim()) {
    return match[1].trim();
  }
  if (content.includes('graph ') || content.includes('flowchart ') || content.includes('sequenceDiagram')) {
    return content.trim();
  }
  return '';
}

async function callAIEndpoint(
  endpoint: string,
  headers: Record<string, string>,
  payload: unknown,
  signal?: AbortSignal,
  useProxy = true,
  proxyUrl = '/api/ai/proxy',
): Promise<Response> {
  if (useProxy) {
    try {
      const res = await fetch(proxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Inkstone-Client': '1',
        },
        body: JSON.stringify({
          endpoint,
          headers,
          body: payload,
        }),
        signal,
      });
      if (res.status !== 404) {
        return res;
      }
    } catch (err: unknown) {
      if (signal?.aborted) throw err;
    }
  }

  return await fetch(endpoint, {
    method: 'POST',
    headers,
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    signal,
  });
}

export async function testAIConnection(
  config: AIProviderConfig,
  model = 'deepseek-flash',
  options: { useProxy?: boolean; proxyUrl?: string; signal?: AbortSignal } = {},
): Promise<AIConnectionTestResult> {
  const startTime = Date.now();
  const endpoint = buildEndpoint(config);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.apiKey) {
      if (config.provider === 'anthropic') {
        headers['x-api-key'] = config.apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }
    }

    const payload = {
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 5,
    };

    const res = await callAIEndpoint(
      endpoint,
      headers,
      payload,
      options.signal,
      options.useProxy !== false,
      options.proxyUrl || '/api/ai/proxy',
    );

    const latencyMs = Date.now() - startTime;
    if (!res.ok) {
      let errText = `HTTP ${res.status} ${res.statusText}`;
      // Reading the body only buys a better sentence about a failure that is already certain: `errText`
      // above is the answer the caller gets when the server sent no JSON, and the `{ ok: false }` below
      // reports the failure either way. Re-throwing here would replace a status the reader can act on with
      // a parse error.
      try {
        const errJson = await res.json();
        if (errJson?.error?.message) {
          errText = errJson.error.message;
        }
      } catch {
      }
      return { ok: false, latencyMs, model, error: errText };
    }

    return { ok: true, latencyMs, model };
  } catch (err: unknown) {
    const latencyMs = Date.now() - startTime;
    return {
      ok: false,
      latencyMs,
      model,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function streamChatCompletion(
  messages: AIMessage[],
  config: AIProviderConfig,
  options: AIStreamOptions = {},
): Promise<{ content: string; reasoning: string; usage?: AIUsageInfo }> {
  const endpoint = buildEndpoint(config);
  const model = options.model || 'deepseek-flash';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.apiKey) {
    if (config.provider === 'anthropic') {
      headers['x-api-key'] = config.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }
  }

  const formattedMessages: Array<{ role: string; content: string }> = [];
  if (options.systemPrompt) {
    formattedMessages.push({ role: 'system', content: options.systemPrompt });
  }
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'user' || m.role === 'assistant') {
      formattedMessages.push({ role: m.role, content: m.content });
    }
  }

  const requestBody: Record<string, unknown> = {
    model,
    messages: formattedMessages,
    stream: true,
  };
  if (options.temperature !== undefined) requestBody.temperature = options.temperature;
  if (options.maxTokens) requestBody.max_tokens = options.maxTokens;

  let res: Response;
  try {
    res = await callAIEndpoint(
      endpoint,
      headers,
      requestBody,
      options.signal,
      options.useProxy !== false,
      options.proxyUrl || '/api/ai/proxy',
    );
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    options.onError?.(e);
    throw e;
  }

  if (!res.ok) {
    let errMessage = `Request failed with HTTP ${res.status}`;
    // As above: the status sentence is the report, the body is only ever a refinement of it, and the
    // error thrown below reaches `onError` either way.
    try {
      const errJson = await res.json();
      if (errJson?.error?.message) {
        errMessage = errJson.error.message;
      }
    } catch {
    }
    const e = new Error(errMessage);
    options.onError?.(e);
    throw e;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    const e = new Error('ReadableStream not supported on response body');
    options.onError?.(e);
    throw e;
  }

  const decoder = new TextDecoder();
  let accumulatedContent = '';
  let accumulatedReasoning = '';
  let buffer = '';
  let usage: AIUsageInfo | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') break;

        try {
          const json = JSON.parse(dataStr);
          if (json.usage) {
            usage = {
              promptTokens: json.usage.prompt_tokens,
              completionTokens: json.usage.completion_tokens,
              reasoningTokens: json.usage.completion_tokens_details?.reasoning_tokens,
              totalTokens: json.usage.total_tokens,
            };
          }

          const choice = json.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;
          if (!delta) continue;

          if (delta.reasoning_content) {
            accumulatedReasoning += delta.reasoning_content;
            options.onReasoningChunk?.(delta.reasoning_content, accumulatedReasoning);
          }

          if (delta.content) {
            accumulatedContent += delta.content;
            options.onChunk?.(delta.content, accumulatedContent);
          }
        } catch {
        }
      }
    }

    if (accumulatedContent.includes('<think>')) {
      const thinkMatch = accumulatedContent.match(/<think>([\s\S]*?)(?:<\/think>|$)/);
      if (thinkMatch) {
        if (!accumulatedReasoning) {
          accumulatedReasoning = thinkMatch[1].trim();
        }
        accumulatedContent = accumulatedContent.replace(/<think>[\s\S]*?(?:<\/think>|$)/, '').trim();
      }
    }

    const result = { content: accumulatedContent, reasoning: accumulatedReasoning, usage };
    options.onFinish?.(result);
    return result;
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    options.onError?.(e);
    throw e;
  }
}
