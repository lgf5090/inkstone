import { create } from 'zustand';
import type { AIConnectionTestResult, AIProviderConfig } from '../../lib/ai/types';
import { testAIConnection } from '../../lib/ai/stream-client';

export interface ExcalidrawSettingsState {
  aiEnabled: boolean;
  aiProviders: Record<string, AIProviderConfig>;
  aiDefaultProvider: string;
  aiDefaultTextModel: string;
  aiDefaultImageModel: string;
  aiMaxOutgoingTokens: number;
  aiMaxResponseTokens: number;

  linkBrackets: boolean;
  linkPrefix: string;
  urlPrefix: string;
  linkIndicatorOpacity: number;

  autoSaveIntervalMs: number;
  drawingFilenamePrefix: string;
  drawingFilenameDateFormat: string;
  defaultCardEmbedMode: 'interactive' | 'image';

  gridSize: number;
  gridModeEnabled: boolean;
  matchTheme: boolean;
  leftHandedMode: boolean;
  zenModeEnabled: boolean;
  viewModeEnabled: boolean;

  updateSettings: (partial: Partial<Omit<ExcalidrawSettingsState, 'updateSettings' | 'resetSettings' | 'getActiveAIConfig' | 'testActiveConnection'>>) => void;
  resetSettings: () => void;
  getActiveAIConfig: () => { config: AIProviderConfig; model: string };
  testActiveConnection: () => Promise<AIConnectionTestResult>;
}

const STORAGE_KEY = 'inkstone:excalidraw-settings';

const DEFAULT_PROVIDERS: Record<string, AIProviderConfig> = {
  deepseek: {
    provider: 'openai-compatible',
    baseURL: 'https://api.deepseek.com',
    apiKey: '***REMOVED***',
  },
  openai: {
    provider: 'openai',
    baseURL: 'https://api.openai.com/v1',
    apiKey: '',
  },
  anthropic: {
    provider: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    apiKey: '',
  },
  google: {
    provider: 'google',
    baseURL: 'https://generativelanguage.googleapis.com',
    apiKey: '',
  },
  xai: {
    provider: 'xai',
    baseURL: 'https://api.x.ai/v1',
    apiKey: '',
  },
};

const DEFAULT_SETTINGS = {
  aiEnabled: true,
  aiProviders: DEFAULT_PROVIDERS,
  aiDefaultProvider: 'deepseek',
  aiDefaultTextModel: 'deepseek-flash',
  aiDefaultImageModel: 'deepseek-flash',
  aiMaxOutgoingTokens: 0,
  aiMaxResponseTokens: 0,

  linkBrackets: false,
  linkPrefix: '',
  urlPrefix: '',
  linkIndicatorOpacity: 1.0,

  autoSaveIntervalMs: 600,
  drawingFilenamePrefix: 'Drawing ',
  drawingFilenameDateFormat: 'YYYY-MM-DD HH.mm.ss',
  defaultCardEmbedMode: 'interactive' as const,

  gridSize: 20,
  gridModeEnabled: false,
  matchTheme: true,
  leftHandedMode: false,
  zenModeEnabled: false,
  viewModeEnabled: false,
};

function loadInitialSettings(): typeof DEFAULT_SETTINGS {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      aiProviders: {
        ...DEFAULT_PROVIDERS,
        ...(parsed.aiProviders || {}),
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persistSettings(data: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
  }
}

export const useExcalidrawSettings = create<ExcalidrawSettingsState>((set, get) => ({
  ...loadInitialSettings(),

  updateSettings: (partial) => {
    set((state) => {
      const next = { ...state, ...partial };
      persistSettings({
        aiEnabled: next.aiEnabled,
        aiProviders: next.aiProviders,
        aiDefaultProvider: next.aiDefaultProvider,
        aiDefaultTextModel: next.aiDefaultTextModel,
        aiDefaultImageModel: next.aiDefaultImageModel,
        aiMaxOutgoingTokens: next.aiMaxOutgoingTokens,
        aiMaxResponseTokens: next.aiMaxResponseTokens,
        linkBrackets: next.linkBrackets,
        linkPrefix: next.linkPrefix,
        urlPrefix: next.urlPrefix,
        linkIndicatorOpacity: next.linkIndicatorOpacity,
        autoSaveIntervalMs: next.autoSaveIntervalMs,
        drawingFilenamePrefix: next.drawingFilenamePrefix,
        drawingFilenameDateFormat: next.drawingFilenameDateFormat,
        defaultCardEmbedMode: next.defaultCardEmbedMode,
        gridSize: next.gridSize,
        gridModeEnabled: next.gridModeEnabled,
        matchTheme: next.matchTheme,
        leftHandedMode: next.leftHandedMode,
        zenModeEnabled: next.zenModeEnabled,
        viewModeEnabled: next.viewModeEnabled,
      });
      return next;
    });
  },

  resetSettings: () => {
    set(() => {
      persistSettings(DEFAULT_SETTINGS);
      return { ...DEFAULT_SETTINGS };
    });
  },

  getActiveAIConfig: () => {
    const s = get();
    const providerId = s.aiDefaultProvider || 'deepseek';
    const config = s.aiProviders[providerId] || DEFAULT_PROVIDERS.deepseek;
    return {
      config,
      model: s.aiDefaultTextModel || 'deepseek-flash',
    };
  },

  testActiveConnection: async () => {
    const { config, model } = get().getActiveAIConfig();
    return await testAIConnection(config, model);
  },
}));

export const useExcalidrawSettingsStore = useExcalidrawSettings;
