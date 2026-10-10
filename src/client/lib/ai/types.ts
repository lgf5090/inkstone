export type AIProvider =
  | 'deepseek'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'openai-compatible';

export interface AIMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  reasoningContent?: string;
  isThinking?: boolean;
  timestamp?: number;
  error?: string;
}

export interface AIProviderConfig {
  provider: AIProvider;
  apiKey: string;
  baseURL: string;
}

export interface AIStreamCallbacks {
  onChunk?: (chunk: string, fullContent: string) => void;
  onReasoningChunk?: (chunk: string, fullReasoning: string) => void;
  onFinish?: (res: { content: string; reasoning: string; usage?: AIUsageInfo }) => void;
  onError?: (err: Error) => void;
}

export interface AIStreamOptions extends AIStreamCallbacks {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  signal?: AbortSignal;
  useProxy?: boolean;
  proxyUrl?: string;
}

export interface AIUsageInfo {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface AIConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  model: string;
  error?: string;
}

export interface ExcalidrawAISettingsData {
  enabled: boolean;
  providers: Record<string, AIProviderConfig>;
  activeProviderId: string;
  textModel: string;
  imageModel: string;
  maxOutgoingTokens: number;
  maxResponseTokens: number;
}
