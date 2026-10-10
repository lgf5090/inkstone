import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import {
    ArrowLeft,
    Brush,
    Check,
    Eye,
    FileCode,
    Frame,
    Globe,
    Image as ImageIcon,
    Lasso,
    Maximize,
    Minimize,
    PaintBucket,
    Save,
    Sparkles,
    Star,
    Target,
    Wrench,
    X,
} from 'lucide-react';
import type { NoteSummary } from '@shared/types';
import { t } from '../../lib/i18n';
import { IconButton } from '../../components/primitives';
import { prompt, Tooltip } from '../../components/overlay';
import { useBreakpoint } from '../../lib/hooks';
import { useNotes } from '../../store/notes';
import { useUi, type WorkspacePane } from '../../store/ui';
import {
    loadExcalidrawLib,
    parseExcalidrawBody,
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
    const [isSaved, setIsSaved] = useState(true);

    const [theme, setTheme] = useState<'light' | 'dark'>(() => {
        return (document.documentElement.dataset.theme as 'light' | 'dark') ?? 'dark';
    });

    const fileInputRef = useRef<HTMLInputElement>(null);
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
                const nextJson = serializeExcalidrawBody(currentData);
                setRawCode(nextJson);
            }
            setViewMode('code');
        } else {
            try {
                const parsed = parseExcalidrawBody(rawCode).data;
                if (api) {
                    api.updateScene({
                        elements: parsed.elements,
                        appState: parsed.appState,
                    });
                    if (parsed.files) {
                        api.addFiles(Object.values(parsed.files));
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
                    onChange={handleCanvasChange}
                    onExcalidrawAPI={(excalidrawApi: any) => setApi(excalidrawApi)}
                    UIOptions={{
                        canvasActions: {
                            loadScene: false,
                            saveToActiveFile: false,
                        },
                    }}
                >
                    <lib.MainMenu>
                        <lib.MainMenu.DefaultItems.ChangeCanvasBackground />
                        <lib.MainMenu.DefaultItems.ToggleTheme />
                        <lib.MainMenu.DefaultItems.ClearCanvas />
                        <lib.MainMenu.Separator />
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
                            onSelect={handleToggleViewMode}
                            icon={<FileCode size={14} />}
                        >
                            {t('excalidraw.open_as_md')}
                        </lib.MainMenu.Item>
                    </lib.MainMenu>
                </lib.Excalidraw>
            </div>
        );
    }, [lib, theme, note.id, handleCanvasChange, handleManualSave, handleToggleViewMode]);

    useEffect(() => {
        return () => {
            if (isolatedRootRef.current) {
                isolatedRootRef.current.unmount();
                isolatedRootRef.current = null;
            }
        };
    }, []);

    const handleToggleFullscreen = () => {
        if (!containerRef.current) return;
        if (!document.fullscreenElement) {
            void containerRef.current.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
        } else {
            void document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
        }
    };

    const handlePickImage = () => {
        fileInputRef.current?.click();
    };

    const handleImageFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !api) return;
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result as string;
            const fileId = `file_${Date.now()}`;
            const imageElement = {
                type: 'image',
                x: 100,
                y: 100,
                width: 300,
                height: 200,
                fileId,
                status: 'saved',
            };
            api.addFiles([
                {
                    id: fileId,
                    dataURL: dataUrl,
                    mimeType: file.type,
                    created: Date.now(),
                },
            ]);
            api.updateScene({
                elements: [...api.getSceneElements(), imageElement],
            });
            toast({ title: t('excalidraw.insert_image'), tone: 'success' });
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    };

    const handleActivateTool = (toolName: string) => {
        if (!api) return;
        if (typeof api.setActiveTool === 'function') {
            api.setActiveTool({ type: toolName });
        }
    };

    const handleEmbedWeb = async () => {
        const url = await prompt({ title: t('excalidraw.embed_web_prompt') || 'Enter URL to embed:' });
        if (!url || !api) return;
        const appState = api.getAppState();
        const centerX = -(appState.scrollX + appState.width / 2) + 200;
        const centerY = -(appState.scrollY + appState.height / 2) + 150;
        const embedElement = {
            type: 'embeddable',
            x: centerX,
            y: centerY,
            width: 450,
            height: 320,
            link: url.trim(),
        };
        api.updateScene({ elements: [...api.getSceneElements(), embedElement] });
    };

    const handleAITools = async () => {
        if (!api) return;
        const query = await prompt({ title: t('excalidraw.ai_tools') || 'Describe diagram to generate:' });
        if (!query) return;
        toast({ title: t('excalidraw.ai_tools'), description: query, tone: 'default' });
    };

    return (
        <div
            ref={containerRef}
            className="relative flex h-full min-h-0 w-full flex-col bg-[var(--bg-base)] text-[var(--text-primary)]"
        >
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleImageFileSelected}
            />

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
                            <Wrench size={14} />
                        </IconButton>
                    </Tooltip>

                    <Tooltip label={isFullscreen ? t('preview.excalidraw_exit_fullscreen') : t('preview.excalidraw_fullscreen')}>
                        <IconButton
                            label={isFullscreen ? t('preview.excalidraw_exit_fullscreen') : t('preview.excalidraw_fullscreen')}
                            size="sm"
                            onClick={handleToggleFullscreen}
                        >
                            {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
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

            {viewMode === 'canvas' && lib && (
                <div className="absolute top-13 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1 shadow-lg">
                    <Tooltip label={t('excalidraw.insert_image')}>
                        <button
                            type="button"
                            aria-label={t('excalidraw.insert_image')}
                            onClick={handlePickImage}
                            className="rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            <ImageIcon size={15} />
                        </button>
                    </Tooltip>

                    <Tooltip label={t('excalidraw.frame_tool')}>
                        <button
                            type="button"
                            aria-label={t('excalidraw.frame_tool')}
                            onClick={() => handleActivateTool('frame')}
                            className="rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            <Frame size={15} />
                        </button>
                    </Tooltip>

                    <Tooltip label={t('excalidraw.embed_web')}>
                        <button
                            type="button"
                            aria-label={t('excalidraw.embed_web')}
                            onClick={handleEmbedWeb}
                            className="rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            <Globe size={15} />
                        </button>
                    </Tooltip>

                    <Tooltip label={t('excalidraw.draw_to_shape')}>
                        <button
                            type="button"
                            aria-label={t('excalidraw.draw_to_shape')}
                            onClick={() => handleActivateTool('freedraw')}
                            className="rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            <Brush size={15} />
                        </button>
                    </Tooltip>

                    <Tooltip label={t('excalidraw.laser_pointer')}>
                        <button
                            type="button"
                            aria-label={t('excalidraw.laser_pointer')}
                            onClick={() => handleActivateTool('laser')}
                            className="rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            <Target size={15} />
                        </button>
                    </Tooltip>

                    <Tooltip label={t('excalidraw.bucket_fill')}>
                        <button
                            type="button"
                            aria-label={t('excalidraw.bucket_fill')}
                            onClick={() => {
                                if (api) {
                                    api.updateScene({
                                        appState: { currentItemFillStyle: 'solid' },
                                    });
                                }
                            }}
                            className="rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            <PaintBucket size={15} />
                        </button>
                    </Tooltip>

                    <Tooltip label={t('excalidraw.lasso_tool')}>
                        <button
                            type="button"
                            aria-label={t('excalidraw.lasso_tool')}
                            onClick={() => handleActivateTool('selection')}
                            className="rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            <Lasso size={15} />
                        </button>
                    </Tooltip>

                    <div className="mx-1 h-4 w-px bg-[var(--border-subtle)]" />

                    <Tooltip label={t('excalidraw.ai_tools')}>
                        <button
                            type="button"
                            aria-label={t('excalidraw.ai_tools')}
                            onClick={handleAITools}
                            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-[var(--accent)] hover:bg-[var(--bg-hover)]"
                        >
                            <Sparkles size={14} />
                            <span className="hidden sm:inline">{t('excalidraw.ai_tools')}</span>
                        </button>
                    </Tooltip>
                </div>
            )}

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
