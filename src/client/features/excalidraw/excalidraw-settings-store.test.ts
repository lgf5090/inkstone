import { describe, expect, it, beforeEach } from 'vitest';
import { useExcalidrawSettingsStore } from './excalidraw-settings-store';

describe('excalidraw-settings-store', () => {
  beforeEach(() => {
    localStorage.clear();
    useExcalidrawSettingsStore.getState().resetSettings();
  });

  it('initializes with active DeepSeek settings and test account', () => {
    const state = useExcalidrawSettingsStore.getState();
    expect(state.aiEnabled).toBe(true);
    expect(state.aiDefaultProvider).toBe('deepseek');
    expect(state.aiDefaultTextModel).toBe('deepseek-flash');

    const deepseekConfig = state.aiProviders.deepseek;
    expect(deepseekConfig).toBeDefined();
    expect(deepseekConfig.baseURL).toBe('https://api.deepseek.com');
    expect(deepseekConfig.apiKey).toBe('***REMOVED***');
  });

  it('returns active AI configuration via getActiveAIConfig', () => {
    const { config, model } = useExcalidrawSettingsStore.getState().getActiveAIConfig();
    expect(config.provider).toBe('openai-compatible');
    expect(config.baseURL).toBe('https://api.deepseek.com');
    expect(model).toBe('deepseek-flash');
  });

  it('updates provider configuration and persists updates', () => {
    const currentProviders = useExcalidrawSettingsStore.getState().aiProviders;
    useExcalidrawSettingsStore.getState().updateSettings({
      aiProviders: {
        ...currentProviders,
        openai: {
          provider: 'openai',
          apiKey: 'sk-test-custom',
          baseURL: 'https://custom-gateway.io/v1',
        },
      },
    });

    const state = useExcalidrawSettingsStore.getState();
    expect(state.aiProviders.openai.apiKey).toBe('sk-test-custom');
    expect(state.aiProviders.openai.baseURL).toBe('https://custom-gateway.io/v1');
  });

  it('updates general and interface display settings', () => {
    useExcalidrawSettingsStore.getState().updateSettings({
      autoSaveIntervalMs: 1200,
      drawingFilenamePrefix: 'Diagram_',
      defaultCardEmbedMode: 'image',
      gridModeEnabled: true,
      leftHandedMode: true,
      linkIndicatorOpacity: 0.85,
    });

    const state = useExcalidrawSettingsStore.getState();
    expect(state.autoSaveIntervalMs).toBe(1200);
    expect(state.drawingFilenamePrefix).toBe('Diagram_');
    expect(state.defaultCardEmbedMode).toBe('image');
    expect(state.gridModeEnabled).toBe(true);
    expect(state.leftHandedMode).toBe(true);
    expect(state.linkIndicatorOpacity).toBe(0.85);
  });

  it('resets all defaults cleanly', () => {
    useExcalidrawSettingsStore.getState().updateSettings({
      aiEnabled: false,
      autoSaveIntervalMs: 5000,
    });
    expect(useExcalidrawSettingsStore.getState().aiEnabled).toBe(false);

    useExcalidrawSettingsStore.getState().resetSettings();
    const state = useExcalidrawSettingsStore.getState();
    expect(state.aiEnabled).toBe(true);
    expect(state.autoSaveIntervalMs).toBe(600);
  });
});
