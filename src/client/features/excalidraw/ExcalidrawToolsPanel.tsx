import React from 'react';
import {
    Copy,
    Download,
    Eye,
    FileCode,
    FileText,
    Globe,
    Grid,
    Info,
    Link as LinkIcon,
    Maximize,
    Moon,
    Sigma,
    Sun,
    Trash2,
    Workflow,
    Wrench,
    X,
    Zap,
} from 'lucide-react';
import { t } from '../../lib/i18n';
import { downloadBlob, safeFileName } from '../../lib/export-note';
import { prompt, Tooltip } from '../../components/overlay';
import { useUi } from '../../store/ui';
import { convertMermaidToExcalidrawElements, type ExcalidrawLib } from '../../lib/markdown/excalidraw';

interface ExcalidrawToolsPanelProps {
    open: boolean;
    onClose: () => void;
    api: any;
    lib: ExcalidrawLib;
    title: string;
    dark: boolean;
    onToggleTheme: () => void;
}

export const ExcalidrawToolsPanel: React.FC<ExcalidrawToolsPanelProps> = ({
    open,
    onClose,
    api,
    lib,
    title,
    dark,
    onToggleTheme,
}) => {
    const toast = useUi((s) => s.toast);

    if (!open) return null;

    const baseFileName = safeFileName(title.replace(/\.excalidraw$/i, '')) || 'drawing';

    const handleExportPng = async () => {
        if (!api || !lib) return;
        try {
            const elements = api.getSceneElements();
            const appState = api.getAppState();
            const files = api.getFiles();
            const blob = await lib.exportToBlob({
                elements,
                appState: { ...appState, exportWithDarkMode: dark },
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
            const appState = api.getAppState();
            const files = api.getFiles();
            const svg = await lib.exportToSvg({
                elements,
                appState: { ...appState, exportWithDarkMode: dark },
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
            const appState = api.getAppState();
            const files = api.getFiles();
            const blob = await lib.exportToBlob({
                elements,
                appState: { ...appState, exportWithDarkMode: dark },
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

    const handleCopySvg = async () => {
        if (!api || !lib) return;
        try {
            const elements = api.getSceneElements();
            const appState = api.getAppState();
            const files = api.getFiles();
            const svg = await lib.exportToSvg({
                elements,
                appState: { ...appState, exportWithDarkMode: dark },
                files,
            });
            const serializer = new XMLSerializer();
            const svgString = serializer.serializeToString(svg);
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(svgString);
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
            const appState = api.getAppState();
            const files = api.getFiles();
            const json = lib.serializeAsJSON(elements, appState, files, 'local');
            const blob = new Blob([json], { type: 'application/json' });
            downloadBlob(`${baseFileName}.excalidraw`, blob);
            toast({ title: t('excalidraw.export_excalidraw'), tone: 'success' });
        } catch (err: unknown) {
            toast({ title: t('excalidraw.export_failed'), description: String(err), tone: 'danger' });
        }
    };

    const handleZoomToFit = () => {
        if (api && typeof api.scrollToContent === 'function') {
            api.scrollToContent(undefined, { fitToViewport: true });
        }
    };

    const handleToggleZenMode = () => {
        if (!api) return;
        const appState = api.getAppState();
        api.updateScene({ appState: { zenModeEnabled: !appState.zenModeEnabled } });
    };

    const handleToggleViewMode = () => {
        if (!api) return;
        const appState = api.getAppState();
        api.updateScene({ appState: { viewModeEnabled: !appState.viewModeEnabled } });
    };

    const handleToggleGrid = () => {
        if (!api) return;
        const appState = api.getAppState();
        api.updateScene({ appState: { gridSize: appState.gridSize ? null : 20 } });
    };

    const handleClearCanvas = () => {
        if (!api) return;
        api.resetScene();
    };

    const handleInsertText = async (defaultText = '') => {
        if (!api) return;
        const text = await prompt({ title: t('excalidraw.insert_md_prompt') || 'Enter text:', defaultValue: defaultText });
        if (!text) return;
        const appState = api.getAppState();
        const centerX = -(appState.scrollX + appState.width / 2) + 200;
        const centerY = -(appState.scrollY + appState.height / 2) + 150;

        const newElement = {
            type: 'text',
            x: centerX,
            y: centerY,
            text,
            fontSize: 20,
            fontFamily: 1,
            textAlign: 'left',
            verticalAlign: 'top',
        };
        api.updateScene({ elements: [...api.getSceneElements(), newElement] });
    };

    const handleInsertLink = async () => {
        const noteName = await prompt({ title: t('excalidraw.insert_link') || 'Insert Note Link:' });
        if (noteName) {
            void handleInsertText(`[[${noteName.trim()}]]`);
        }
    };

    const handleInsertLatex = async () => {
        const latex = await prompt({ title: t('excalidraw.insert_latex_prompt') || 'Enter LaTeX formula:' });
        if (latex) {
            void handleInsertText(`$$${latex.trim()}$$`);
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
            width: 400,
            height: 300,
            link: url.trim(),
        };
        api.updateScene({ elements: [...api.getSceneElements(), embedElement] });
    };

    const handleInsertMermaid = async () => {
        if (!api) return;
        const defaultCode = 'graph TD\n  A[Start] --> B(Work)\n  B --> C{Done?}\n  C -->|Yes| D[End]';
        const code = await prompt({
            title: t('excalidraw.mermaid_to_excalidraw') || 'Mermaid to Excalidraw:',
            defaultValue: defaultCode,
        });
        if (!code) return;
        try {
            const elements = convertMermaidToExcalidrawElements(code);
            if (elements.length > 0) {
                api.updateScene({ elements: [...api.getSceneElements(), ...elements] });
                toast({ title: t('excalidraw.mermaid_to_excalidraw'), tone: 'success' });
            } else {
                toast({ title: t('excalidraw.mermaid_to_excalidraw'), description: 'No elements parsed', tone: 'warning' });
            }
        } catch (err: unknown) {
            toast({ title: t('excalidraw.mermaid_to_excalidraw'), description: String(err), tone: 'danger' });
        }
    };

    return (
        <aside
            className="absolute top-12 right-2 bottom-2 z-50 flex w-72 flex-col rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-3 shadow-xl"
            aria-label={t('excalidraw.tools_panel')}
        >
            <div className="flex justify-center py-1 cursor-grab text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                <svg viewBox="0 0 228 26" className="w-24 h-3.5" aria-hidden="true" focusable="false">
                    <path
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        d="M40,7 h148 M40,13 h148 M40,19 h148"
                    />
                </svg>
            </div>

            <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-2">
                <span className="flex items-center gap-1.5 font-sans text-xs font-semibold text-[var(--text-primary)]">
                    <Wrench size={14} className="text-[var(--accent)]" />
                    {t('excalidraw.tools_panel')}
                </span>
                <button
                    type="button"
                    aria-label={t('common.close')}
                    onClick={onClose}
                    className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                    <X size={14} />
                </button>
            </div>

            <div className="mt-2.5 flex-1 overflow-y-auto space-y-3 pr-0.5 text-xs">
                <fieldset className="rounded-lg border border-[var(--border-subtle)] p-2">
                    <legend className="px-1 text-[11px] font-semibold text-[var(--text-tertiary)]">
                        {t('excalidraw.utility_actions')}
                    </legend>
                    <div className="grid grid-cols-5 gap-1.5 pt-1">
                        <Tooltip label={t('preview.excalidraw_fit')}>
                            <button
                                type="button"
                                aria-label={t('preview.excalidraw_fit')}
                                onClick={handleZoomToFit}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                            >
                                <Maximize size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={dark ? 'Light Mode' : 'Dark Mode'}>
                            <button
                                type="button"
                                aria-label={dark ? 'Light Mode' : 'Dark Mode'}
                                onClick={onToggleTheme}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                            >
                                {dark ? <Sun size={15} /> : <Moon size={15} />}
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.zen_mode')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.zen_mode')}
                                onClick={handleToggleZenMode}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                            >
                                <Zap size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.view_mode')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.view_mode')}
                                onClick={handleToggleViewMode}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                            >
                                <Eye size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.grid_mode')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.grid_mode')}
                                onClick={handleToggleGrid}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                            >
                                <Grid size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.script_library')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.script_library')}
                                onClick={() => toast({ title: t('excalidraw.scripts_installed'), tone: 'success' })}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                            >
                                <Wrench size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.about_excalidraw')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.about_excalidraw')}
                                onClick={() => toast({ title: 'Excalidraw', description: 'Obsidian-Excalidraw Port v2.2.5', tone: 'default' })}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                            >
                                <Info size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.clear_canvas')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.clear_canvas')}
                                onClick={handleClearCanvas}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--danger)] hover:bg-[var(--bg-hover)]"
                            >
                                <Trash2 size={15} />
                            </button>
                        </Tooltip>
                    </div>
                </fieldset>

                <fieldset className="rounded-lg border border-[var(--border-subtle)] p-2">
                    <legend className="px-1 text-[11px] font-semibold text-[var(--text-tertiary)]">
                        {t('excalidraw.export_actions')}
                    </legend>
                    <div className="grid grid-cols-5 gap-1.5 pt-1">
                        <Tooltip label={t('excalidraw.export_png')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.export_png')}
                                onClick={handleExportPng}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                            >
                                <Download size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.export_svg')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.export_svg')}
                                onClick={handleExportSvg}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                            >
                                <FileCode size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.copy_png')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.copy_png')}
                                onClick={handleCopyPng}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                            >
                                <Copy size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.copy_svg')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.copy_svg')}
                                onClick={handleCopySvg}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                            >
                                <Copy size={15} className="text-[var(--accent)]" />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.export_excalidraw')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.export_excalidraw')}
                                onClick={handleExportJson}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                            >
                                <Download size={15} className="text-[var(--accent)]" />
                            </button>
                        </Tooltip>
                    </div>
                </fieldset>

                <fieldset className="rounded-lg border border-[var(--border-subtle)] p-2">
                    <legend className="px-1 text-[11px] font-semibold text-[var(--text-tertiary)]">
                        {t('excalidraw.insert_actions')}
                    </legend>
                    <div className="grid grid-cols-5 gap-1.5 pt-1">
                        <Tooltip label={t('excalidraw.insert_latex')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.insert_latex')}
                                onClick={handleInsertLatex}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                            >
                                <Sigma size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.insert_link')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.insert_link')}
                                onClick={handleInsertLink}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                            >
                                <LinkIcon size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.insert_md')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.insert_md')}
                                onClick={() => handleInsertText()}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                            >
                                <FileText size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.embed_web')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.embed_web')}
                                onClick={handleEmbedWeb}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                            >
                                <Globe size={15} />
                            </button>
                        </Tooltip>
                        <Tooltip label={t('excalidraw.mermaid_to_excalidraw')}>
                            <button
                                type="button"
                                aria-label={t('excalidraw.mermaid_to_excalidraw')}
                                onClick={handleInsertMermaid}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--accent)] hover:bg-[var(--bg-hover)]"
                            >
                                <Workflow size={15} />
                            </button>
                        </Tooltip>
                    </div>
                </fieldset>
            </div>
        </aside>
    );
};
