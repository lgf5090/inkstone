import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildEndpoint,
  extractCodeBlock,
  normalizeBaseUrl,
  streamChatCompletion,
  testAIConnection,
} from './stream-client';
import type { AIProviderConfig } from './types';

describe('stream-client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('normalizeBaseUrl & buildEndpoint', () => {
    it('normalizes base url by removing trailing slashes', () => {
      expect(normalizeBaseUrl('https://api.deepseek.com///')).toBe('https://api.deepseek.com');
      expect(normalizeBaseUrl('  https://api.openai.com/v1/  ')).toBe('https://api.openai.com/v1');
    });

    it('builds chat completions endpoint for deepseek and openai', () => {
      const deepseekConfig: AIProviderConfig = {
        provider: 'deepseek',
        baseURL: 'https://api.deepseek.com',
        apiKey: 'key',
      };
      expect(buildEndpoint(deepseekConfig)).toBe('https://api.deepseek.com/chat/completions');

      const openaiConfig: AIProviderConfig = {
        provider: 'openai',
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'key',
      };
      expect(buildEndpoint(openaiConfig)).toBe('https://api.openai.com/v1/chat/completions');
    });

    it('builds anthropic messages endpoint', () => {
      const anthropicConfig: AIProviderConfig = {
        provider: 'anthropic',
        baseURL: 'https://api.anthropic.com',
        apiKey: 'key',
      };
      expect(buildEndpoint(anthropicConfig)).toBe('https://api.anthropic.com/v1/messages');
    });

    it('keeps explicit /chat/completions endpoint if already present', () => {
      const customConfig: AIProviderConfig = {
        provider: 'openai-compatible',
        baseURL: 'https://custom.ai/v1/chat/completions',
        apiKey: 'key',
      };
      expect(buildEndpoint(customConfig)).toBe('https://custom.ai/v1/chat/completions');
    });
  });

  describe('extractCodeBlock', () => {
    it('extracts mermaid block from markdown code fence', () => {
      const markdown = 'Here is the diagram:\n```mermaid\ngraph TD\n  A --> B\n```\nDone!';
      expect(extractCodeBlock(markdown)).toBe('graph TD\n  A --> B');
    });

    it('extracts unlabelled code fence if language omitted', () => {
      const markdown = '```\ngraph TD\n  X --> Y\n```';
      expect(extractCodeBlock(markdown)).toBe('graph TD\n  X --> Y');
    });

    it('returns raw text if graph keyword found without fences', () => {
      const raw = 'graph LR\n  A --> B';
      expect(extractCodeBlock(raw)).toBe('graph LR\n  A --> B');
    });

    it('returns empty string if no diagram found', () => {
      expect(extractCodeBlock('Just some plain text without diagram')).toBe('');
    });
  });

  describe('testAIConnection', () => {
    it('returns ok: true when backend returns HTTP 200', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'pong' } }] }),
      } as any);

      const config: AIProviderConfig = {
        provider: 'deepseek',
        baseURL: 'https://api.deepseek.com',
        apiKey: 'test-key',
      };

      const result = await testAIConnection(config, 'deepseek-flash');
      expect(result.ok).toBe(true);
      expect(result.model).toBe('deepseek-flash');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('returns ok: false with error message on HTTP failure', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: { message: 'Invalid API Key' } }),
      } as any);

      const config: AIProviderConfig = {
        provider: 'deepseek',
        baseURL: 'https://api.deepseek.com',
        apiKey: 'bad-key',
      };

      const result = await testAIConnection(config, 'deepseek-flash');
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Invalid API Key');
    });
  });

  describe('streamChatCompletion', () => {
    it('handles streaming chunks including reasoning_content and token usage', async () => {
      const sseChunks = [
        'data: {"choices":[{"delta":{"reasoning_content":"Thinking about diagram..."}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"```mermaid\\ngraph TD\\n"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"  A --> B\\n```"}}],"usage":{"total_tokens":42}}\n\n',
        'data: [DONE]\n\n',
      ];

      const encoder = new TextEncoder();
      let index = 0;
      const stream = new ReadableStream({
        pull(controller) {
          if (index < sseChunks.length) {
            controller.enqueue(encoder.encode(sseChunks[index++]));
          } else {
            controller.close();
          }
        },
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: stream,
      } as any);

      const config: AIProviderConfig = {
        provider: 'deepseek',
        baseURL: 'https://api.deepseek.com',
        apiKey: 'key',
      };

      const reasoningChunks: string[] = [];
      const contentChunks: string[] = [];

      const result = await streamChatCompletion(
        [{ id: '1', role: 'user', content: 'Draw a flowchart' }],
        config,
        {
          model: 'deepseek-flash',
          onReasoningChunk: (chunk) => reasoningChunks.push(chunk),
          onChunk: (chunk) => contentChunks.push(chunk),
        },
      );

      expect(reasoningChunks).toContain('Thinking about diagram...');
      expect(result.reasoning).toBe('Thinking about diagram...');
      expect(result.content).toBe('```mermaid\ngraph TD\n  A --> B\n```');
      expect(result.usage?.totalTokens).toBe(42);
    });

    it('extracts <think> tags from content if present', async () => {
      const sseChunks = [
        'data: {"choices":[{"delta":{"content":"<think>Internal deliberation</think>```mermaid\\ngraph LR\\n  A-->B\\n```"}}]}\n\n',
        'data: [DONE]\n\n',
      ];

      const encoder = new TextEncoder();
      let index = 0;
      const stream = new ReadableStream({
        pull(controller) {
          if (index < sseChunks.length) {
            controller.enqueue(encoder.encode(sseChunks[index++]));
          } else {
            controller.close();
          }
        },
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: stream,
      } as any);

      const config: AIProviderConfig = {
        provider: 'deepseek',
        baseURL: 'https://api.deepseek.com',
        apiKey: 'key',
      };

      const result = await streamChatCompletion(
        [{ id: '1', role: 'user', content: 'test' }],
        config,
      );

      expect(result.reasoning).toBe('Internal deliberation');
      expect(result.content).toBe('```mermaid\ngraph LR\n  A-->B\n```');
    });

    it('falls back to direct endpoint if proxy returns 404', async () => {
      const calls: string[] = [];
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        calls.push(url);
        if (url === '/api/ai/proxy') {
          return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'direct-pong' } }] }),
        });
      }) as any;

      const config: AIProviderConfig = {
        provider: 'deepseek',
        baseURL: 'https://api.deepseek.com',
        apiKey: 'key',
      };

      const result = await testAIConnection(config, 'deepseek-flash');
      expect(result.ok).toBe(true);
      expect(calls).toEqual(['/api/ai/proxy', 'https://api.deepseek.com/chat/completions']);
    });
  });
});

