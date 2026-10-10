import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ArrowLeft,
    Brush,
    Check,
    Eye,
    FileCode,
    Info,
    Moon,
    Save,
    Scan,
    SlidersHorizontal,
    Sparkles,
    Star,
    Sun,
    Workflow,
    X,
} from 'lucide-react';
import type { NoteSummary } from '@shared/types';
import { t, useLocale } from '../../lib/i18n';
import { IconButton } from '../../components/primitives';
import { Tooltip } from '../../components/overlay';
import { useBreakpoint } from '../../lib/hooks';
import { useNotes } from '../../store/notes';
import { useUi, type WorkspacePane } from '../../store/ui';
import {
    loadExcalidrawLib,
    parseExcalidrawBody,
    registerExcalidrawActionHandler,
    serializeExcalidrawBody,
    type ExcalidrawLib,
    type ExcalidrawSceneData,
} from '../../lib/markdown/excalidraw';
import { ExcalidrawToolsPanel } from './ExcalidrawToolsPanel';
import { ExcalidrawFloatingCapsule } from './ExcalidrawFloatingCapsule';
import {
    getViewportCenterInScene,
    promptAndInsertLatex,
    promptAndInsertLink,
    promptAndInsertNoteCard,
    zoomToFitScene,
} from './excalidraw-canvas-actions';
import { TextToDiagramModal } from './TextToDiagramModal';
import { useExcalidrawSettingsStore } from './excalidraw-settings-store';
import { extractCodeBlock, streamChatCompletion, type AIMessage } from '../../lib/ai';

interface ExcalidrawStandaloneEditorProps {
    note: NoteSummary;
    content: string;
    onChange: (next: string) => void;
    onTitleChange?: (title: string) => void;
    onMobileBack?: () => void;
    pane?: WorkspacePane | 'active';
    grouped?: boolean;
}

export const ExcalidrawStandaloneEditor: React.FC<ExcalidrawStandaloneEditorProps> = ({
    note,
    content,
    onChange,
    onTitleChange,
    onMobileBack,
    pane = 'active',
}) => {
    const isMobile = useBreakpoint() === 'mobile';
    const locale = useLocale();
    const patchNote = useNotes((s) => s.patchNote);
    const closeSecondaryNote = useUi((s) => s.closeSecondaryNote);
    const toast = useUi((s) => s.toast);

    const [lib, setLib] = useState<ExcalidrawLib | null>(null);
    const [libError, setLibError] = useState<string | null>(null);
    const [api, setApi] = useState<any>(null);

    const [viewMode, setViewMode] = useState<'canvas' | 'code'>('canvas');
    const [rawCode, setRawCode] = useState(content);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [toolsPanelOpen, setToolsPanelOpen] = useState(false);
    const [libraryOpen, setLibraryOpen] = useState(false);
    const [isSaved, setIsSaved] = useState(true);
    const [aiModalOpen, setAiModalOpen] = useState(false);
    const [aiModalTab, setAiModalTab] = useState<'ai' | 'mermaid'>('ai');

    const [theme, setTheme] = useState<'light' | 'dark'>(() => {
        return (document.documentElement.dataset.theme as 'light' | 'dark') ?? 'dark';
    });

    const containerRef = useRef<HTMLDivElement>(null);
    const canvasHostRef = useRef<HTMLDivElement>(null);
    const saveTimerRef = useRef<number | undefined>(undefined);
    const lastSavedRef = useRef<string>(content);

    const excalidrawSettings = useExcalidrawSettingsStore();

    useEffect(() => {
        if (!excalidrawSettings.matchTheme) return;
        const syncCurrentTheme = () => {
            const currentTheme = (document.documentElement.dataset.theme as 'light' | 'dark') ?? 'dark';
            setTheme(currentTheme);
            if (api) {
                api.updateScene({ appState: { theme: currentTheme } });
            }
        };
        syncCurrentTheme();
        const observer = new MutationObserver(syncCurrentTheme);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        return () => observer.disconnect();
    }, [api, excalidrawSettings.matchTheme]);

    useEffect(() => {
        if (!api) return;
        api.updateScene({
            appState: {
                gridSize: excalidrawSettings.gridModeEnabled ? excalidrawSettings.gridSize : null,
            },
        });
    }, [api, excalidrawSettings.gridModeEnabled, excalidrawSettings.gridSize]);

    useEffect(() => {
        if (!api) return;
        api.updateScene({
            appState: {
                zenModeEnabled: excalidrawSettings.zenModeEnabled || excalidrawSettings.defaultMode === 'zen',
            },
        });
    }, [api, excalidrawSettings.zenModeEnabled, excalidrawSettings.defaultMode]);

    useEffect(() => {
        if (!api) return;
        api.updateScene({
            appState: {
                viewModeEnabled: excalidrawSettings.viewModeEnabled || excalidrawSettings.defaultMode === 'view',
            },
        });
    }, [api, excalidrawSettings.viewModeEnabled, excalidrawSettings.defaultMode]);

    useEffect(() => {
        if (!api) return;
        api.updateScene({
            appState: {
                linkOpacity: excalidrawSettings.linkIndicatorOpacity,
            },
        });
    }, [api, excalidrawSettings.linkIndicatorOpacity]);

    useEffect(() => {
        if (!api) return;
        api.updateScene({
            appState: {
                currentItemFontFamily: excalidrawSettings.defaultFontFamily,
                currentItemFontSize: excalidrawSettings.defaultFontSize,
                currentItemStrokeWidth: excalidrawSettings.defaultStrokeWidth,
                currentItemFillStyle: excalidrawSettings.defaultFillStyle,
                currentItemRoughness: excalidrawSettings.defaultRoughness,
            },
        });
    }, [
        api,
        excalidrawSettings.defaultFontFamily,
        excalidrawSettings.defaultFontSize,
        excalidrawSettings.defaultStrokeWidth,
        excalidrawSettings.defaultFillStyle,
        excalidrawSettings.defaultRoughness,
    ]);

    useEffect(() => {
        let mounted = true;
        loadExcalidrawLib()
            .then((loaded) => {
                if (mounted) {
                    setLib(loaded);
                }
            })
            .catch((err: unknown) => {
                if (mounted) {
                    setLibError(err instanceof Error ? err.message : String(err));
                }
            });
        return () => {
            mounted = false;
        };
    }, []);

    useEffect(() => {
        setRawCode(content);
        lastSavedRef.current = content;
    }, [note.id]);

    useEffect(() => {
        registerExcalidrawActionHandler(async (action) => {
            if (!api) return;
            const isDark = theme === 'dark';
            if (action === 'LaTeX') {
                await promptAndInsertLatex(api, isDark);
            } else if (action === 'card') {
                await promptAndInsertNoteCard(api, isDark);
            } else if (action === 'anyFile') {
                await promptAndInsertLink(api, isDark);
            }
        });
        return () => {
            registerExcalidrawActionHandler(null);
        };
    }, [api, theme]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.shiftKey && e.altKey && (e.code === 'KeyD' || e.key === 'D' || e.key === 'd')) {
                e.preventDefault();
                setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    const onChangeRef = useRef(onChange);
    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

    const initialData = useMemo(() => {
        const parsed = parseExcalidrawBody(content).data;
        return {
            elements: parsed.elements,
            appState: {
                ...parsed.appState,
                theme,
                gridSize: excalidrawSettings.gridModeEnabled ? excalidrawSettings.gridSize : null,
                zenModeEnabled: excalidrawSettings.zenModeEnabled || excalidrawSettings.defaultMode === 'zen',
                viewModeEnabled: excalidrawSettings.viewModeEnabled || excalidrawSettings.defaultMode === 'view',
                linkOpacity: excalidrawSettings.linkIndicatorOpacity,
                currentItemFontFamily: excalidrawSettings.defaultFontFamily,
                currentItemFontSize: excalidrawSettings.defaultFontSize,
                currentItemStrokeWidth: excalidrawSettings.defaultStrokeWidth,
                currentItemFillStyle: excalidrawSettings.defaultFillStyle,
                currentItemRoughness: excalidrawSettings.defaultRoughness,
            },
            files: parsed.files,
        };
    }, [note.id]);

    const handleCanvasChange = useCallback(
        (elements: readonly any[], appState: any, files: any) => {
            const isLibOpen = Boolean(
                appState.openSidebar && (appState.openSidebar.name === 'default' || appState.openSidebar.name === 'customSidebar')
            );
            setLibraryOpen(isLibOpen);
            setIsSaved(false);
            window.clearTimeout(saveTimerRef.current);
            const autoSaveMs = useExcalidrawSettingsStore.getState().autoSaveIntervalMs || 600;
            saveTimerRef.current = window.setTimeout(() => {
                const scene: ExcalidrawSceneData = {
                    elements: elements as any[],
                    appState,
                    files,
                };
                const nextJson = serializeExcalidrawBody(scene);
                if (nextJson !== lastSavedRef.current) {
                    lastSavedRef.current = nextJson;
                    onChangeRef.current(nextJson);
                    setRawCode(nextJson);
                    setIsSaved(true);
                }
            }, autoSaveMs);
        },
        [],
    );

    const handleToggleLibrary = useCallback(() => {
        if (!api) return;
        if (typeof api.toggleSidebar === 'function') {
            const toggled = api.toggleSidebar({ name: 'default', tab: 'library' });
            const current = typeof api.getAppState === 'function' ? api.getAppState() : null;
            const isOpen = Boolean(
                current?.openSidebar && (current.openSidebar.name === 'default' || current.openSidebar.name === 'customSidebar')
            );
            setLibraryOpen(toggled !== undefined ? Boolean(toggled) : isOpen);
        } else if (typeof api.updateScene === 'function') {
            const appState = api.getAppState ? api.getAppState() : {};
            const isOpen = Boolean(appState.openSidebar?.name === 'default' || appState.openSidebar?.name === 'customSidebar');
            const willOpen = !isOpen;
            api.updateScene({
                appState: {
                    openSidebar: willOpen ? { name: 'default', tab: 'library' } : null,
                },
            });
            setLibraryOpen(willOpen);
        }
    }, [api]);

    const handleManualSave = useCallback(() => {
        if (!api || !lib) return;
        const elements = api.getSceneElements();
        const appState = api.getAppState();
        const files = api.getFiles();
        const scene: ExcalidrawSceneData = { elements, appState, files };
        const nextJson = serializeExcalidrawBody(scene);
        if (nextJson !== lastSavedRef.current) {
            lastSavedRef.current = nextJson;
            onChangeRef.current(nextJson);
            setRawCode(nextJson);
            setIsSaved(true);
        }
        toast({ title: t('workspace.drawing_saved'), tone: 'success' });
    }, [api, lib, toast]);

    const handleToggleViewMode = useCallback(() => {
        if (viewMode === 'canvas') {
            if (api) {
                const currentData: ExcalidrawSceneData = {
                    elements: api.getSceneElements(),
                    appState: api.getAppState(),
                    files: api.getFiles(),
                };
                const json = serializeExcalidrawBody(currentData);
                setRawCode(json);
            }
            setViewMode('code');
        } else {
            try {
                const parsed = parseExcalidrawBody(rawCode);
                if (api) {
                    api.updateScene({
                        elements: parsed.data.elements,
                        appState: parsed.data.appState,
                    });
                    if (parsed.data.files) {
                        api.addFiles(Object.values(parsed.data.files));
                    }
                }
            } catch {
            }
            setViewMode('canvas');
        }
    }, [viewMode, api, rawCode]);

    const handleInsertDiagramFromModal = useCallback(
        (elements: any[]) => {
            if (!api || !elements || elements.length === 0) return;
            const center = getViewportCenterInScene(api);
            const minX = Math.min(...elements.map((el) => Number(el.x) || 0));
            const minY = Math.min(...elements.map((el) => Number(el.y) || 0));
            const maxX = Math.max(...elements.map((el) => (Number(el.x) || 0) + (Number(el.width) || 0)));
            const maxY = Math.max(...elements.map((el) => (Number(el.y) || 0) + (Number(el.height) || 0)));
            const width = Math.max(maxX - minX, 100);
            const height = Math.max(maxY - minY, 100);
            const shifted = elements.map((el) => ({
                ...el,
                x: Math.round(center.x - width / 2 + ((Number(el.x) || 0) - minX)),
                y: Math.round(center.y - height / 2 + ((Number(el.y) || 0) - minY)),
            }));
            const existing = typeof api.getSceneElements === 'function' ? api.getSceneElements() : [];
            api.updateScene({ elements: [...existing, ...shifted] });
            setIsSaved(false);
        },
        [api],
    );

    const handleLinkOpen = useCallback((element: any, event: any) => {
        if (event?.preventDefault) event.preventDefault();
        const link = element?.link?.trim();
        if (!link) return;
        if (/^https?:\/\//i.test(link) || /^mailto:/i.test(link)) {
            window.open(link, '_blank', 'noopener,noreferrer');
            return;
        }
        const cleanTitle = link.replace(/^\[\[/, '').replace(/\]\]$/, '').trim();
        const allNotes = Object.values(useNotes.getState().notes || {});
        const target = allNotes.find(
            (n) => n.title.toLowerCase() === cleanTitle.toLowerCase() || n.id === cleanTitle
        );
        if (target) {
            const settings = useExcalidrawSettingsStore.getState();
            const activePane = useUi.getState().activeWorkspacePane;
            const targetPane = settings.openInAdjacentPane
                ? (activePane === 'primary' ? 'secondary' : 'primary')
                : activePane;
            void useNotes.getState().openNote(target.id, { pane: targetPane });
        }
    }, []);

    useEffect(() => {
        return () => {
            window.clearTimeout(saveTimerRef.current);
        };
    }, []);

    useEffect(() => {
        if (!canvasHostRef.current || viewMode !== 'canvas') return;
        const host = canvasHostRef.current;
        let observer: MutationObserver | null = null;

        const reparentMenu = () => {
            const trigger =
                host.querySelector<HTMLElement>('.dropdown-menu-event-wrapper:has(.main-menu-trigger)') ||
                host.querySelector<HTMLElement>('.main-menu-trigger') ||
                host.querySelector<HTMLElement>('.excalidraw-ui-top-left');
            const undoRedo = host.querySelector<HTMLElement>('.layer-ui__wrapper__footer-left .undo-redo-buttons');
            const footerSection = host.querySelector<HTMLElement>('.layer-ui__wrapper__footer-left section');

            if (trigger) {
                if (undoRedo && !undoRedo.contains(trigger)) {
                    undoRedo.prepend(trigger);
                } else if (!undoRedo && footerSection && !footerSection.contains(trigger)) {
                    footerSection.prepend(trigger);
                }
                if ((undoRedo && undoRedo.contains(trigger)) || (footerSection && footerSection.contains(trigger))) {
                    observer?.disconnect();
                }
            }
        };

        reparentMenu();
        observer = new MutationObserver(reparentMenu);
        observer.observe(host, { childList: true, subtree: true });

        return () => {
            observer?.disconnect();
        };
    }, [viewMode, lib]);


    useEffect(() => {
        const handleFullscreenChange = () => {
            const isFull = Boolean(document.fullscreenElement);
            setIsFullscreen(isFull);
            if (api) {
                requestAnimationFrame(() => {
                    zoomToFitScene(api, canvasHostRef.current);
                });
            }
        };
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        return () => {
            document.removeEventListener('fullscreenchange', handleFullscreenChange);
        };
    }, [api]);

    const handleToggleFullscreen = () => {
        if (!containerRef.current) return;
        if (!document.fullscreenElement) {
            void containerRef.current.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
        } else {
            void document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
        }
    };

    return (
        <div
            ref={containerRef}
            className="relative flex h-full min-h-0 w-full flex-col bg-[var(--bg-base)] text-[var(--text-primary)]"
        >
            <header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 select-none">
                <div className="flex min-w-0 items-center gap-2">
                    {isMobile && onMobileBack && (
                        <IconButton label={t('workspace.back_to_notes')} size="sm" onClick={onMobileBack}>
                            <ArrowLeft size={16} />
                        </IconButton>
                    )}
                    <Brush size={16} className="text-[var(--accent)] shrink-0" />
                    <input
                        type="text"
                        value={note.title}
                        onChange={(e) => onTitleChange?.(e.target.value)}
                        className="min-w-0 max-w-[280px] md:max-w-md truncate rounded bg-transparent px-1.5 py-0.5 text-sm font-semibold text-[var(--text-primary)] focus:bg-[var(--bg-surface)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                    />
                </div>

                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={handleManualSave}
                        className="mr-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                        title={t('workspace.save_drawing')}
                        aria-label={t('workspace.save_drawing')}
                    >
                        {isSaved ? (
                            <>
                                <Check size={13} className="text-[var(--accent)]" />
                                <span className="hidden sm:inline text-[11px]">{t('workspace.drawing_saved')}</span>
                            </>
                        ) : (
                            <>
                                <Save size={13} className="text-[var(--warning)]" />
                                <span className="hidden sm:inline text-[11px]">{t('workspace.save_drawing')}</span>
                            </>
                        )}
                    </button>

                    <Tooltip label={viewMode === 'canvas' ? t('excalidraw.toggle_code') : t('excalidraw.toggle_canvas')}>
                        <IconButton
                            label={viewMode === 'canvas' ? t('excalidraw.toggle_code') : t('excalidraw.toggle_canvas')}
                            size="sm"
                            onClick={handleToggleViewMode}
                        >
                            {viewMode === 'canvas' ? <FileCode size={15} /> : <Eye size={15} />}
                        </IconButton>
                    </Tooltip>

                    <Tooltip label={note.isStarred ? t('common.remove_from_favorites') : t('navigation.favorites')}>
                        <IconButton
                            label={note.isStarred ? t('common.remove_from_favorites') : t('navigation.favorites')}
                            size="sm"
                            active={note.isStarred}
                            onClick={() => void patchNote(note.id, { isStarred: !note.isStarred })}
                        >
                            <Star size={14} className={note.isStarred ? 'fill-current' : undefined} />
                        </IconButton>
                    </Tooltip>

                    <Tooltip label={`${t('excalidraw.text_to_diagram')} [AI]`}>
                        <IconButton
                            label={`${t('excalidraw.text_to_diagram')} [AI]`}
                            size="sm"
                            onClick={() => {
                                setAiModalTab('ai');
                                setAiModalOpen(true);
                            }}
                        >
                            <Sparkles size={14} className="text-[var(--accent)]" />
                        </IconButton>
                    </Tooltip>

                    <Tooltip label={t('excalidraw.tools_panel')}>
                        <IconButton
                            label={t('excalidraw.tools_panel')}
                            size="sm"
                            active={toolsPanelOpen}
                            onClick={() => setToolsPanelOpen((o) => !o)}
                        >
                            <SlidersHorizontal size={14} />
                        </IconButton>
                    </Tooltip>

                    {pane === 'secondary' && (
                        <Tooltip label={t('workspace.close_right_note')}>
                            <IconButton label={t('workspace.close_right_note')} size="sm" onClick={closeSecondaryNote}>
                                <X size={15} />
                            </IconButton>
                        </Tooltip>
                    )}
                </div>
            </header>

            <div className="relative flex-1 min-h-0 w-full overflow-hidden">
                {viewMode === 'code' && (
                    <div className="h-full w-full p-4 overflow-auto font-mono text-sm">
                        <textarea
                            value={rawCode}
                            onChange={(e) => {
                                setRawCode(e.target.value);
                                if (e.target.value !== lastSavedRef.current) {
                                    lastSavedRef.current = e.target.value;
                                    onChangeRef.current(e.target.value);
                                    setIsSaved(true);
                                }
                            }}
                            className="h-full w-full resize-none rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 font-mono text-xs leading-relaxed text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                        />
                    </div>
                )}

                <div
                    ref={canvasHostRef}
                    className={`h-full w-full ${excalidrawSettings.leftHandedMode ? 'excalidraw-left-handed' : ''} ${theme === 'dark' ? 'theme--dark' : ''}`}
                    style={{
                        display: viewMode === 'canvas' && lib ? 'block' : 'none',
                        ['--default-link-indicator-opacity' as any]: excalidrawSettings.linkIndicatorOpacity,
                    }}
                >
                    {lib && (
                        <lib.Excalidraw
                            initialData={initialData}
                            theme={theme}
                            langCode={locale === 'zh-CN' ? 'zh-CN' : 'en'}
                            aiEnabled={true}
                            onChange={handleCanvasChange}
                            onLinkOpen={handleLinkOpen}
                            onExcalidrawAPI={(excalidrawApi: any) => {
                                if (excalidrawApi) setApi(excalidrawApi);
                            }}
                            UIOptions={{
                                canvasActions: {
                                    loadScene: false,
                                    saveToActiveFile: false,
                                },
                            }}
                        >
                            {lib.TTDDialog && (
                                <lib.TTDDialog
                                    persistenceAdapter={{
                                        loadChats: async () => {
                                            try {
                                                const saved = localStorage.getItem('inkstone-excalidraw-ttd-chats');
                                                return saved ? JSON.parse(saved) : [];
                                            } catch {
                                                return [];
                                            }
                                        },
                                        saveChats: async (chats: any) => {
                                            try {
                                                localStorage.setItem('inkstone-excalidraw-ttd-chats', JSON.stringify(chats));
                                            } catch {
                                            }
                                        },
                                    }}
                                    onTextSubmit={async (props: any) => {
                                        const { messages = [], onChunk, onStreamCreated, signal } = props ?? {};
                                        onStreamCreated?.();
                                        const settings = useExcalidrawSettingsStore.getState();
                                        const config = settings.aiProviders[settings.aiDefaultProvider] || {
                                            provider: 'deepseek',
                                            baseURL: 'https://api.deepseek.com',
                                            apiKey: '***REMOVED***',
                                        };
                                        const systemPrompt =
                                            'The user will provide you with a text prompt. Your task is to generate a mermaid diagram based on the prompt. Use the graph, sequenceDiagram, flowchart or classDiagram types based on what best fits the request. Return a single message containing only the mermaid diagram in a codeblock. Avoid the use of () parenthesis in the mermaid script.';
                                        try {
                                            const aiMsgs: AIMessage[] = messages.map((m: any, i: number) => ({
                                                id: String(i),
                                                role: m.role,
                                                content: m.content,
                                            }));
                                            const result = await streamChatCompletion(aiMsgs, config, {
                                                systemPrompt,
                                                signal,
                                                onChunk: (_c: string, full: string) => {
                                                    let code = extractCodeBlock(full) || full;
                                                    if (code.startsWith('mermaid')) {
                                                        code = code.replace(/^mermaid\s*/i, '');
                                                    }
                                                    onChunk?.(code);
                                                },
                                            });
                                            let generatedResponse = extractCodeBlock(result.content) || result.content;
                                            if (generatedResponse.startsWith('mermaid')) {
                                                generatedResponse = generatedResponse.replace(/^mermaid\s*/i, '');
                                            }
                                            return { generatedResponse, error: null };
                                        } catch (err: unknown) {
                                            return { error: (err instanceof Error ? err : new Error(String(err))) as any };
                                        }
                                    }}
                                />
                            )}
                            {lib.TTDDialogTrigger && <lib.TTDDialogTrigger />}
                            {lib.DiagramToCodePlugin && (
                                <lib.DiagramToCodePlugin
                                    generate={async () => ({ html: '<div>Wireframe Generated</div>' })}
                                />
                            )}
                            <lib.MainMenu>
                                <lib.MainMenu.Item
                                    onSelect={() => {
                                        setAiModalTab('ai');
                                        setAiModalOpen(true);
                                    }}
                                    icon={<Sparkles size={14} />}
                                >
                                    {`${t('excalidraw.text_to_diagram')} [AI]`}
                                </lib.MainMenu.Item>
                                <lib.MainMenu.Item
                                    onSelect={() => {
                                        setAiModalTab('mermaid');
                                        setAiModalOpen(true);
                                    }}
                                    icon={<Workflow size={14} />}
                                >
                                    {t('excalidraw.mermaid_to_excalidraw')}
                                </lib.MainMenu.Item>
                                <lib.MainMenu.DefaultItems.ChangeCanvasBackground />
                                <lib.MainMenu.Item
                                    onSelect={() => {
                                        setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
                                    }}
                                    icon={theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
                                    shortcut="Shift+Alt+D"
                                >
                                    {theme === 'dark' ? t('command.switch_to_light_theme') : t('command.switch_to_dark_theme')}
                                </lib.MainMenu.Item>
                                <lib.MainMenu.Item
                                    onSelect={() => {
                                        if (api) {
                                            const appState = api.getAppState();
                                            api.updateScene({ appState: { viewModeEnabled: !appState.viewModeEnabled } });
                                        }
                                    }}
                                    icon={<Eye size={14} />}
                                >
                                    {t('excalidraw.view_mode')}
                                </lib.MainMenu.Item>
                                <lib.MainMenu.Item
                                    onSelect={() => zoomToFitScene(api, canvasHostRef.current)}
                                    icon={<Scan size={14} />}
                                >
                                    {t('preview.excalidraw_fit')}
                                </lib.MainMenu.Item>
                                <lib.MainMenu.Item
                                    onSelect={handleManualSave}
                                    icon={<Save size={14} />}
                                >
                                    {t('workspace.save_drawing')}
                                </lib.MainMenu.Item>
                                <lib.MainMenu.Item
                                    onSelect={() => {
                                        toast({ title: t('excalidraw.scripts_installed'), tone: 'success' });
                                    }}
                                    icon={<Brush size={14} />}
                                >
                                    {t('excalidraw.script_library')}
                                </lib.MainMenu.Item>
                                <lib.MainMenu.Item
                                    onSelect={() => setToolsPanelOpen(true)}
                                    icon={<SlidersHorizontal size={14} />}
                                >
                                    {t('excalidraw.export_drawing')}
                                </lib.MainMenu.Item>
                                <lib.MainMenu.Item
                                    onSelect={handleToggleViewMode}
                                    icon={<FileCode size={14} />}
                                >
                                    {t('excalidraw.open_as_md')}
                                </lib.MainMenu.Item>
                                <lib.MainMenu.Item
                                    onSelect={() => {
                                        toast({ title: 'Excalidraw', description: 'https://excalidraw.com', tone: 'default' });
                                    }}
                                    icon={<Sparkles size={14} />}
                                >
                                    {t('excalidraw.learn_excalidraw')}
                                </lib.MainMenu.Item>
                                <lib.MainMenu.Item
                                    onSelect={() => {
                                        toast({ title: t('excalidraw.help_and_issues'), description: 'github.com/zsviczian/obsidian-excalidraw-plugin', tone: 'default' });
                                    }}
                                    icon={<Info size={14} />}
                                >
                                    {t('excalidraw.help_and_issues')}
                                </lib.MainMenu.Item>
                                <lib.MainMenu.Separator />
                                <lib.MainMenu.DefaultItems.ClearCanvas />
                            </lib.MainMenu>
                        </lib.Excalidraw>
                    )}
                </div>

                {!lib && !libError && (
                    <div className="flex h-full items-center justify-center text-sm text-[var(--text-tertiary)]">
                        {t('preview.excalidraw_loading')}
                    </div>
                )}

                {libError && (
                    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
                        <p className="text-sm text-[var(--danger)]">{t('preview.excalidraw_render_failed')}</p>
                        <p className="text-xs text-[var(--text-tertiary)]">{libError}</p>
                    </div>
                )}

                {viewMode === 'canvas' && lib && (
                    <ExcalidrawFloatingCapsule
                        isFullscreen={isFullscreen}
                        onToggleFullscreen={handleToggleFullscreen}
                        onZoomToFit={() => zoomToFitScene(api, canvasHostRef.current)}
                        libraryOpen={libraryOpen}
                        onToggleLibrary={handleToggleLibrary}
                        toolsPanelOpen={toolsPanelOpen}
                        onToggleToolsPanel={() => setToolsPanelOpen((o) => !o)}
                        onToggleCode={handleToggleViewMode}
                        onScriptLibrary={() => toast({ title: t('excalidraw.scripts_installed'), tone: 'success' })}
                        isDark={theme === 'dark'}
                        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
                    />
                )}

                {viewMode === 'canvas' && lib && (
                    <ExcalidrawToolsPanel
                        open={toolsPanelOpen}
                        onClose={() => setToolsPanelOpen(false)}
                        api={api}
                        lib={lib}
                        title={note.title}
                        dark={theme === 'dark'}
                        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
                        onToggleFullscreen={handleToggleFullscreen}
                        onSave={handleManualSave}
                        onOpenAiModal={(tab) => {
                            setAiModalTab(tab || 'ai');
                            setAiModalOpen(true);
                        }}
                    />
                )}

                <TextToDiagramModal
                    isOpen={aiModalOpen}
                    onClose={() => setAiModalOpen(false)}
                    onInsert={handleInsertDiagramFromModal}
                    theme={theme}
                    initialTab={aiModalTab}
                />
            </div>
        </div>
    );
};
