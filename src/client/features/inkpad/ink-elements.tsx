import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
    BringToFront,
    FileText,
    ImageOff,
    Lock,
    Pencil,
    SendToBack,
    Trash2,
    UnfoldVertical,
    Unlock,
} from 'lucide-react'
import { IconButton } from '../../components/primitives'
import { prompt } from '../../components/overlay'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import { t, useLocale } from '../../lib/i18n'
import { isInkNoteTitle } from '../../lib/inkpad/document'
import { isMindmapDocumentTitle } from '../../lib/markdown/mindmap/document'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { findNoteByTitle, useNotes } from '../../store/notes'
import type { InkElement } from '../../lib/inkpad/types'
import type { InkEngine } from './ink-engine-types'
import { renderPdfPages } from './ink-pdf'

const NOTE_PREVIEW_LIMIT = 200_000

interface InkElementsProps {
    engine: InkEngine
    version: number
    onOpenNote: (id: string) => void
}

export function InkElements({ engine, version, onOpenNote }: InkElementsProps) {
    useLocale()
    const elements = useMemo(() => [...engine.elements()], [engine, version])
    useLayoutEffect(() => {
        engine.layoutElements()
    }, [engine, version])
    return (
        <>
            <div data-ink-card-body-layer className="inkpad-card-layer z-[1]">
                {elements.map((element) => (
                    <CardBody key={element.id} engine={engine} element={element} />
                ))}
            </div>
            <div data-ink-card-control-layer className="inkpad-card-layer z-[3]">
                {elements.map((element) => (
                    <CardControls key={element.id} engine={engine} element={element} onOpenNote={onOpenNote} />
                ))}
            </div>
        </>
    )
}

function basename(path: string): string {
    return path.split('/').pop() ?? path
}

function basenameWithoutMarkdown(path: string): string {
    return basename(path).replace(/\.md$/i, '')
}

function isTypedTitle(title: string): boolean {
    return isInkNoteTitle(title) || title.endsWith('.excalidraw') || isMindmapDocumentTitle(title)
}

function isFileUrl(url: string | undefined): url is string {
    return typeof url === 'string' && url.startsWith('/api/files/')
}

function groupLabel(element: InkElement): string {
    if (element.kind === 'markdown') return t('ink.element.group_note', { name: element.path })
    if (element.kind === 'pdf') return t('ink.element.group_pdf', { name: element.path })
    if (element.kind === 'image') return t('ink.element.group_image', { name: element.path })
    if (element.kind === 'audio') return t('ink.element.group_audio', { name: element.path })
    return t('ink.element.group_text')
}

function CardBody({ engine, element }: { engine: InkEngine; element: InkElement }) {
    useAttachmentReference(engine, element)
    if (element.kind === 'markdown') return <NoteCardBody engine={engine} element={element} />
    if (element.kind === 'pdf') return <PdfCardBody engine={engine} element={element} />
    if (element.kind === 'image') return <ImageCardBody engine={engine} element={element} />
    if (element.kind === 'audio') return <div data-element-body-id={element.id} className="inkpad-card-body inkpad-card-audio-body" />
    return (
        <div data-element-body-id={element.id} className="inkpad-card-body">
            <div className="inkpad-card-text">{element.text ?? ''}</div>
        </div>
    )
}

function useAttachmentReference(engine: InkEngine, element: InkElement): void {
    useEffect(() => {
        if (element.kind === 'markdown' || element.kind === 'text' || element.fileId || !element.path) return
        let cancelled = false
        void api.files.byName(basename(element.path)).then(({ files }) => {
            const file = files[0]
            if (!file || cancelled) return
            engine.patchElement(element.id, { fileId: file.id, url: `/api/files/${file.id}`, mime: file.mime })
        }).catch(() => {
            // An old .ink path may name no attachment any more; the card stays in its missing state.
        })
        return () => { cancelled = true }
    }, [engine, element.id, element.kind, element.fileId, element.path])
}

function CardControls({ engine, element, onOpenNote }: { engine: InkEngine; element: InkElement; onOpenNote: (id: string) => void }) {
    const [audioFailed, setAudioFailed] = useState(false)
    const label = groupLabel(element)
    const move = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || element.locked) return
        if ((event.target as HTMLElement).closest('button')) return
        engine.startElementGesture(element.id, 'move', event.nativeEvent, event.currentTarget)
    }
    const moveKeys = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) return
        const step = event.shiftKey ? 1 : 10
        const delta = event.key === 'ArrowLeft' ? [-step, 0]
            : event.key === 'ArrowRight' ? [step, 0]
                : event.key === 'ArrowUp' ? [0, -step]
                    : event.key === 'ArrowDown' ? [0, step] : null
        if (!delta) return
        event.preventDefault()
        engine.moveElementBy(element.id, delta[0]!, delta[1]!)
    }
    const resizeKeys = (event: KeyboardEvent<HTMLButtonElement>) => {
        const step = event.shiftKey ? 1 : 10
        const delta = event.key === 'ArrowLeft' ? [-step, 0]
            : event.key === 'ArrowRight' ? [step, 0]
                : event.key === 'ArrowUp' ? [0, -step]
                    : event.key === 'ArrowDown' ? [0, step] : null
        if (!delta) return
        event.preventDefault()
        engine.resizeElementBy(element.id, delta[0]!, delta[1]!)
    }
    const canFitPages = element.kind === 'pdf'
    return (
        <div data-element-control-id={element.id} className="inkpad-card-controls" role="group" aria-label={label}>
            <div
                className="inkpad-card-header"
                tabIndex={0}
                role="group"
                aria-label={t('ink.element.move')}
                onPointerDown={move}
                onKeyDown={moveKeys}
            >
                {element.kind === 'markdown' && element.noteId && (
                    <IconButton label={t('ink.element.open_note')} size="sm" className="inkpad-card-action" onClick={() => element.noteId && onOpenNote(element.noteId)}>
                        <FileText size={14} />
                    </IconButton>
                )}
                {element.kind === 'text' && (
                    <IconButton
                        label={t('ink.element.edit_text')}
                        size="sm"
                        className="inkpad-card-action"
                        onClick={() => void editText(engine, element)}
                    >
                        <Pencil size={14} />
                    </IconButton>
                )}
                {canFitPages && (
                    <IconButton
                        label={t('ink.element.fit_pages')}
                        size="sm"
                        active={element.fitPdfPages === true}
                        className="inkpad-card-action"
                        onClick={() => togglePageHeight(engine, element)}
                    >
                        <UnfoldVertical size={14} />
                    </IconButton>
                )}
                {element.kind !== 'text' && (
                    <>
                        <IconButton label={t('ink.element.front')} size="sm" className="inkpad-card-action" onClick={() => engine.bringElementToFront(element.id)}>
                            <BringToFront size={14} />
                        </IconButton>
                        <IconButton label={t('ink.element.back')} size="sm" className="inkpad-card-action" onClick={() => engine.sendElementToBack(element.id)}>
                            <SendToBack size={14} />
                        </IconButton>
                    </>
                )}
                <IconButton
                    label={element.locked ? t('ink.element.unlock') : t('ink.element.lock')}
                    size="sm"
                    active={element.locked}
                    className="inkpad-card-action"
                    onClick={() => engine.toggleElementLock(element.id)}
                >
                    {element.locked ? <Lock size={14} /> : <Unlock size={14} />}
                </IconButton>
                <IconButton label={t('ink.element.remove')} size="sm" className="inkpad-card-action" onClick={() => engine.removeElement(element.id)}>
                    <Trash2 size={14} />
                </IconButton>
            </div>
            {element.kind === 'audio' && !isFileUrl(element.url) && (
                <div className="inkpad-card-status">{t('ink.element.audio_failed')}</div>
            )}
            {element.kind === 'audio' && isFileUrl(element.url) && (
                <>
                    <audio
                        className="inkpad-card-audio"
                        controls
                        preload="metadata"
                        src={element.url}
                        aria-label={element.path}
                        onError={() => setAudioFailed(true)}
                    />
                    {audioFailed && <div className="inkpad-card-status">{t('ink.element.audio_failed')}</div>}
                </>
            )}
            {!element.locked && element.kind !== 'audio' && (
                <button
                    type="button"
                    className="inkpad-card-resize"
                    aria-label={t('ink.element.resize')}
                    onPointerDown={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        engine.startElementGesture(element.id, 'resize', event.nativeEvent, event.currentTarget)
                    }}
                    onKeyDown={resizeKeys}
                />
            )}
        </div>
    )
}

async function editText(engine: InkEngine, element: InkElement): Promise<void> {
    const value = await prompt({ title: t('ink.element.edit_text'), defaultValue: element.text ?? '' })
    if (value === null) return
    engine.patchElement(element.id, { text: value }, { history: true })
}

function togglePageHeight(engine: InkEngine, element: InkElement): void {
    const fit = !element.fitPdfPages
    const height = fit
        ? Math.max(160, (element.pageCount ?? 1) * element.width * (element.pageAspect ?? 1.414) + 30)
        : element.height
    engine.patchElement(element.id, { fitPdfPages: fit, height }, { history: true })
}

function NoteCardBody({ engine, element }: { engine: InkEngine; element: InkElement }) {
    const note = useNotes((state) => element.noteId ? state.notes[element.noteId] : undefined)
    const stored = useNotes((state) => element.noteId ? state.contents[element.noteId] : undefined)
    const [fetched, setFetched] = useState<string | null>(null)
    const [failed, setFailed] = useState(false)
    const contentRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!element.path) return
        const notes = useNotes.getState().notes
        if (element.noteId && notes[element.noteId]) return
        const byTitle = findNoteByTitle(basenameWithoutMarkdown(element.path))
        if (byTitle) engine.patchElement(element.id, { noteId: byTitle.id })
    }, [element.id, element.noteId, element.path, engine])

    useEffect(() => {
        if (!element.noteId || stored !== undefined) return
        let cancelled = false
        setFailed(false)
        setFetched(null)
        void api.notes.get(element.noteId).then((full) => {
            if (!cancelled) setFetched(full.content)
        }).catch(() => {
            if (!cancelled) setFailed(true)
        })
        return () => { cancelled = true }
    }, [element.noteId, stored])

    const title = note?.title ?? element.path
    const body = stored ?? fetched
    const typed = isTypedTitle(title)
    const truncated = typeof body === 'string' && body.length > NOTE_PREVIEW_LIMIT
    const html = useMemo(() => {
        if (typed || !body) return ''
        return renderMarkdown(body.slice(0, NOTE_PREVIEW_LIMIT), { hideFrontMatter: true }).html
    }, [body, typed])

    useEffect(() => {
        const node = contentRef.current
        if (!node) return
        // renderMarkdown has already sanitized this HTML.
        node.innerHTML = html
        node.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => {
            input.disabled = true
            input.removeAttribute('data-task-line')
            input.setAttribute('aria-label', t('markdown.tasks_in_embedded_notes_are_read_only'))
        })
    }, [html])

    const status = note?.deletedAt ? t('ink.element.note_missing')
        : typed ? t('ink.element.typed_note')
            : failed ? t('ink.element.note_failed')
                : body === undefined ? t('ink.element.note_loading')
                    : null
    return (
        <div data-element-body-id={element.id} className="inkpad-card-body">
            {status ? <div className={failed || note?.deletedAt ? 'inkpad-card-missing' : 'inkpad-card-status'}>{status}</div> : (
                <>
                    <div ref={contentRef} className="inkpad-card-note" />
                    {truncated && <div className="inkpad-card-too-long">{t('ink.element.note_too_long')}</div>}
                </>
            )}
        </div>
    )
}

function PdfCardBody({ engine, element }: { engine: InkEngine; element: InkElement }) {
    const containerRef = useRef<HTMLDivElement>(null)
    const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
    const generation = useRef(0)

    useEffect(() => {
        const container = containerRef.current
        if (!container) return
        const current = ++generation.current
        let cancelled = false
        container.replaceChildren()
        setState('loading')
        if (!isFileUrl(element.url)) {
            setState('error')
            return
        }
        void renderPdfPages({
            url: element.url,
            width: element.width,
            allPages: element.fitPdfPages === true,
            container,
            isCurrent: () => !cancelled && generation.current === current,
            pageLabel: (page) => t('ink.element.page', { number: page }),
        }).then((info) => {
            if (cancelled || generation.current !== current) return
            setState('ready')
            const changed = element.pageCount !== info.pageCount || element.pageAspect !== info.pageAspect
            if (changed) engine.patchElement(element.id, { pageCount: info.pageCount, pageAspect: info.pageAspect })
            if (element.fitPdfPages) {
                const height = Math.max(160, info.pageCount * element.width * info.pageAspect + 30)
                if (Math.abs(height - element.height) > 1) engine.patchElement(element.id, { height })
            }
        }).catch(() => {
            if (!cancelled && generation.current === current) setState('error')
        })
        return () => { cancelled = true }
    }, [element.id, element.url, element.width, element.fitPdfPages, engine])

    return (
        <div data-element-body-id={element.id} className="inkpad-card-body is-pdf">
            <div ref={containerRef} className={cn('min-h-0 flex-1 overflow-hidden', state !== 'ready' && 'hidden')} />
            {state === 'loading' && <div className="inkpad-card-status">{t('ink.element.pdf_loading')}</div>}
            {state === 'error' && <div className="inkpad-card-missing">{t('ink.element.pdf_failed')}</div>}
        </div>
    )
}

function ImageCardBody({ engine, element }: { engine: InkEngine; element: InkElement }) {
    const [failed, setFailed] = useState(false)
    useEffect(() => setFailed(false), [element.url])
    if (!isFileUrl(element.url) || failed) {
        return (
            <div data-element-body-id={element.id} className="inkpad-card-body is-image">
                <div className="inkpad-card-missing">
                    <ImageOff size={16} className="mr-1 inline" />
                    {failed ? t('ink.element.image_failed') : t('ink.element.missing', { name: element.path })}
                </div>
            </div>
        )
    }
    return (
        <div data-element-body-id={element.id} className="inkpad-card-body is-image">
            <img
                className="inkpad-card-media"
                src={element.url}
                alt={element.path}
                loading="lazy"
                decoding="async"
                onLoad={(event) => {
                    const image = event.currentTarget
                    const aspect = image.naturalWidth / image.naturalHeight
                    if (!Number.isFinite(aspect) || aspect <= 0) return
                    if (Math.abs((element.aspectRatio ?? 0) - aspect) < 0.0001) return
                    engine.patchElement(element.id, { aspectRatio: aspect, height: element.width / aspect })
                }}
                onError={() => setFailed(true)}
            />
        </div>
    )
}
