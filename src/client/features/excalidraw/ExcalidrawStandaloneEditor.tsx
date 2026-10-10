import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import {
    ArrowLeft,
    Brush,
    Check,
    Eye,
    FileCode,
    Info,
    Library,
    Maximize,
    Minimize,
    Moon,
    Save,
    SlidersHorizontal,
    Sparkles,
    Star,
    Sun,
    X,
} from 'lucide-react';
import type { NoteSummary } from '@shared/types';
import { t, useLocale } from '../../lib/i18n';
import { IconButton } from '../../components/primitives';
import { prompt, Tooltip } from '../../components/overlay';
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

    const [theme, setTheme] = useState<'light' | 'dark'>(() => {
        return (document.documentElement.dataset.theme as 'light' | 'dark') ?? 'dark';
    });

    const containerRef = useRef<HTMLDivElement>(null);
    const canvasHostRef = useRef<HTMLDivElement>(null);
    const isolatedRootRef = useRef<ReactDOM.Root | null>(null);
    const saveTimerRef = useRef<number | undefined>(undefined);
    const lastSavedRef = useRef<string>(content);

    useEffect(() => {
        const observer = new MutationObserver(() => {
            const currentTheme = (document.documentElement.dataset.theme as 'light' | 'dark') ?? 'dark';
            setTheme(currentTheme);
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        return () => observer.disconnect();
    }, []);

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
            if (action === 'LaTeX') {
                const latex = await prompt({
                    title: t('excalidraw.insert_latex_prompt') || 'Enter LaTeX formula:',
                });
                if (latex && api) {
                    const appState = api.getAppState();
                    const centerX = -(appState.scrollX + appState.width / 2) + 200;
                    const centerY = -(appState.scrollY + appState.height / 2) + 150;
                    const el = {
                        type: 'text',
                        x: centerX,
                        y: centerY,
                        text: `$$${latex.trim()}$$`,
                        fontSize: 20,
                        fontFamily: 1,
                        textAlign: 'left',
                        verticalAlign: 'top',
                    };
                    api.updateScene({ elements: [...api.getSceneElements(), el] });
                    toast({ title: t('excalidraw.insert_latex'), tone: 'success' });
                }
            } else if (action === 'card') {
                const text = await prompt({
                    title: t('excalidraw.insert_md_prompt') || 'Enter card content:',
                });
                if (text && api) {
                    const appState = api.getAppState();
                    const centerX = -(appState.scrollX + appState.width / 2) + 200;
                    const centerY = -(appState.scrollY + appState.height / 2) + 150;
                    const el = {
                        type: 'text',
                        x: centerX,
                        y: centerY,
                        text: text.trim(),
                        fontSize: 20,
                        fontFamily: 1,
                        textAlign: 'left',
                        verticalAlign: 'top',
                    };
                    api.updateScene({ elements: [...api.getSceneElements(), el] });
                    toast({ title: t('excalidraw.insert_md'), tone: 'success' });
                }
            } else if (action === 'anyFile') {
                const noteName = await prompt({
                    title: t('excalidraw.insert_link') || 'Insert Note Link:',
                });
                if (noteName && api) {
                    const appState = api.getAppState();
                    const centerX = -(appState.scrollX + appState.width / 2) + 200;
                    const centerY = -(appState.scrollY + appState.height / 2) + 150;
                    const el = {
                        type: 'text',
                        x: centerX,
                        y: centerY,
                        text: `[[${noteName.trim()}]]`,
                        fontSize: 20,
                        fontFamily: 1,
                        textAlign: 'left',
                        verticalAlign: 'top',
                    };
                    api.updateScene({ elements: [...api.getSceneElements(), el] });
                    toast({ title: t('excalidraw.insert_link'), tone: 'success' });
                }
            }
        });
        return () => {
            registerExcalidrawActionHandler(null);
        };
    }, [api, toast]);

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

    const initialScene = parseExcalidrawBody(content).data;

    const persistChanges = useCallback(
        (nextJson: string) => {
            if (nextJson !== lastSavedRef.current) {
                lastSavedRef.current = nextJson;
                onChange(nextJson);
                setIsSaved(true);
            }
        },
        [onChange],
    );

    const handleCanvasChange = useCallback(
        (elements: readonly any[], appState: any, files: any) => {
            const isLibOpen = Boolean(
                appState.openSidebar && (appState.openSidebar.name === 'default' || appState.openSidebar.name === 'customSidebar')
            );
            setLibraryOpen(isLibOpen);
            setIsSaved(false);
            window.clearTimeout(saveTimerRef.current);
            saveTimerRef.current = window.setTimeout(() => {
                const scene: ExcalidrawSceneData = {
                    elements: elements as any[],
                    appState,
                    files,
                };
                const nextJson = serializeExcalidrawBody(scene);
                persistChanges(nextJson);
                setRawCode(nextJson);
            }, 600);
        },
        [persistChanges],
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
        persistChanges(nextJson);
        toast({ title: t('workspace.drawing_saved'), tone: 'success' });
    }, [api, lib, persistChanges, toast]);

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

    useEffect(() => {
        if (!canvasHostRef.current || !lib) return;
        if (!isolatedRootRef.current) {
            isolatedRootRef.current = ReactDOM.createRoot(canvasHostRef.current);
        }
        isolatedRootRef.current.render(
            <div className={`h-full w-full ${theme === 'dark' ? 'theme--dark' : ''}`}>
                <lib.Excalidraw
                    initialData={{
                        elements: initialScene.elements,
                        appState: {
                            ...initialScene.appState,
                            theme,
                        },
                        files: initialScene.files,
                    }}
                    theme={theme}
                    langCode={locale === 'zh-CN' ? 'zh-CN' : 'en'}
                    aiEnabled={true}
                    onChange={handleCanvasChange}
                    onExcalidrawAPI={(excalidrawApi: any) => setApi(excalidrawApi)}
                    UIOptions={{
                        canvasActions: {
                            loadScene: false,
                            saveToActiveFile: false,
                        },
                    }}
                >
                    {lib.TTDDialogTrigger && <lib.TTDDialogTrigger />}
                    {lib.DiagramToCodePlugin && (
                        <lib.DiagramToCodePlugin
                            generate={async () => ({ html: '<div>Wireframe Generated</div>' })}
                        />
                    )}
                    <lib.MainMenu>
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
            </div>
        );
    }, [lib, theme, locale, note.id, handleCanvasChange, handleManualSave, handleToggleViewMode]);

    useEffect(() => {
        return () => {
            const root = isolatedRootRef.current;
            if (root) {
                isolatedRootRef.current = null;
                queueMicrotask(() => {
                    try {
                        root.unmount();
                    } catch {
                    }
                });
            }
        };
    }, []);

    useEffect(() => {
        if (!canvasHostRef.current || viewMode !== 'canvas') return;
        const host = canvasHostRef.current;

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
            }
        };

        reparentMenu();

        const observer = new MutationObserver(() => {
            reparentMenu();
        });

        observer.observe(host, { childList: true, subtree: true });

        return () => {
            observer.disconnect();
        };
    }, [viewMode, lib]);


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
                                persistChanges(e.target.value);
                            }}
                            className="h-full w-full resize-none rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 font-mono text-xs leading-relaxed text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                        />
                    </div>
                )}

                <div
                    ref={canvasHostRef}
                    className="h-full w-full"
                    style={{ display: viewMode === 'canvas' && lib ? 'block' : 'none' }}
                />

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
                    <div className="absolute right-3 top-3 z-40 flex flex-col items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-1 shadow-md">
                        <Tooltip label={t('excalidraw.script_library')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.script_library')}
                                onClick={() => toast({ title: t('excalidraw.scripts_installed'), tone: 'success' })}
                                className="flex h-7 w-7 items-center justify-center rounded-full text-purple-500 hover:bg-[var(--bg-hover)]"
                            >
                                <Sparkles size={14} />
                            </button>
                        </Tooltip>

                        <Tooltip label={t('excalidraw.open_as_md')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.open_as_md')}
                                onClick={handleToggleViewMode}
                                className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                            >
                                <FileCode size={14} />
                            </button>
                        </Tooltip>

                        <Tooltip label={isFullscreen ? t('preview.excalidraw_exit_fullscreen') : t('preview.excalidraw_fullscreen')}>
                            <button
                                type="button"
                                aria-label={isFullscreen ? t('preview.excalidraw_exit_fullscreen') : t('preview.excalidraw_fullscreen')}
                                onClick={handleToggleFullscreen}
                                className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                            >
                                {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
                            </button>
                        </Tooltip>

                        <Tooltip label={t('excalidraw.library')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.library')}
                                onClick={handleToggleLibrary}
                                className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
                                    libraryOpen
                                        ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                                }`}
                            >
                                <Library size={14} />
                            </button>
                        </Tooltip>
                    </div>
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
                    />
                )}
            </div>
        </div>
    );
};
