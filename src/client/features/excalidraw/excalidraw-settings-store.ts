import { create } from 'zustand';
import type { AIConnectionTestResult, AIProviderConfig } from '../../lib/ai/types';
import { testAIConnection } from '../../lib/ai/stream-client';

export interface ExcalidrawSettingsState {
  folder: string;
  templateFilePath: string;
  scriptFolderPath: string;
  showReleaseNotes: boolean;
  compress: boolean;

  autoSaveIntervalMs: number;
  drawingFilenamePrefix: string;
  drawingFilenameDateFormat: string;
  useExcalidrawExtension: boolean;
  drawingEmbedPrefixWithFilename: boolean;

  aiEnabled: boolean;
  aiProviders: Record<string, AIProviderConfig>;
  aiDefaultProvider: string;
  aiDefaultTextModel: string;
  aiDefaultImageModel: string;
  aiMaxOutgoingTokens: number;
  aiMaxResponseTokens: number;
  aiVerboseLogging: boolean;

  matchTheme: boolean;
  dynamicStyling: boolean;
  leftHandedMode: boolean;
  defaultMode: 'normal' | 'zen' | 'view';
  gridModeEnabled: boolean;
  gridSize: number;
  gridSnap: boolean;
  disableDoubleClickTextEditing: boolean;
  zenModeEnabled: boolean;
  viewModeEnabled: boolean;

  linkBrackets: boolean;
  linkPrefix: string;
  urlPrefix: string;
  linkIndicatorOpacity: number;
  allowCtrlClick: boolean;
  openInAdjacentPane: boolean;
  parseTODO: boolean;
  todo: string;
  done: string;

  defaultCardEmbedMode: 'interactive' | 'image';
  embedCardHeight: number;
  embedMatchTheme: boolean;
  exportWithBackground: boolean;
  pngExportScale: number;
  exportPaddingSVG: number;

  mdCardWidth: number;
  mdCardHeight: number;
  markdownNodeOneClickEditing: boolean;
  pdfImportScale: number;
  pdfBorderBox: boolean;

  numberOfCustomPens: number;
  defaultStrokeWidth: number;
  defaultFillStyle: 'transparent' | 'semi' | 'solid' | 'cross-hatch';
  defaultRoughness: number;

  defaultFontFamily: number;
  defaultFontSize: number;
  loadChineseFonts: boolean;

  latexBoilerplate: string;
  latexFontSize: number;
  loadPropertySuggestions: boolean;
  experimentalFileTag: string;

  enableOnloadScripts: boolean;
  enableSaveHooks: boolean;
  startupScriptPath: string;

  compatibilityMode: boolean;
  embedMarkdownCommentLinks: boolean;
  syncExcalidraw: boolean;

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
    apiKey: '',
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
  folder: '',
  templateFilePath: '',
  scriptFolderPath: '',
  showReleaseNotes: true,
  compress: true,

  autoSaveIntervalMs: 600,
  drawingFilenamePrefix: 'Drawing ',
  drawingFilenameDateFormat: 'YYYY-MM-DD HH.mm.ss',
  useExcalidrawExtension: true,
  drawingEmbedPrefixWithFilename: false,

  aiEnabled: true,
  aiProviders: DEFAULT_PROVIDERS,
  aiDefaultProvider: 'deepseek',
  aiDefaultTextModel: 'deepseek-flash',
  aiDefaultImageModel: 'deepseek-flash',
  aiMaxOutgoingTokens: 0,
  aiMaxResponseTokens: 0,
  aiVerboseLogging: false,

  matchTheme: true,
  dynamicStyling: true,
  leftHandedMode: false,
  defaultMode: 'normal' as const,
  gridModeEnabled: false,
  gridSize: 20,
  gridSnap: false,
  disableDoubleClickTextEditing: false,
  zenModeEnabled: false,
  viewModeEnabled: false,

  linkBrackets: false,
  linkPrefix: '',
  urlPrefix: '',
  linkIndicatorOpacity: 1.0,
  allowCtrlClick: true,
  openInAdjacentPane: true,
  parseTODO: false,
  todo: '- [ ] ',
  done: '- [x] ',

  defaultCardEmbedMode: 'interactive' as const,
  embedCardHeight: 520,
  embedMatchTheme: true,
  exportWithBackground: true,
  pngExportScale: 2,
  exportPaddingSVG: 10,

  mdCardWidth: 280,
  mdCardHeight: 160,
  markdownNodeOneClickEditing: true,
  pdfImportScale: 1.0,
  pdfBorderBox: true,

  numberOfCustomPens: 0,
  defaultStrokeWidth: 1,
  defaultFillStyle: 'transparent' as const,
  defaultRoughness: 1,

  defaultFontFamily: 1,
  defaultFontSize: 20,
  loadChineseFonts: true,

  latexBoilerplate: '\\begin{aligned}\n\\end{aligned}',
  latexFontSize: 24,
  loadPropertySuggestions: true,
  experimentalFileTag: '#excalidraw',

  enableOnloadScripts: false,
  enableSaveHooks: false,
  startupScriptPath: '',

  compatibilityMode: false,
  embedMarkdownCommentLinks: true,
  syncExcalidraw: false,
};

function applySettingsSideEffects(state: { embedCardHeight?: number; loadChineseFonts?: boolean }): void {
  if (typeof document !== 'undefined') {
    if (state.embedCardHeight) {
      document.documentElement.style.setProperty('--excalidraw-embed-height', `${state.embedCardHeight}px`);
    }
    if (state.loadChineseFonts !== undefined) {
      document.documentElement.classList.toggle('excalidraw-cjk-fonts', state.loadChineseFonts);
    }
  }
}

function loadInitialSettings(): typeof DEFAULT_SETTINGS {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      applySettingsSideEffects(DEFAULT_SETTINGS);
      return DEFAULT_SETTINGS;
    }
    const parsed = JSON.parse(raw);
    const merged = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      aiProviders: {
        ...DEFAULT_PROVIDERS,
        ...(parsed.aiProviders || {}),
      },
    };
    applySettingsSideEffects(merged);
    return merged;
  } catch {
    applySettingsSideEffects(DEFAULT_SETTINGS);
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
      applySettingsSideEffects(next);
      persistSettings(next);
      return next;
    });
  },

  resetSettings: () => {
    set(() => {
      applySettingsSideEffects(DEFAULT_SETTINGS);
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
