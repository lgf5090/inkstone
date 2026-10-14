import React, { useEffect, useRef } from 'react';
import {
    Download,
    FileCode,
    FileDown,
    FileText,
    Globe,
    Grid,
    Image as ImageIcon,
    Info,
    Link as LinkIcon,
    Lock,
    Maximize,
    Megaphone,
    Save,
    Scan,
    Search,
    Sigma,
    SlidersHorizontal,
    Sparkles,
    Trash2,
    Tv,
    Workflow,
} from 'lucide-react';
import { t } from '../../lib/i18n';
import { downloadBlob, safeFileName } from '../../lib/export-note';
import { prompt, Tooltip } from '../../components/overlay';
import { useUi } from '../../store/ui';
import { convertMermaidToExcalidrawElements, type ExcalidrawLib } from '../../lib/markdown/excalidraw';
import { useExcalidrawSettingsStore } from './excalidraw-settings-store';
import {
    getViewportCenterInScene,
    insertEmbedToCanvas,
    insertPdfCardToCanvas,
    promptAndInsertLatex,
    promptAndInsertLink,
    promptAndInsertNoteCard,
    zoomToFitScene,
} from './excalidraw-canvas-actions';
import { applySceneElements } from '../../lib/markdown/excalidraw/loader';

export interface ExcalidrawToolsPanelProps {
    open: boolean;
    onClose: () => void;
    api: any;
    lib: ExcalidrawLib;
    title: string;
    dark: boolean;
    onToggleTheme?: () => void;
    onToggleFullscreen?: () => void;
    onSave?: () => void;
    onOpenAiModal?: (tab?: 'ai' | 'mermaid') => void;
}

export const ExcalidrawToolsPanel: React.FC<ExcalidrawToolsPanelProps> = ({
    open,
    onClose,
    api,
    lib,
    title,
    dark,
    onToggleFullscreen,
    onSave,
    onOpenAiModal,
}) => {
    const toast = useUi((s) => s.toast);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const pdfInputRef = useRef<HTMLInputElement>(null);
    const panelRef = useRef<HTMLElement>(null);

    useEffect(() => {
        if (!open) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
                const target = e.target as HTMLElement;
                if (!target.closest?.('button[aria-label="' + t('excalidraw.tools_panel') + '"]') && !target.closest?.('[data-excalidraw-tools]')) {
                    onClose();
                }
            }
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [open, onClose]);

    if (!open) return null;

    const baseFileName = safeFileName(title.replace(/\.excalidraw$/i, '')) || 'drawing';
    const appState = (typeof api?.getAppState === 'function' ? api.getAppState() : {}) as any;
    const isZen = Boolean(appState.zenModeEnabled);
    const isView = Boolean(appState.viewModeEnabled);
    const isGrid = Boolean(appState.gridSize);

    const handleExportPng = async () => {
        if (!api || !lib) return;
        try {
            const elements = api.getSceneElements();
            const currentAppState = api.getAppState();
            const files = api.getFiles();
            const settings = useExcalidrawSettingsStore.getState();
            const blob = await lib.exportToBlob({
                elements,
                appState: {
                    ...currentAppState,
                    exportWithDarkMode: dark,
                    exportBackground: settings.exportWithBackground,
                    exportScale: settings.pngExportScale,
                    exportPadding: settings.exportPaddingSVG,
                },
                exportPadding: settings.exportPaddingSVG,
                exportScale: settings.pngExportScale,
                files,
                mimeType: 'image/png',
            });
            downloadBlob(`${baseFileName}.png`, blob);
            toast({ title: t('excalidraw.export_png'), tone: 'success' });
        } catch (err: unknown) {
            toast({ title: t('excalidraw.export_failed'), description: String(err), tone: 'danger' });
        }
    };

    const handleExportSvg = async () => {
        if (!api || !lib) return;
        try {
            const elements = api.getSceneElements();
            const currentAppState = api.getAppState();
            const files = api.getFiles();
            const settings = useExcalidrawSettingsStore.getState();
            const svg = await lib.exportToSvg({
                elements,
                appState: {
                    ...currentAppState,
                    exportWithDarkMode: dark,
                    exportBackground: settings.exportWithBackground,
                    exportPadding: settings.exportPaddingSVG,
                },
                exportPadding: settings.exportPaddingSVG,
                files,
            });
            const serializer = new XMLSerializer();
            const svgString = serializer.serializeToString(svg);
            const blob = new Blob([svgString], { type: 'image/svg+xml' });
            downloadBlob(`${baseFileName}.svg`, blob);
            toast({ title: t('excalidraw.export_svg'), tone: 'success' });
        } catch (err: unknown) {
            toast({ title: t('excalidraw.export_failed'), description: String(err), tone: 'danger' });
        }
    };

    const handleCopyPng = async () => {
        if (!api || !lib) return;
        try {
            const elements = api.getSceneElements();
            const currentAppState = api.getAppState();
            const files = api.getFiles();
            const settings = useExcalidrawSettingsStore.getState();
            const blob = await lib.exportToBlob({
                elements,
                appState: {
                    ...currentAppState,
                    exportWithDarkMode: dark,
                    exportBackground: settings.exportWithBackground,
                    exportScale: settings.pngExportScale,
                    exportPadding: settings.exportPaddingSVG,
                },
                exportPadding: settings.exportPaddingSVG,
                exportScale: settings.pngExportScale,
                files,
                mimeType: 'image/png',
            });
            if (navigator.clipboard?.write) {
                await navigator.clipboard.write([
                    new ClipboardItem({ 'image/png': blob }),
                ]);
                toast({ title: t('excalidraw.copied_to_clipboard'), tone: 'success' });
            }
        } catch (err: unknown) {
            toast({ title: t('excalidraw.copy_failed'), description: String(err), tone: 'danger' });
        }
    };

    const handleExportJson = () => {
        if (!api || !lib) return;
        try {
            const elements = api.getSceneElements();
            const currentAppState = api.getAppState();
            const files = api.getFiles();
            const json = lib.serializeAsJSON(elements, currentAppState, files, 'local');
            const blob = new Blob([json], { type: 'application/json' });
            downloadBlob(`${baseFileName}.excalidraw`, blob);
            toast({ title: t('excalidraw.export_excalidraw'), tone: 'success' });
        } catch (err: unknown) {
            toast({ title: t('excalidraw.export_failed'), description: String(err), tone: 'danger' });
        }
    };

    const handleZoomToFit = () => {
        zoomToFitScene(api, panelRef.current?.parentElement);
    };

    const handleZoom100 = () => {
        if (api) {
            api.updateScene({ appState: { zoom: { value: 1 } } });
        }
    };

    const handleToggleZenMode = () => {
        if (!api) return;
        const current = api.getAppState ? api.getAppState() : {};
        api.updateScene({ appState: { zenModeEnabled: !current.zenModeEnabled } });
    };

    const handleToggleViewMode = () => {
        if (!api) return;
        const current = api.getAppState ? api.getAppState() : {};
        api.updateScene({ appState: { viewModeEnabled: !current.viewModeEnabled } });
    };

    const handleToggleGrid = () => {
        if (!api) return;
        const current = api.getAppState ? api.getAppState() : {};
        api.updateScene({ appState: { gridSize: current.gridSize ? null : 20 } });
    };

    const handleClearCanvas = () => {
        if (!api) return;
        if (typeof api.resetScene === 'function') {
            api.resetScene();
        } else {
            api.updateScene({ elements: [] });
        }
        if (onSave) {
            onSave();
        }
        toast({ title: t('excalidraw.clear_canvas'), tone: 'default' });
    };

    const handlePickImage = () => {
        fileInputRef.current?.click();
    };

    const handlePickPdf = () => {
        pdfInputRef.current?.click();
    };

    const handleImageFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !api) return;
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result as string;
            const fileId = `file_${Date.now()}`;
            const center = getViewportCenterInScene(api);
            const imageElement = {
                id: `img_${Date.now()}`,
                type: 'image',
                x: Math.round(center.x - 150),
                y: Math.round(center.y - 100),
                width: 300,
                height: 200,
                fileId,
                status: 'saved',
                scale: [1, 1],
                crop: null,
            };
            if (typeof api.addFiles === 'function') {
                api.addFiles([
                    {
                        id: fileId,
                        dataURL: dataUrl,
                        mimeType: file.type,
                        created: Date.now(),
                    },
                ]);
            }
            applySceneElements(api, [...(api.getSceneElements?.() || []), imageElement]);
            toast({ title: t('excalidraw.insert_image'), tone: 'success' });
        };
        reader.readAsDataURL(file);
    };

    const handlePdfFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !api) return;
        insertPdfCardToCanvas(api, file.name, dark);
        toast({ title: t('excalidraw.insert_pdf'), description: file.name, tone: 'success' });
    };

    const handleEmbedWeb = async () => {
        const url = await prompt({ title: t('excalidraw.embed_web_prompt') || 'Enter URL to embed:' });
        if (!url || !url.trim() || !api) return;
        insertEmbedToCanvas(api, url.trim());
        toast({ title: t('excalidraw.embed_web'), tone: 'success' });
    };

    const handleInsertMermaid = async () => {
        if (onOpenAiModal) {
            onOpenAiModal('mermaid');
            onClose();
            return;
        }
        if (!api) return;
        const defaultCode = 'graph TD\n  A[Start] --> B(Work)\n  B --> C{Done?}\n  C -->|Yes| D[End]';
        const code = await prompt({
            title: t('excalidraw.mermaid_to_excalidraw') || 'Mermaid to Excalidraw:',
            defaultValue: defaultCode,
        });
        if (!code) return;
        try {
            const center = getViewportCenterInScene(api);
            const elements = convertMermaidToExcalidrawElements(
                code,
                Math.round(center.x - 200),
                Math.round(center.y - 150),
            );
            if (elements.length > 0) {
                api.updateScene({ elements: [...(api.getSceneElements?.() || []), ...elements] });
                toast({ title: t('excalidraw.mermaid_to_excalidraw'), tone: 'success' });
            } else {
                toast({ title: t('excalidraw.mermaid_to_excalidraw'), description: 'No elements parsed', tone: 'warning' });
            }
        } catch (err: unknown) {
            toast({ title: t('excalidraw.mermaid_to_excalidraw'), description: String(err), tone: 'danger' });
        }
    };

    const handleFullscreenTrigger = () => {
        if (onToggleFullscreen) {
            onToggleFullscreen();
        } else if (typeof document !== 'undefined') {
            const block = panelRef.current?.closest('.excalidraw-block') || panelRef.current?.parentElement;
            if (!document.fullscreenElement && block?.requestFullscreen) {
                void block.requestFullscreen();
            } else if (document.exitFullscreen) {
                void document.exitFullscreen();
            }
        }
    };

    return (
        <aside
            ref={panelRef}
            className="absolute top-12 right-14 z-50 flex w-64 max-w-[calc(100%-2rem)] max-h-[calc(100%-4rem)] overflow-y-auto flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 shadow-2xl"
            aria-label={t('excalidraw.tools_panel')}
        >
            <div className="flex justify-center pt-0.5 pb-2 cursor-grab select-none">
                <div className="flex flex-col items-center justify-center gap-1 rounded-full bg-[var(--bg-raised)] px-6 py-1.5 border border-[var(--border-subtle)]">
                    <div className="h-0.5 w-16 rounded-full bg-[var(--text-tertiary)]" />
                    <div className="h-0.5 w-16 rounded-full bg-[var(--text-tertiary)]" />
                    <div className="h-0.5 w-16 rounded-full bg-[var(--text-tertiary)]" />
                </div>
            </div>

            <div className="flex flex-col gap-3 text-xs">
                <div>
                    <div className="mb-1.5 px-0.5 text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">
                        {t('excalidraw.utility_actions')}
                    </div>
                    <div className="grid grid-cols-5 gap-1.5">
                        <Tooltip label={t('settings.excalidraw')}>
                            <button
                                type="button"
                                aria-label={t('settings.excalidraw')}
                                onClick={() => {
                                    useUi.getState().openPanel('settings');
                                    onClose();
                                }}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs"
                            >
                                <SlidersHorizontal size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.help_and_issues')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.help_and_issues')}
                                onClick={() => window.open('https://github.com/zsviczian/obsidian-excalidraw-plugin', '_blank')}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs"
                            >
                                <Megaphone size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.about_excalidraw')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.about_excalidraw')}
                                onClick={() => window.open('https://excalidraw.com', '_blank')}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs"
                            >
                                <Info size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.zen_mode')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.zen_mode')}
                                onClick={handleToggleZenMode}
                                className={`flex h-9 w-9 items-center justify-center rounded-xl transition-colors shadow-xs ${
                                    isZen
                                        ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)] font-semibold'
                                        : 'bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                                }`}
                            >
                                <Tv size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('preview.excalidraw_fullscreen')}>
                            <button
                                type="button"
                                aria-label={t('preview.excalidraw_fullscreen')}
                                onClick={handleFullscreenTrigger}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs"
                            >
                                <Maximize size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('common.zoom_in')}>
                            <button
                                type="button"
                                aria-label={t('common.zoom_in')}
                                onClick={handleZoom100}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs"
                            >
                                <Search size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('preview.excalidraw_fit')}>
                            <button
                                type="button"
                                aria-label={t('preview.excalidraw_fit')}
                                onClick={handleZoomToFit}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs"
                            >
                                <Scan size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.view_mode')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.view_mode')}
                                onClick={handleToggleViewMode}
                                className={`flex h-9 w-9 items-center justify-center rounded-xl transition-colors shadow-xs ${
                                    isView
                                        ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)] font-semibold'
                                        : 'bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                                }`}
                            >
                                <Lock size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.grid_mode')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.grid_mode')}
                                onClick={handleToggleGrid}
                                className={`flex h-9 w-9 items-center justify-center rounded-xl transition-colors shadow-xs ${
                                    isGrid
                                        ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)] font-semibold'
                                        : 'bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                                }`}
                            >
                                <Grid size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('workspace.save_drawing')}>
                            <button
                                type="button"
                                aria-label={t('workspace.save_drawing')}
                                onClick={() => {
                                    if (onSave) {
                                        onSave();
                                    } else {
                                        handleExportJson();
                                    }
                                }}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs"
                            >
                                <Save size={15} />
                            </button>
                        </Tooltip>
                    </div>
                </div>

                <div>
                    <div className="mb-1.5 px-0.5 text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">
                        {t('excalidraw.export_actions')}
                    </div>
                    <div className="grid grid-cols-5 gap-1.5">
                        <Tooltip label={t('excalidraw.export_png')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.export_png')}
                                onClick={handleExportPng}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs"
                            >
                                <Download size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.copy_png')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.copy_png')}
                                onClick={handleCopyPng}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs"
                            >
                                <ImageIcon size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.export_svg')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.export_svg')}
                                onClick={handleExportSvg}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs"
                            >
                                <FileCode size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.export_excalidraw')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.export_excalidraw')}
                                onClick={handleExportJson}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs"
                            >
                                <Grid size={15} />
                            </button>
                        </Tooltip>
                    </div>
                </div>

                <div>
                    <div className="mb-1.5 px-0.5 text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">
                        {t('excalidraw.insert_actions')}
                    </div>
                    <div className="grid grid-cols-5 gap-1.5">
                        <Tooltip label={t('excalidraw.insert_md')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.insert_md')}
                                onClick={() => void promptAndInsertNoteCard(api, dark)}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs"
                            >
                                <FileText size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.insert_image')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.insert_image')}
                                onClick={handlePickImage}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs"
                            >
                                <ImageIcon size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.insert_pdf')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.insert_pdf')}
                                onClick={handlePickPdf}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs"
                            >
                                <FileDown size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.embed_web')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.embed_web')}
                                onClick={handleEmbedWeb}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs"
                            >
                                <Globe size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={`${t('excalidraw.text_to_diagram')} [AI]`}>
                            <button
                                type="button"
                                aria-label={`${t('excalidraw.text_to_diagram')} [AI]`}
                                onClick={() => {
                                    if (onOpenAiModal) {
                                        onOpenAiModal('ai');
                                        onClose();
                                    } else {
                                        void handleInsertMermaid();
                                    }
                                }}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent-on-soft)] hover:bg-[var(--accent)] hover:text-white transition-colors shadow-xs"
                            >
                                <Sparkles size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.mermaid_to_excalidraw')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.mermaid_to_excalidraw')}
                                onClick={handleInsertMermaid}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs"
                            >
                                <Workflow size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.insert_latex')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.insert_latex')}
                                onClick={() => void promptAndInsertLatex(api, dark)}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs"
                            >
                                <Sigma size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.insert_link')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.insert_link')}
                                onClick={() => void promptAndInsertLink(api, dark)}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs"
                            >
                                <LinkIcon size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.clear_canvas')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.clear_canvas')}
                                onClick={handleClearCanvas}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs"
                            >
                                <Trash2 size={15} />
                            </button>
                        </Tooltip>
                    </div>
                </div>
            </div>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleImageFileSelected}
            />
            <input
                ref={pdfInputRef}
                type="file"
                accept=".pdf,application/pdf"
                className="hidden"
                onChange={handlePdfFileSelected}
            />
        </aside>
    );
};
