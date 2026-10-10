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
} from './view';

interface MountedInstance {
    entry: ExcalidrawBlockEntry;
    root: ReactDOM.Root;
    rawPre?: HTMLElement;
    saveTimeout?: number;
    lastSavedJson?: string;
}

const activeInstances = new Map<string, MountedInstance>();

function makeInstanceKey(scope: string, index: number): string {
    return `${scope}::${index}`;
}

export function getExcalidrawInstance(scope: string, index: number): ExcalidrawBlockEntry | undefined {
    return activeInstances.get(makeInstanceKey(scope, index))?.entry;
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

        if (instance && instance.entry.container === block) {
            continue;
        }

        if (instance) {
            instance.root.unmount();
            activeInstances.delete(key);
        }

        const toolbar = createExcalidrawToolbar(block);
        block.prepend(toolbar);

        const canvasHost = document.createElement('div');
        canvasHost.className = EXCALIDRAW_CANVAS_CLASS;
        block.append(canvasHost);

        const rawPre = document.createElement('pre');
        rawPre.className = 'excalidraw-block-source';
        rawPre.hidden = true;
        const rawCode = document.createElement('code');
        rawCode.textContent = ref.rawBody;
        rawPre.append(rawCode);
        block.append(rawPre);

        let api: any = null;
        let showSource = false;
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
                    instance.lastSavedJson = nextJson;
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
                reactRoot.unmount();
                activeInstances.delete(key);
            },
            updateScene: (nextData: ExcalidrawSceneData) => {
                if (api) {
                    api.updateScene({
                        elements: nextData.elements,
                        appState: nextData.appState,
                    });
                }
            },
            zoomToFit: () => {
                if (api && typeof api.scrollToContent === 'function') {
                    api.scrollToContent(undefined, { fitToViewport: true });
                }
            },
            toggleSource: () => {
                showSource = !showSource;
                rawPre.hidden = !showSource;
                canvasHost.style.display = showSource ? 'none' : 'block';
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
            rawPre,
            lastSavedJson: ref.rawBody.trim(),
        };
        activeInstances.set(key, instance);

        const sourceBtn = toolbar.querySelector<HTMLButtonElement>('[data-excalidraw-source]');
        if (sourceBtn) {
            sourceBtn.onclick = () => entry.toggleSource();
        }

        const fitBtn = toolbar.querySelector<HTMLButtonElement>('[data-excalidraw-fit]');
        if (fitBtn) {
            fitBtn.onclick = () => entry.zoomToFit();
        }

        const fullBtn = toolbar.querySelector<HTMLButtonElement>('[data-excalidraw-fullscreen]');
        if (fullBtn) {
            fullBtn.onclick = () => {
                block.dispatchEvent(new CustomEvent('excalidraw-fullscreen', { bubbles: true, detail: { entry } }));
            };
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
