import { useEffect, useRef, useState } from 'react'
import { Bookmark, BookmarkPlus, Palette, PanelTopClose, Scan, Trash2 } from 'lucide-react'
import { IconButton } from '../../components/primitives'
import { Swatch } from '../../components/color-swatch'
import { ColorWellField } from '../../components/color-field'
import { Slider } from '../../components/form'
import { prompt, Tooltip, useClickOutside, useEscape } from '../../components/overlay'
import { t } from '../../lib/i18n'
import type { InkBookmark } from '../../lib/inkpad/types'
import type { InkEngine } from './ink-engine-types'
import type { InkSaveState } from './ink-toolbar'

const PALETTE = ['#ffffff', '#111827', '#ef4444', '#2563eb', '#16a34a', '#f59e0b']

export function InkHud({
    engine,
    zoom,
    saveState,
    color,
    width,
    autoColor,
    focusMode,
    onColor,
    onWidth,
    onAutoColor,
    onResetZoom,
    onFrame,
    onFocus,
}: {
    engine: InkEngine
    zoom: number
    saveState: InkSaveState
    color: string
    width: number
    autoColor: boolean
    focusMode: boolean
    onColor: (color: string) => void
    onWidth: (width: number) => void
    onAutoColor: () => void
    onResetZoom: () => void
    onFrame: () => void
    onFocus: () => void
}) {
    const [inkOpen, setInkOpen] = useState(false)
    const [bookmarksOpen, setBookmarksOpen] = useState(false)
    const [bookmarks, setBookmarks] = useState<InkBookmark[]>(() => [...engine.bookmarks()])
    const inkRef = useRef<HTMLDivElement>(null)
    const bookmarksRef = useRef<HTMLDivElement>(null)
    const inkTrigger = useRef<HTMLSpanElement>(null)
    const bookmarkTrigger = useRef<HTMLSpanElement>(null)
    useClickOutside([inkRef, inkTrigger], inkOpen, () => setInkOpen(false))
    useClickOutside([bookmarksRef, bookmarkTrigger], bookmarksOpen, () => setBookmarksOpen(false))
    useEscape(inkOpen, () => setInkOpen(false))
    useEscape(bookmarksOpen, () => setBookmarksOpen(false))
    useEffect(() => {
        setBookmarks([...engine.bookmarks()])
    }, [engine, saveState])
    const refreshBookmarks = () => setBookmarks([...engine.bookmarks()])
    const saveLabel = saveState === 'saving' ? t('ink.save.saving')
        : saveState === 'pending' ? t('ink.save.pending')
            : saveState === 'error' ? t('ink.save.error')
                : t('ink.save.saved')
    const addBookmark = async () => {
        const value = await prompt({
            title: t('ink.bookmark.name'),
            defaultValue: t('ink.bookmark.view', { number: bookmarks.length + 1 }),
        })
        if (!value?.trim()) return
        engine.addBookmark(value)
        refreshBookmarks()
    }
    return (
        <div className="pointer-events-none absolute inset-0 z-[4]">
            <div className="pointer-events-auto absolute right-[max(12px,env(safe-area-inset-right))] bottom-[max(12px,env(safe-area-inset-bottom))] flex items-center gap-1 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 shadow-[var(--shadow-sm)]">
                <span role="status" aria-live="polite" className="px-1 text-[length:var(--text-11)] tabular-nums text-[var(--text-tertiary)]">{saveLabel}</span>
                <Tooltip label={t('ink.hud.zoom_reset')}>
                    <button type="button" aria-label={t('ink.hud.zoom_reset')} onClick={onResetZoom} className="inline-flex h-7 min-w-9 items-center justify-center rounded-[var(--r-sm)] px-1.5 text-[length:var(--text-11)] tabular-nums text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                        {Math.round(zoom * 100)}%
                    </button>
                </Tooltip>
                <span ref={bookmarkTrigger} className="inline-flex">
                    <IconButton label={t('ink.hud.bookmarks')} size="sm" active={bookmarksOpen} onClick={() => setBookmarksOpen((open) => !open)}>
                        <Bookmark size={15} />
                    </IconButton>
                </span>
                <Tooltip label={t('ink.hud.frame')} combo="F">
                    <IconButton label={t('ink.hud.frame')} size="sm" onClick={onFrame}>
                        <Scan size={15} />
                    </IconButton>
                </Tooltip>
            </div>
            <div className="pointer-events-auto absolute bottom-[max(12px,env(safe-area-inset-bottom))] left-[max(12px,env(safe-area-inset-left))] flex flex-col-reverse gap-1.5">
                <Tooltip label={focusMode ? t('ink.action.focus_exit') : t('ink.action.focus')} side="right">
                    <IconButton label={focusMode ? t('ink.action.focus_exit') : t('ink.action.focus')} active={focusMode} onClick={onFocus}>
                        <PanelTopClose size={16} />
                    </IconButton>
                </Tooltip>
                <span ref={inkTrigger} className="inline-flex">
                    <Tooltip label={t('ink.action.open_ink_menu')} side="right">
                        <IconButton label={t('ink.action.open_ink_menu')} active={inkOpen} onClick={() => setInkOpen((open) => !open)}>
                            <Palette size={16} />
                        </IconButton>
                    </Tooltip>
                </span>
            </div>
            {inkOpen && (
                <div ref={inkRef} role="dialog" aria-label={t('ink.action.open_ink_menu')} className="pointer-events-auto absolute bottom-[max(64px,calc(env(safe-area-inset-bottom)+52px))] left-[max(12px,env(safe-area-inset-left))] grid w-[214px] gap-2.5 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2.5 shadow-[var(--shadow-modal)]">
                    <div className="flex flex-wrap items-center justify-center gap-2">
                        <button type="button" aria-label={t('ink.hud.auto_color')} aria-pressed={autoColor} onClick={() => { onAutoColor(); }} className="size-7 rounded-full border border-[var(--border-default)]" style={{ background: color }} />
                        {PALETTE.map((value) => (
                            <Swatch key={value} color={value} label={t('ink.hud.color', { value })} active={!autoColor && color.toLowerCase() === value.toLowerCase()} onPick={() => onColor(value)} />
                        ))}
                        <ColorWellField value={color} label={t('ink.hud.custom_color')} onChange={onColor} />
                    </div>
                    <div className="flex items-center gap-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                        <span className="w-10 shrink-0">{t('ink.hud.stroke_width')}</span>
                        <Slider value={width} min={1} max={16} onChange={onWidth} label={t('ink.hud.stroke_width')} className="min-w-0 flex-1" suffix="px" immediate />
                        <span className="w-8 text-right tabular-nums">{t('ink.hud.width_value', { value: width })}</span>
                    </div>
                </div>
            )}
            {bookmarksOpen && (
                <div ref={bookmarksRef} role="menu" aria-label={t('ink.hud.bookmarks')} className="pointer-events-auto absolute right-[max(12px,env(safe-area-inset-right))] bottom-[max(60px,calc(env(safe-area-inset-bottom)+48px))] grid min-w-[220px] gap-1 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1.5 shadow-[var(--shadow-modal)]">
                    <button type="button" onClick={() => void addBookmark()} className="flex min-h-9 items-center gap-2 rounded-[var(--r-sm)] px-2 text-left text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
                        <BookmarkPlus size={15} />
                        {t('ink.bookmark.add')}
                    </button>
                    {bookmarks.map((bookmark) => (
                        <div key={bookmark.id} className="flex items-center gap-1">
                            <button type="button" onClick={() => { engine.goToBookmark(bookmark.id); setBookmarksOpen(false) }} className="min-h-9 min-w-0 flex-1 truncate rounded-[var(--r-sm)] px-2 text-left text-[length:var(--text-12)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                                {bookmark.name}
                            </button>
                            <IconButton label={t('ink.bookmark.delete', { name: bookmark.name })} size="sm" onClick={() => { engine.deleteBookmark(bookmark.id); refreshBookmarks() }}>
                                <Trash2 size={14} />
                            </IconButton>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

