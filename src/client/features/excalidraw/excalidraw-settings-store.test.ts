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

  it('verifies all 12 categories default values and settings update', () => {
    const initial = useExcalidrawSettingsStore.getState();
    expect(initial.folder).toBe('');
    expect(initial.templateFilePath).toBe('');
    expect(initial.scriptFolderPath).toBe('');
    expect(initial.showReleaseNotes).toBe(true);
    expect(initial.compress).toBe(true);

    expect(initial.drawingFilenameDateFormat).toBe('YYYY-MM-DD HH.mm.ss');
    expect(initial.useExcalidrawExtension).toBe(true);
    expect(initial.drawingEmbedPrefixWithFilename).toBe(false);

    expect(initial.aiVerboseLogging).toBe(false);

    expect(initial.matchTheme).toBe(true);
    expect(initial.dynamicStyling).toBe(true);
    expect(initial.defaultMode).toBe('normal');
    expect(initial.gridSize).toBe(20);
    expect(initial.gridSnap).toBe(false);
    expect(initial.disableDoubleClickTextEditing).toBe(false);

    expect(initial.allowCtrlClick).toBe(true);
    expect(initial.openInAdjacentPane).toBe(true);
    expect(initial.parseTODO).toBe(false);
    expect(initial.todo).toBe('- [ ] ');
    expect(initial.done).toBe('- [x] ');

    expect(initial.embedCardHeight).toBe(520);
    expect(initial.embedMatchTheme).toBe(true);
    expect(initial.exportWithBackground).toBe(true);
    expect(initial.pngExportScale).toBe(2);
    expect(initial.exportPaddingSVG).toBe(10);

    expect(initial.mdCardWidth).toBe(280);
    expect(initial.mdCardHeight).toBe(160);
    expect(initial.markdownNodeOneClickEditing).toBe(true);
    expect(initial.pdfImportScale).toBe(1.0);
    expect(initial.pdfBorderBox).toBe(true);

    expect(initial.numberOfCustomPens).toBe(0);
    expect(initial.defaultStrokeWidth).toBe(1);
    expect(initial.defaultFillStyle).toBe('transparent');
    expect(initial.defaultRoughness).toBe(1);

    expect(initial.defaultFontFamily).toBe(1);
    expect(initial.defaultFontSize).toBe(20);
    expect(initial.loadChineseFonts).toBe(true);

    expect(initial.latexBoilerplate).toContain('aligned');
    expect(initial.latexFontSize).toBe(24);
    expect(initial.loadPropertySuggestions).toBe(true);
    expect(initial.experimentalFileTag).toBe('#excalidraw');

    expect(initial.enableOnloadScripts).toBe(false);
    expect(initial.enableSaveHooks).toBe(false);
    expect(initial.startupScriptPath).toBe('');

    expect(initial.compatibilityMode).toBe(false);
    expect(initial.embedMarkdownCommentLinks).toBe(true);
    expect(initial.syncExcalidraw).toBe(false);

    useExcalidrawSettingsStore.getState().updateSettings({
      folder: 'Drawings/Canvas',
      templateFilePath: 'templates/default.excalidraw.md',
      showReleaseNotes: false,
      compress: false,
      useExcalidrawExtension: false,
      drawingEmbedPrefixWithFilename: true,
      aiVerboseLogging: true,
      dynamicStyling: false,
      defaultMode: 'zen',
      gridSnap: true,
      disableDoubleClickTextEditing: true,
      allowCtrlClick: false,
      openInAdjacentPane: false,
      parseTODO: true,
      todo: '[ ] ',
      done: '[x] ',
      embedCardHeight: 640,
      embedMatchTheme: false,
      exportWithBackground: false,
      pngExportScale: 3,
      exportPaddingSVG: 20,
      mdCardWidth: 320,
      mdCardHeight: 200,
      markdownNodeOneClickEditing: false,
      pdfImportScale: 2.0,
      pdfBorderBox: false,
      numberOfCustomPens: 5,
      defaultStrokeWidth: 3,
      defaultFillStyle: 'solid',
      defaultRoughness: 2,
      defaultFontFamily: 2,
      defaultFontSize: 28,
      loadChineseFonts: false,
      latexFontSize: 32,
      loadPropertySuggestions: false,
      experimentalFileTag: '#drawing',
      enableOnloadScripts: true,
      enableSaveHooks: true,
      startupScriptPath: 'scripts/init.js',
      compatibilityMode: true,
      embedMarkdownCommentLinks: false,
      syncExcalidraw: true,
    });

    const updated = useExcalidrawSettingsStore.getState();
    expect(updated.folder).toBe('Drawings/Canvas');
    expect(updated.templateFilePath).toBe('templates/default.excalidraw.md');
    expect(updated.showReleaseNotes).toBe(false);
    expect(updated.compress).toBe(false);
    expect(updated.useExcalidrawExtension).toBe(false);
    expect(updated.drawingEmbedPrefixWithFilename).toBe(true);
    expect(updated.aiVerboseLogging).toBe(true);
    expect(updated.dynamicStyling).toBe(false);
    expect(updated.defaultMode).toBe('zen');
    expect(updated.gridSnap).toBe(true);
    expect(updated.disableDoubleClickTextEditing).toBe(true);
    expect(updated.allowCtrlClick).toBe(false);
    expect(updated.openInAdjacentPane).toBe(false);
    expect(updated.parseTODO).toBe(true);
    expect(updated.todo).toBe('[ ] ');
    expect(updated.done).toBe('[x] ');
    expect(updated.embedCardHeight).toBe(640);
    expect(updated.embedMatchTheme).toBe(false);
    expect(updated.exportWithBackground).toBe(false);
    expect(updated.pngExportScale).toBe(3);
    expect(updated.exportPaddingSVG).toBe(20);
    expect(updated.mdCardWidth).toBe(320);
    expect(updated.mdCardHeight).toBe(200);
    expect(updated.markdownNodeOneClickEditing).toBe(false);
    expect(updated.pdfImportScale).toBe(2.0);
    expect(updated.pdfBorderBox).toBe(false);
    expect(updated.numberOfCustomPens).toBe(5);
    expect(updated.defaultStrokeWidth).toBe(3);
    expect(updated.defaultFillStyle).toBe('solid');
    expect(updated.defaultRoughness).toBe(2);
    expect(updated.defaultFontFamily).toBe(2);
    expect(updated.defaultFontSize).toBe(28);
    expect(updated.loadChineseFonts).toBe(false);
    expect(updated.latexFontSize).toBe(32);
    expect(updated.loadPropertySuggestions).toBe(false);
    expect(updated.experimentalFileTag).toBe('#drawing');
    expect(updated.enableOnloadScripts).toBe(true);
    expect(updated.enableSaveHooks).toBe(true);
    expect(updated.startupScriptPath).toBe('scripts/init.js');
    expect(updated.compatibilityMode).toBe(true);
    expect(updated.embedMarkdownCommentLinks).toBe(false);
    expect(updated.syncExcalidraw).toBe(true);
  });

  it('resets all defaults cleanly', () => {
    useExcalidrawSettingsStore.getState().updateSettings({
      aiEnabled: false,
      autoSaveIntervalMs: 5000,
      embedCardHeight: 800,
    });
    expect(useExcalidrawSettingsStore.getState().aiEnabled).toBe(false);
    expect(useExcalidrawSettingsStore.getState().embedCardHeight).toBe(800);

    useExcalidrawSettingsStore.getState().resetSettings();
    const state = useExcalidrawSettingsStore.getState();
    expect(state.aiEnabled).toBe(true);
    expect(state.autoSaveIntervalMs).toBe(600);
    expect(state.embedCardHeight).toBe(520);
  });

  it('applies DOM side effects on settings update and reset', () => {
    useExcalidrawSettingsStore.getState().updateSettings({
      embedCardHeight: 700,
      loadChineseFonts: true,
    });
    expect(document.documentElement.style.getPropertyValue('--excalidraw-embed-height')).toBe('700px');
    expect(document.documentElement.classList.contains('excalidraw-cjk-fonts')).toBe(true);

    useExcalidrawSettingsStore.getState().updateSettings({
      loadChineseFonts: false,
    });
    expect(document.documentElement.classList.contains('excalidraw-cjk-fonts')).toBe(false);
  });
});
