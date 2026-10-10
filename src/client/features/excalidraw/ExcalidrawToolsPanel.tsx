import React, { useState } from 'react';
import {
    Copy,
    Download,
    Eye,
    FileCode,
    FileText,
    Grid,
    Globe,
    Link,
    Maximize,
    Moon,
    Sigma,
    Sun,
    Trash2,
    Wrench,
    X,
    Zap,
} from 'lucide-react';
import { t } from '../../lib/i18n';
import { downloadBlob, safeFileName } from '../../lib/export-note';
import { prompt } from '../../components/overlay';
import { useUi } from '../../store/ui';
import type { ExcalidrawLib } from '../../lib/markdown/excalidraw';

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
    const [activeTab, setActiveTab] = useState<'utility' | 'export' | 'insert'>('utility');

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
        const centerX = appState.scrollX + appState.width / 2;
        const centerY = appState.scrollY + appState.height / 2;

        const newElement = {
            type: 'text',
            x: -centerX,
            y: -centerY,
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

    return (
        <aside
            className="absolute top-12 right-2 bottom-2 z-50 flex w-72 flex-col rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-3 shadow-xl"
            aria-label={t('excalidraw.tools_panel')}
        >
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

            <div className="mt-2 flex rounded-lg bg-[var(--bg-inset)] p-0.5 text-xs">
                <button
                    type="button"
                    onClick={() => setActiveTab('utility')}
                    className={`flex-1 rounded-md py-1 font-medium transition-colors ${
                        activeTab === 'utility'
                            ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-sm'
                            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                >
                    {t('excalidraw.tool_utility')}
                </button>
                <button
                    type="button"
                    onClick={() => setActiveTab('export')}
                    className={`flex-1 rounded-md py-1 font-medium transition-colors ${
                        activeTab === 'export'
                            ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-sm'
                            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                >
                    {t('excalidraw.tool_export')}
                </button>
                <button
                    type="button"
                    onClick={() => setActiveTab('insert')}
                    className={`flex-1 rounded-md py-1 font-medium transition-colors ${
                        activeTab === 'insert'
                            ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-sm'
                            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                >
                    {t('excalidraw.tool_insert')}
                </button>
            </div>

            <div className="mt-3 flex-1 overflow-y-auto space-y-1 text-xs">
                {activeTab === 'utility' && (
                    <>
                        <button
                            type="button"
                            onClick={handleZoomToFit}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            <Maximize size={14} />
                            {t('preview.excalidraw_fit')}
                        </button>
                        <button
                            type="button"
                            onClick={onToggleTheme}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            {dark ? <Sun size={14} /> : <Moon size={14} />}
                            {dark ? 'Light Mode' : 'Dark Mode'}
                        </button>
                        <button
                            type="button"
                            onClick={handleToggleZenMode}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            <Zap size={14} />
                            {t('excalidraw.zen_mode')}
                        </button>
                        <button
                            type="button"
                            onClick={handleToggleViewMode}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            <Eye size={14} />
                            {t('excalidraw.view_mode')}
                        </button>
                        <button
                            type="button"
                            onClick={handleToggleGrid}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            <Grid size={14} />
                            {t('excalidraw.grid_mode')}
                        </button>
                        <div className="my-1 border-t border-[var(--border-subtle)]" />
                        <button
                            type="button"
                            onClick={handleClearCanvas}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[var(--danger)] hover:bg-[var(--bg-hover)]"
                        >
                            <Trash2 size={14} />
                            {t('excalidraw.clear_canvas')}
                        </button>
                    </>
                )}

                {activeTab === 'export' && (
                    <>
                        <button
                            type="button"
                            onClick={handleExportPng}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            <Download size={14} />
                            {t('excalidraw.export_png')}
                        </button>
                        <button
                            type="button"
                            onClick={handleExportSvg}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            <Download size={14} />
                            {t('excalidraw.export_svg')}
                        </button>
                        <button
                            type="button"
                            onClick={handleCopyPng}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            <Copy size={14} />
                            {t('excalidraw.copy_png')}
                        </button>
                        <button
                            type="button"
                            onClick={handleCopySvg}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            <Copy size={14} />
                            {t('excalidraw.copy_svg')}
                        </button>
                        <div className="my-1 border-t border-[var(--border-subtle)]" />
                        <button
                            type="button"
                            onClick={handleExportJson}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            <FileCode size={14} />
                            {t('excalidraw.export_excalidraw')}
                        </button>
                    </>
                )}

                {activeTab === 'insert' && (
                    <>
                        <button
                            type="button"
                            onClick={handleInsertLatex}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            <Sigma size={14} />
                            {t('excalidraw.insert_latex')}
                        </button>
                        <button
                            type="button"
                            onClick={handleInsertLink}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            <Link size={14} />
                            {t('excalidraw.insert_link')}
                        </button>
                        <button
                            type="button"
                            onClick={() => handleInsertText()}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            <FileText size={14} />
                            {t('excalidraw.insert_md')}
                        </button>
                        <button
                            type="button"
                            onClick={handleEmbedWeb}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                            <Globe size={14} />
                            {t('excalidraw.embed_web')}
                        </button>
                    </>
                )}
            </div>
        </aside>
    );
};
