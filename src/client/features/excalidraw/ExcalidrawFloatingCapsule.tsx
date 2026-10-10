import React from 'react';
import {
    FileCode,
    Library,
    Maximize,
    Minimize,
    Moon,
    Scan,
    SlidersHorizontal,
    Sparkles,
    Sun,
} from 'lucide-react';
import { Tooltip } from '../../components/overlay';
import { t } from '../../lib/i18n';

export interface ExcalidrawFloatingCapsuleProps {
    isFullscreen: boolean;
    onToggleFullscreen: () => void;
    onZoomToFit: () => void;
    libraryOpen: boolean;
    onToggleLibrary: () => void;
    toolsPanelOpen: boolean;
    onToggleToolsPanel: () => void;
    onToggleCode?: () => void;
    onScriptLibrary?: () => void;
    isDark?: boolean;
    onToggleTheme?: () => void;
}

export const ExcalidrawFloatingCapsule: React.FC<ExcalidrawFloatingCapsuleProps> = ({
    isFullscreen,
    onToggleFullscreen,
    onZoomToFit,
    libraryOpen,
    onToggleLibrary,
    toolsPanelOpen,
    onToggleToolsPanel,
    onToggleCode,
    onScriptLibrary,
    isDark,
    onToggleTheme,
}) => {
    return (
        <div className="absolute right-3 top-3 z-40 flex flex-col items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-1 shadow-md">
            {onToggleTheme && (
                <Tooltip label={t('preview.excalidraw_toggle_theme')}>
                    <button
                        type="button"
                        aria-label={t('preview.excalidraw_toggle_theme')}
                        onClick={onToggleTheme}
                        className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    >
                        {isDark ? <Sun size={14} /> : <Moon size={14} />}
                    </button>
                </Tooltip>
            )}
            {onScriptLibrary && (
                <Tooltip label={t('excalidraw.script_library')}>
                    <button
                        type="button"
                        aria-label={t('excalidraw.script_library')}
                        onClick={onScriptLibrary}
                        className="flex h-7 w-7 items-center justify-center rounded-full text-purple-500 hover:bg-[var(--bg-hover)]"
                    >
                        <Sparkles size={14} />
                    </button>
                </Tooltip>
            )}

            {onToggleCode && (
                <Tooltip label={t('excalidraw.open_as_md')}>
                    <button
                        type="button"
                        aria-label={t('excalidraw.open_as_md')}
                        onClick={onToggleCode}
                        className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    >
                        <FileCode size={14} />
                    </button>
                </Tooltip>
            )}

            <Tooltip label={t('preview.excalidraw_fit')}>
                <button
                    type="button"
                    aria-label={t('preview.excalidraw_fit')}
                    onClick={onZoomToFit}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                    <Scan size={14} />
                </button>
            </Tooltip>

            <Tooltip label={t('excalidraw.tools_panel')}>
                <button
                    type="button"
                    aria-label={t('excalidraw.tools_panel')}
                    onClick={onToggleToolsPanel}
                    className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
                        toolsPanelOpen
                            ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                    }`}
                >
                    <SlidersHorizontal size={14} />
                </button>
            </Tooltip>

            <Tooltip label={t('excalidraw.library')}>
                <button
                    type="button"
                    aria-label={t('excalidraw.library')}
                    onClick={onToggleLibrary}
                    className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
                        libraryOpen
                            ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                    }`}
                >
                    <Library size={14} />
                </button>
            </Tooltip>

            <Tooltip label={isFullscreen ? t('preview.excalidraw_exit_fullscreen') : t('preview.excalidraw_fullscreen')}>
                <button
                    type="button"
                    aria-label={isFullscreen ? t('preview.excalidraw_exit_fullscreen') : t('preview.excalidraw_fullscreen')}
                    onClick={onToggleFullscreen}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                    {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
                </button>
            </Tooltip>
        </div>
    );
};
