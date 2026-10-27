import type { ReactNode, RefObject } from 'react'
import {
    Eraser,
    Highlighter,
    LassoSelect,
    Paintbrush,
    Pencil,
    PenLine,
    Plus,
    Redo2,
    Save,
    Scan,
    SidebarClose,
    Trash2,
    Type,
    Undo2,
    Check,
    Download,
} from 'lucide-react'
import { IconButton } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import { t, type MessageKey } from '../../lib/i18n'
import type { InkTool } from '../../lib/inkpad/types'
import type { InkEngine } from './ink-engine-types'

export type InkSaveState = 'saved' | 'pending' | 'saving' | 'error'

const TOOLS: Array<{ tool: InkTool; labelKey: MessageKey; icon: ReactNode; combo?: string }> = [
    { tool: 'pen', labelKey: 'ink.tool.pen', icon: <PenLine size={16} />, combo: 'P' },
    { tool: 'pencil', labelKey: 'ink.tool.pencil', icon: <Pencil size={16} />, combo: 'B' },
    { tool: 'marker', labelKey: 'ink.tool.marker', icon: <Paintbrush size={16} />, combo: 'M' },
    { tool: 'highlighter', labelKey: 'ink.tool.highlighter', icon: <Highlighter size={16} />, combo: 'H' },
    { tool: 'eraser', labelKey: 'ink.tool.eraser', icon: <Eraser size={16} />, combo: 'E' },
    { tool: 'lasso', labelKey: 'ink.tool.lasso', icon: <LassoSelect size={16} />, combo: 'L' },
]

export function InkToolbar({
    engine,
    tool,
    saveState,
    selectionCount,
    canUndo,
    canRedo,
    focusMode,
    insertButtonRef,
    exportButtonRef,
    onTool,
    onSave,
    onInsertMenu,
    onInsertText,
    onExportMenu,
    onFrame,
    onFocus,
}: {
    engine: InkEngine
    tool: InkTool
    saveState: InkSaveState
    selectionCount: number
    canUndo: boolean
    canRedo: boolean
    focusMode: boolean
    insertButtonRef: RefObject<HTMLElement | null>
    exportButtonRef: RefObject<HTMLElement | null>
    onTool: (tool: InkTool) => void
    onSave: () => void
    onInsertMenu: () => void
    onInsertText: () => void
    onExportMenu: () => void
    onFrame: () => void
    onFocus: () => void
}) {
    return (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2.5 py-1.5">
            <div className="flex shrink-0 items-center gap-0.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-0.5" role="group" aria-label={t('ink.tool.group')}>
                {TOOLS.map((entry) => {
                    const label = t(entry.labelKey)
                    return (
                        <Tooltip key={entry.tool} label={label} combo={entry.combo}>
                            <IconButton label={label} size="sm" active={tool === entry.tool} onClick={() => onTool(entry.tool)}>
                                {entry.icon}
                            </IconButton>
                        </Tooltip>
                    )
                })}
            </div>
            <div className="ml-1 flex shrink-0 items-center gap-0.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-0.5">
                <IconButton label={t('ink.action.undo')} size="sm" disabled={!canUndo} onClick={() => engine.undo()}>
                    <Undo2 size={15} />
                </IconButton>
                <IconButton label={t('ink.action.redo')} size="sm" disabled={!canRedo} onClick={() => engine.redo()}>
                    <Redo2 size={15} />
                </IconButton>
                <IconButton label={t('ink.action.save')} size="sm" onClick={onSave}>
                    {saveState === 'saved' ? <Check size={15} /> : <Save size={15} />}
                </IconButton>
            </div>
            <div className="ml-1 flex shrink-0 items-center gap-0.5">
                <span ref={insertButtonRef} className="inline-flex shrink-0">
                    <Tooltip label={t('ink.action.insert')}>
                        <IconButton label={t('ink.action.insert')} size="sm" onClick={onInsertMenu}>
                            <Plus size={16} />
                        </IconButton>
                    </Tooltip>
                </span>
                <Tooltip label={t('ink.action.insert_text')}>
                    <IconButton label={t('ink.action.insert_text')} size="sm" onClick={onInsertText}>
                        <Type size={16} />
                    </IconButton>
                </Tooltip>
                <Tooltip label={t('ink.action.delete_selection')}>
                    <IconButton label={t('ink.action.delete_selection')} size="sm" disabled={selectionCount === 0} onClick={() => engine.deleteSelection()}>
                        <Trash2 size={15} />
                    </IconButton>
                </Tooltip>
                <span ref={exportButtonRef} className="inline-flex shrink-0">
                    <Tooltip label={t('ink.action.export')}>
                        <IconButton label={t('ink.action.export')} size="sm" onClick={onExportMenu}>
                            <Download size={16} />
                        </IconButton>
                    </Tooltip>
                </span>
                <Tooltip label={t('ink.action.frame')} combo="F">
                    <IconButton label={t('ink.action.frame')} size="sm" onClick={onFrame}>
                        <Scan size={16} />
                    </IconButton>
                </Tooltip>
                <Tooltip label={focusMode ? t('ink.action.focus_exit') : t('ink.action.focus')}>
                    <IconButton label={focusMode ? t('ink.action.focus_exit') : t('ink.action.focus')} size="sm" active={focusMode} onClick={onFocus}>
                        <SidebarClose size={16} />
                    </IconButton>
                </Tooltip>
            </div>
        </div>
    )
}
