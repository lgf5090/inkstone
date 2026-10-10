import React from 'react';
import ReactDOM from 'react-dom/client';
import { parseExcalidrawBody, serializeExcalidrawBody } from './body';
import { loadExcalidrawLib } from './loader';
import type {
    ExcalidrawBlockEntry,
    ExcalidrawMountOptions,
    ExcalidrawSceneData,
} from './types';
import {
    createExcalidrawToolbar,
    decorateExcalidrawControls,
    excalidrawBlocks,
    excalidrawFenceRef,
    markExcalidrawReady,
    showExcalidrawError,
    EXCALIDRAW_CANVAS_CLASS,
    EXCALIDRAW_PLACEHOLDER_SELECTOR,
} from './view';

interface MountedInstance {
    entry: ExcalidrawBlockEntry;
    root: ReactDOM.Root;
    canvasHost: HTMLElement;
    rawPre?: HTMLElement;
    rawCode?: HTMLElement;
    saveTimeout?: number;
    lastSavedJson?: string;
    dark: boolean;
}

const activeInstances = new Map<string, MountedInstance>();

function makeInstanceKey(scope: string, index: number): string {
    return `${scope}::${index}`;
}

export function getExcalidrawInstance(scope: string, index: number): ExcalidrawBlockEntry | undefined {
    return activeInstances.get(makeInstanceKey(scope, index))?.entry;
}

function bindToolbar(
    block: HTMLElement,
    entry: ExcalidrawBlockEntry,
    instance: MountedInstance,
    lib?: any,
) {
    const canvasTab = block.querySelector<HTMLButtonElement>('[data-excalidraw-tab="canvas"]');
    const jsonTab = block.querySelector<HTMLButtonElement>('[data-excalidraw-tab="json"]');
    const themeBtn = block.querySelector<HTMLButtonElement>('[data-excalidraw-theme]');
    const sourceBtn = block.querySelector<HTMLButtonElement>('[data-excalidraw-source]');
    const exportBtn = block.querySelector<HTMLButtonElement>('[data-excalidraw-export]');
    const fitBtn = block.querySelector<HTMLButtonElement>('[data-excalidraw-fit]');
    const fullBtn = block.querySelector<HTMLButtonElement>('[data-excalidraw-fullscreen]');

    const setMode = (mode: 'canvas' | 'json') => {
        if (mode === 'canvas') {
            instance.canvasHost.style.display = 'block';
            if (instance.rawPre) instance.rawPre.hidden = true;
            canvasTab?.classList.add('is-active');
            jsonTab?.classList.remove('is-active');
        } else {
            instance.canvasHost.style.display = 'none';
            if (instance.rawPre) instance.rawPre.hidden = false;
            jsonTab?.classList.add('is-active');
            canvasTab?.classList.remove('is-active');
        }
    };

    if (canvasTab) canvasTab.onclick = () => setMode('canvas');
    if (jsonTab) jsonTab.onclick = () => setMode('json');
    if (sourceBtn) {
        sourceBtn.onclick = () => {
            const isJson = instance.rawPre ? !instance.rawPre.hidden : false;
            setMode(isJson ? 'canvas' : 'json');
        };
    }
    if (themeBtn) {
        themeBtn.onclick = () => {
            const nextTheme = instance.dark ? 'light' : 'dark';
            instance.dark = !instance.dark;
            entry.setTheme(nextTheme);
        };
    }
    if (exportBtn && lib) {
        exportBtn.onclick = async () => {
            try {
                const api = entry.excalidrawAPI;
                if (!api) return;
                const elements = api.getSceneElements();
                const appState = api.getAppState();
                const files = api.getFiles();
                const blob = await lib.exportToBlob({
                    elements,
                    appState: { ...appState, exportWithDarkMode: instance.dark },
                    files,
                    mimeType: 'image/png',
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'drawing.png';
                a.click();
                URL.revokeObjectURL(url);
            } catch (err) {
                console.warn('Excalidraw export failed', err);
            }
        };
    }
    if (fitBtn) fitBtn.onclick = () => entry.zoomToFit();
    if (fullBtn) {
        fullBtn.onclick = () => {
            block.dispatchEvent(new CustomEvent('excalidraw-fullscreen', { bubbles: true, detail: { entry } }));
        };
    }
}

export async function mountExcalidrawBlocks(root: ParentNode, options: ExcalidrawMountOptions): Promise<void> {
    const blocks = excalidrawBlocks(root);
    if (blocks.length === 0) return;

    let lib: any;
    try {
        lib = await loadExcalidrawLib();
    } catch (err: unknown) {
        for (const block of blocks) {
            showExcalidrawError(block, err instanceof Error ? err.message : String(err), () => {
                void mountExcalidrawBlocks(root, options);
            });
        }
        return;
    }

    const { Excalidraw, MainMenu } = lib;

    for (const block of blocks) {
        decorateExcalidrawControls(block);
        const ref = excalidrawFenceRef(block);
        const key = makeInstanceKey(options.scope, ref.index);
        const parsed = parseExcalidrawBody(ref.rawBody);

        let instance = activeInstances.get(key);

        if (instance) {
            instance.entry.container = block;
            let toolbar = block.querySelector<HTMLElement>('.excalidraw-block-head');
            if (!toolbar) {
                toolbar = createExcalidrawToolbar(block);
                block.prepend(toolbar);
                decorateExcalidrawControls(block);
                bindToolbar(block, instance.entry, instance, lib);
            }

            if (!block.contains(instance.canvasHost)) {
                const placeholder = block.querySelector(EXCALIDRAW_PLACEHOLDER_SELECTOR);
                if (placeholder) {
                    placeholder.replaceWith(instance.canvasHost);
                } else {
                    block.append(instance.canvasHost);
                }
            }
            if (instance.rawPre && !block.contains(instance.rawPre)) {
                block.append(instance.rawPre);
            }
            markExcalidrawReady(block);

            const trimmedBody = ref.rawBody.trim();
            if (trimmedBody !== instance.lastSavedJson) {
                instance.lastSavedJson = trimmedBody;
                if (instance.rawCode) {
                    instance.rawCode.textContent = ref.rawBody;
                }
                if (parsed.ok && instance.entry.excalidrawAPI) {
                    instance.entry.updateScene(parsed.data);
                }
            }

            if (options.dark !== instance.dark) {
                instance.dark = options.dark;
                instance.entry.setTheme(options.dark ? 'dark' : 'light');
            }

            continue;
        }

        const toolbar = createExcalidrawToolbar(block);
        block.prepend(toolbar);
        decorateExcalidrawControls(block);

        const canvasHost = document.createElement('div');
        canvasHost.className = EXCALIDRAW_CANVAS_CLASS;
        const placeholder = block.querySelector(EXCALIDRAW_PLACEHOLDER_SELECTOR);
        if (placeholder) {
            placeholder.replaceWith(canvasHost);
        } else {
            block.append(canvasHost);
        }

        const rawPre = document.createElement('pre');
        rawPre.className = 'excalidraw-block-source';
        rawPre.hidden = true;
        const rawCode = document.createElement('code');
        rawCode.textContent = ref.rawBody;
        rawPre.append(rawCode);
        block.append(rawPre);

        let api: any = null;
        let lastElements: any[] = parsed.data.elements;
        let lastAppState: any = parsed.data.appState;
        let lastFiles: any = parsed.data.files;

        const scheduleSave = () => {
            if (!options.writeBack || !options.editable) return;
            window.clearTimeout(instance?.saveTimeout);
            const timeout = window.setTimeout(() => {
                const currentData: ExcalidrawSceneData = {
                    elements: lastElements,
                    appState: lastAppState,
                    files: lastFiles,
                };
                const nextJson = serializeExcalidrawBody(currentData);
                if (instance && nextJson !== instance.lastSavedJson) {
                    instance.lastSavedJson = nextJson.trim();
                    rawCode.textContent = nextJson;
                    options.writeBack!(ref, nextJson);
                }
            }, 600);
            if (instance) {
                instance.saveTimeout = timeout;
            }
        };

        const ExcalidrawWrapper: React.FC = () => {
            const [theme, setTheme] = React.useState<'light' | 'dark'>(options.dark ? 'dark' : 'light');

            React.useEffect(() => {
                setTheme(options.dark ? 'dark' : 'light');
            }, [options.dark]);

            const handleChange = React.useCallback((elements: readonly any[], appState: any, files: any) => {
                lastElements = elements as any[];
                lastAppState = appState;
                lastFiles = files;
                scheduleSave();
            }, []);

            return React.createElement(
                'div',
                {
                    style: { width: '100%', height: '100%', position: 'relative' },
                    className: `excalidraw-embedded-canvas ${theme === 'dark' ? 'theme--dark' : ''}`,
                },
                React.createElement(
                    Excalidraw,
                    {
                        initialData: {
                            elements: parsed.data.elements,
                            appState: {
                                ...parsed.data.appState,
                                theme,
                            },
                            files: parsed.data.files,
                        },
                        theme,
                        langCode: options.locale === 'zh-CN' ? 'zh-CN' : 'en',
                        onChange: handleChange,
                        onExcalidrawAPI: (excalidrawApi: any) => {
                            api = excalidrawApi;
                            if (instance) {
                                instance.entry.excalidrawAPI = api;
                            }
                        },
                        UIOptions: {
                            canvasActions: {
                                loadScene: false,
                                saveToActiveFile: false,
                            },
                        },
                    },
                    React.createElement(
                        MainMenu,
                        null,
                        React.createElement(MainMenu.DefaultItems.ChangeCanvasBackground),
                        React.createElement(MainMenu.DefaultItems.ToggleTheme),
                        React.createElement(MainMenu.DefaultItems.ClearCanvas),
                    ),
                ),
            );
        };

        const reactRoot = ReactDOM.createRoot(canvasHost);
        reactRoot.render(React.createElement(ExcalidrawWrapper));

        markExcalidrawReady(block);

        const entry: ExcalidrawBlockEntry = {
            id: key,
            container: block,
            canvasHost,
            fence: ref,
            initialData: parsed.data,
            scope: options.scope,
            noteId: options.noteId,
            excalidrawAPI: null,
            destroy: () => {
                window.clearTimeout(instance?.saveTimeout);
                activeInstances.delete(key);
                queueMicrotask(() => {
                    try {
                        reactRoot.unmount();
                    } catch {
                    }
                });
            },
            updateScene: (nextData: ExcalidrawSceneData) => {
                if (api) {
                    api.updateScene({
                        elements: nextData.elements,
                        appState: nextData.appState,
                    });
                    if (nextData.files) {
                        api.addFiles(Object.values(nextData.files));
                    }
                }
            },
            zoomToFit: () => {
                if (api && typeof api.scrollToContent === 'function') {
                    api.scrollToContent(undefined, { fitToViewport: true });
                }
            },
            toggleSource: () => {
                const isJson = !rawPre.hidden;
                rawPre.hidden = isJson;
                canvasHost.style.display = isJson ? 'block' : 'none';
            },
            setTheme: (newTheme: 'light' | 'dark') => {
                if (api) {
                    api.updateScene({
                        appState: { theme: newTheme },
                    });
                }
            },
        };

        instance = {
            entry,
            root: reactRoot,
            canvasHost,
            rawPre,
            rawCode,
            lastSavedJson: ref.rawBody.trim(),
            dark: options.dark,
        };
        activeInstances.set(key, instance);

        bindToolbar(block, entry, instance, lib);
    }

    const currentKeys = new Set(blocks.map((b) => makeInstanceKey(options.scope, excalidrawFenceRef(b).index)));
    for (const [key, inst] of activeInstances.entries()) {
        if (key.startsWith(`${options.scope}::`) && !currentKeys.has(key)) {
            inst.entry.destroy();
        }
    }
}

export function destroyExcalidrawBlocks(scope: string): void {
    for (const [key, instance] of activeInstances.entries()) {
        if (key.startsWith(`${scope}::`)) {
            instance.entry.destroy();
        }
    }
}
