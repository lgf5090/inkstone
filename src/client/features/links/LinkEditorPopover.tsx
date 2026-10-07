import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Braces, Check, ClipboardType, Copy, ExternalLink, FilePlus2, Link2, Trash2, X } from 'lucide-react'
import { normalizeLinkKey } from '@shared/markdown-utils'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { usePinyinVersion } from '../../lib/pinyin'
import { getVisibleViewport } from '../../lib/viewport'
import { Z_INDEX } from '../../lib/z-index'
import { placePanel } from '../../components/popover-placement'
import { IconButton } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import { isSafeExternalUrl } from '../workspace/context-menu/line-edits'
import { peekNoteContent } from '../preview/card-content'
import { useNotes } from '../../store/notes'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { closeLinkEditor, findNoteIdByTitle, spanPayload, useLinkEditor, writeLinkSpan, type LinkEditorRequest } from './store'
import {
  canToggleEmbed,
  copyAsMarkdown,
  copyAsWiki,
  displayTextOf,
  headingsIn,
  isExternalTarget,
  linkKindLabel,
  padNewLink,
  serializeLink,
  splitTarget,
  unwrapTextOf,
  type LinkMatch,
} from './link-syntax'
import { subpathQuery, suggestTargets, type LinkSuggestionHeading, type LinkSuggestionRow } from './link-suggest'

const GAP = 6
const MARGIN = 8
const VALIDATION_DELAY = 260

type TargetState = 'idle' | 'ok' | 'missing-note' | 'missing-heading'

export function LinkEditorPopover() {
  const request = useLinkEditor((state) => state.request)
  if (!request) return null
  return <LinkEditorPanel key={`${request.noteId}:${request.from}:${request.to}`} request={request} />
}

function initialText(request: LinkEditorRequest): string {
  return request.match.image ? request.match.text : displayTextOf(request.match)
}

function fileNameOf(target: string): string {
  const cleaned = target.split(/[?#]/, 1)[0] ?? target
  const parts = cleaned.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] ?? cleaned
}

function LinkEditorPanel({ request }: { request: LinkEditorRequest }) {
  const settings = useSession((state) => state.settings.editor)
  const notes = useNotes((state) => state.notes)
  const content = useNotes((state) => state.contents[request.noteId])
  const pinyinVersion = usePinyinVersion()
  const toast = useUi((state) => state.toast)
  const panelRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLInputElement>(null)
  const targetRef = useRef<HTMLInputElement>(null)
  const spanRef = useRef({ from: request.from, to: request.to, raw: spanPayload(request) })
  const committedRef = useRef(false)
  const [text, setText] = useState(() => initialText(request))
  const [target, setTarget] = useState(() => request.match.target)
  const [embed, setEmbed] = useState(() => request.match.embed)
  const [size, setSize] = useState({ width: 330, height: 132 })
  const [frame, setFrame] = useState(0)
  const [active, setActive] = useState(-1)
  const [targetState, setTargetState] = useState<TargetState>('idle')
  const [remoteHeadings, setRemoteHeadings] = useState<LinkSuggestionHeading[] | null>(null)
  const commitRef = useRef<() => void>(() => {})

  const match: LinkMatch = useMemo(() => ({ ...request.match, embed }), [request.match, embed])
  const currentTitle = notes[request.noteId]?.title ?? ''
  const subpath = subpathQuery(target)
  const ownerNote = subpath?.note ?? ''
  const ownerIsCurrent = !ownerNote || ownerNote === currentTitle
  const localHeadings = useMemo(() => headingsIn(content ?? ''), [content])
  const headings = ownerIsCurrent ? localHeadings : remoteHeadings ?? []

  const candidates = useMemo(() => Object.values(notes)
    .filter((note) => !note.deletedAt && note.title)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 400)
    .map((note) => ({ id: note.id, title: note.title, updatedAt: note.updatedAt })), [notes])

  // The target field is typed into, so the name lookup behind the warning and the `#` branch has to be
  // a map built once per library change rather than a scan of every note per keystroke.
  const idForTitle = useMemo(() => {
    const index = new Map<string, string>()
    for (const note of Object.values(notes)) {
      if (note.deletedAt || !note.title) continue
      const key = normalizeLinkKey(note.title.replace(/\.md$/i, ''))
      if (key && !index.has(key)) index.set(key, note.id)
    }
    return (title: string): string | null => {
      const key = normalizeLinkKey(title.replace(/\.md$/i, ''))
      return key ? index.get(key) ?? null : null
    }
  }, [notes])

  const rows = useMemo<LinkSuggestionRow[]>(() => {
    if (!settings.linkEditorSuggest) return []
    return suggestTargets(target, {
      notes: candidates,
      headings,
      headingOwnerTitle: ownerIsCurrent ? '' : ownerNote,
      currentTitle,
    }, {
      syncAlias: settings.linkEditorSyncAlias,
      aliasMode: settings.linkEditorAliasMode,
      aliasSeparator: settings.linkEditorAliasSeparator,
    })
  }, [
    settings.linkEditorSuggest, settings.linkEditorSyncAlias, settings.linkEditorAliasMode,
    settings.linkEditorAliasSeparator,
    target, candidates, headings, ownerIsCurrent, ownerNote, currentTitle, pinyinVersion,
  ])

  const placement = useMemo(() => placePanel({
    anchor: request.anchor,
    size,
    viewport: getVisibleViewport(),
    align: 'start',
    gap: GAP,
    margin: MARGIN,
  }), [request.anchor, size, frame])

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const measure = () => {
      const rect = panel.getBoundingClientRect()
      setSize((current) => Math.abs(current.height - rect.height) < 1 && Math.abs(current.width - rect.width) < 1
        ? current
        : { width: rect.width, height: rect.height })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return () => {}
    const observer = new ResizeObserver(measure)
    observer.observe(panel)
    return () => { observer.disconnect() }
  }, [])

  useEffect(() => {
    let queued = 0
    const onMove = () => {
      if (queued) return
      queued = window.requestAnimationFrame(() => {
        queued = 0
        setFrame((value) => value + 1)
      })
    }
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      if (queued) window.cancelAnimationFrame(queued)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [])

  useEffect(() => {
    const wanted = request.focusTarget ?? 'text'
    const field = wanted === 'target' ? targetRef.current : textRef.current
    field?.focus()
    field?.select()
  }, [request.focusTarget])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (panelRef.current?.contains(event.target as Node)) return
      commitRef.current()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [])

  useEffect(() => {
    if (!ownerNote || ownerIsCurrent) {
      setRemoteHeadings(null)
      return
    }
    const id = idForTitle(ownerNote)
    if (!id) {
      setRemoteHeadings([])
      return
    }
    let cancelled = false
    void peekNoteContent(id)
      .then((body) => { if (!cancelled) setRemoteHeadings(body ? headingsIn(body) : []) })
      .catch(() => { if (!cancelled) setRemoteHeadings([]) })
    return () => { cancelled = true }
  }, [ownerNote, ownerIsCurrent, idForTitle])

  useEffect(() => {
    if (!settings.linkEditorValidate) {
      setTargetState('idle')
      return
    }
    const value = target.trim()
    if (!value || isExternalTarget(value)) {
      setTargetState('idle')
      return
    }
    const { note, heading, block } = splitTarget(value)
    if (block) {
      setTargetState('idle')
      return
    }
    const id = note ? idForTitle(note) : request.noteId
    if (note && !id) {
      setTargetState('missing-note')
      return
    }
    if (!heading) {
      setTargetState('ok')
      return
    }
    if (id === request.noteId) {
      setTargetState(localHeadings.some((row) => row.text === heading) ? 'ok' : 'missing-heading')
      return
    }
    setTargetState('idle')
    let settled = false
    const timer = window.setTimeout(() => {
      void peekNoteContent(id ?? '')
        .then((body) => {
          if (settled || !body) return
          setTargetState(headingsIn(body).some((row) => row.text === heading) ? 'ok' : 'missing-heading')
        })
        .catch(() => undefined)
    }, VALIDATION_DELAY)
    return () => {
      settled = true
      window.clearTimeout(timer)
    }
  }, [target, settings.linkEditorValidate, localHeadings, request.noteId, idForTitle])

  const replace = useCallback((next: string): boolean => {
    const span = spanRef.current
    const bare = span.raw === '' && request.from === request.to && settings.linkEditorPadNew
    let from = span.from
    let payload = next
    if (bare) {
      const source = request.view?.state.doc.toString() ?? useNotes.getState().contents[request.noteId] ?? ''
      const lineStart = source.lastIndexOf('\n', span.from - 1) + 1
      const lineEnd = source.indexOf('\n', span.from)
      const lineText = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd)
      const padded = padNewLink(next, lineText, span.from - lineStart)
      payload = padded.text
      from = span.from + (padded.cursor - next.length)
    }
    const result = writeLinkSpan(
      { ...request, replaces: undefined, creating: span.raw === '', from: span.from, to: span.to, match: { ...request.match, raw: span.raw } },
      payload,
    )
    if (result === 'written') spanRef.current = { from, to: from + next.length, raw: next }
    if (result === 'moved') toast({ title: t('links.moved'), tone: 'warning' })
    if (result === 'unloaded') toast({ title: t('links.not_loaded'), tone: 'warning' })
    return result === 'written'
  }, [request, settings.linkEditorPadNew, toast])

  const commitWith = useCallback((nextText: string, nextTarget: string) => {
    if (committedRef.current) return
    committedRef.current = true
    // A new link with nothing to point at is a cancelled command, not a request to delete the words
    // the reader had selected when they asked for one.
    if (request.creating && !nextTarget.trim()) {
      closeLinkEditor()
      return
    }
    const next = serializeLink(match, { text: nextText, target: nextTarget })
    if (next !== spanRef.current.raw) replace(next)
    closeLinkEditor()
  }, [match, replace, request.creating])

  const commit = useCallback(() => commitWith(text, target), [commitWith, target, text])

  commitRef.current = commit

  const discard = useCallback(() => {
    if (committedRef.current) return
    committedRef.current = true
    closeLinkEditor()
    request.view?.focus()
  }, [request.view])

  const remove = useCallback(() => {
    if (committedRef.current) return
    committedRef.current = true
    const keep = settings.linkEditorKeepsText && !match.image && match.kind !== 'url'
    replace(keep ? unwrapTextOf(match) : '')
    closeLinkEditor()
  }, [match, replace, settings.linkEditorKeepsText])

  const toggleEmbed = useCallback(() => {
    const next = !embed
    const written = serializeLink({ ...match, embed: next }, { text, target })
    if (written === spanRef.current.raw) {
      setEmbed(next)
      return
    }
    if (replace(written)) setEmbed(next)
  }, [embed, match, replace, target, text])

  const openTarget = useCallback(() => {
    const value = target.trim()
    if (!value) return
    if (isExternalTarget(value)) {
      if (!isSafeExternalUrl(value)) {
        toast({ title: t('links.unsafe_target'), tone: 'danger' })
        return
      }
      window.open(value, '_blank', 'noopener,noreferrer')
      closeLinkEditor()
      return
    }
    const { note } = splitTarget(value)
    if (!note) {
      toast({ title: t('links.need_note_name'), tone: 'warning' })
      return
    }
    const id = findNoteIdByTitle(note)
    if (id) void useNotes.getState().openNote(id)
    else void useNotes.getState().createNote({ title: note, open: true })
    closeLinkEditor()
  }, [target, toast])

  const copy = useCallback((value: string, label: string) => {
    if (!value) {
      toast({ title: t('links.nothing_to_copy'), tone: 'warning' })
      return
    }
    if (!navigator.clipboard?.writeText) {
      toast({ title: t('preview.could_not_copy'), tone: 'danger' })
      return
    }
    void navigator.clipboard.writeText(value)
      .then(() => toast({ title: label, tone: 'success' }))
      .catch(() => toast({ title: t('preview.could_not_copy'), tone: 'danger' }))
  }, [toast])

  const pick = useCallback((row: LinkSuggestionRow) => {
    const nextText = row.text || text
    setTarget(row.target)
    if (row.text) setText(row.text)
    setActive(-1)
    if (request.creating && settings.linkEditorQuickSelect) {
      commitWith(nextText, row.target)
      return
    }
    targetRef.current?.focus()
  }, [commitWith, request.creating, settings.linkEditorQuickSelect, text])

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      discard()
      return
    }
    if (rows.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((current) => {
        const next = current + step
        if (next < -1) return rows.length - 1
        if (next > rows.length - 1) return -1
        return next
      })
      return
    }
    if (event.key === 'Enter' && active >= 0 && rows[active]) {
      event.preventDefault()
      pick(rows[active]!)
      return
    }
    if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') {
      event.preventDefault()
      commit()
    }
  }, [active, commit, discard, pick, request.creating, rows])

  const missing = targetState === 'missing-note' || targetState === 'missing-heading'
  const draft = { text, target }
  const listId = `link-editor-suggestions-${request.from}`

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t('links.editor')}
      onKeyDown={onKeyDown}
      className={cn(
        'anim-pop fixed flex w-[330px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-[var(--r-lg)]',
        'border border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-pop)]',
      )}
      style={{ top: placement.top, left: placement.left, transformOrigin: placement.origin, zIndex: Z_INDEX.hoverPinned + 1 }}
    >
      <div className="flex items-center gap-1.5 border-b border-[var(--border-subtle)] px-2.5 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-[0.04em] text-[var(--text-tertiary)]">
          {t(linkKindLabel(match))}
        </span>
        <Tooltip label={t('links.discard')}>
          <IconButton label={t('links.discard')} size="xs" onClick={discard}>
            <X size={13} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('links.save')}>
          <IconButton label={t('links.save')} size="xs" onClick={commit}>
            <Check size={13} />
          </IconButton>
        </Tooltip>
      </div>

      <div className="flex flex-col gap-1.5 px-2.5 py-2">
        <input
          ref={textRef}
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onFocus={() => setActive(-1)}
          placeholder={match.image ? t('links.placeholder_size') : t('links.placeholder_text')}
          aria-label={match.image ? t('links.placeholder_size') : t('links.placeholder_text')}
          spellCheck={false}
          autoComplete="off"
          className="h-7 min-w-0 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 text-[12.5px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-quaternary)] focus:border-[var(--accent)]"
        />
        <div className="relative">
          <input
            ref={targetRef}
            type="text"
            value={target}
            onChange={(event) => {
              setTarget(event.target.value)
              setActive(-1)
            }}
            onFocus={() => setActive(-1)}
            placeholder={t('links.placeholder_target')}
            aria-label={t('links.placeholder_target')}
            aria-invalid={missing || undefined}
            aria-expanded={rows.length > 0}
            aria-controls={listId}
            aria-activedescendant={active >= 0 && rows[active] ? `${listId}-${active}` : undefined}
            spellCheck={false}
            autoComplete="off"
            className={cn(
              'h-7 w-full rounded-[var(--r-sm)] border bg-[var(--bg-base)] px-2 pr-7 text-[12.5px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-quaternary)]',
              missing ? 'border-[var(--danger)]' : 'border-[var(--border-subtle)] focus:border-[var(--accent)]',
            )}
          />
          {missing && (
            <AlertTriangle size={13} aria-hidden="true" className="absolute top-1/2 right-2 -translate-y-1/2 text-[var(--danger)]" />
          )}
        </div>
        {targetState === 'missing-note' && (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={openTarget}
            className="flex items-center gap-1.5 self-start rounded-[var(--r-sm)] px-1 py-0.5 text-left text-[11.5px] text-[var(--accent)] transition-colors hover:bg-[var(--bg-hover)]"
          >
            <FilePlus2 size={12} aria-hidden="true" />
            <span>{t('links.create_note')}</span>
          </button>
        )}

        {rows.length > 0 && (
          <ul
            id={listId}
            role="listbox"
            aria-label={t('links.suggestions')}
            className="max-h-52 min-h-0 overflow-y-auto overscroll-contain rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] py-0.5"
          >
            {rows.map((row, index) => (
              <li key={row.key} id={`${listId}-${index}`} role="option" aria-selected={index === active}>
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onPointerEnter={() => setActive(index)}
                  onClick={() => pick(row)}
                  className={cn(
                    'flex w-full min-w-0 items-baseline gap-1.5 px-2 py-1 text-left text-[12.5px] transition-colors',
                    index === active ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]',
                  )}
                >
                  {row.kind === 'heading' && (
                    <span className="shrink-0 font-mono text-[10px] text-[var(--text-quaternary)]">{'#'.repeat(row.level)}</span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{row.label}</span>
                  {row.detail && <span className="max-w-[38%] shrink-0 truncate text-[11px] text-[var(--text-quaternary)]">{row.detail}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-0.5 border-t border-[var(--border-subtle)] px-2 py-1.5">
        <Tooltip label={t('links.action_open')}>
          <IconButton label={t('links.action_open')} size="xs" disabled={!target.trim()} onClick={openTarget}>
            <ExternalLink size={13} />
          </IconButton>
        </Tooltip>
        {settings.linkEditorEmbedToggle && canToggleEmbed(match) && (
          <Tooltip label={t('links.action_embed')}>
            <IconButton label={t('links.action_embed')} size="xs" active={embed} onClick={toggleEmbed}>
              <Braces size={13} />
            </IconButton>
          </Tooltip>
        )}
        <span className="flex-1" />
        <Tooltip label={t('links.action_copy_wiki')}>
          <IconButton label={t('links.action_copy_wiki')} size="xs" onClick={() => copy(copyAsWiki(match, draft), t('links.copied_wiki'))}>
            <Link2 size={13} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('links.action_copy_markdown')}>
          <IconButton label={t('links.action_copy_markdown')} size="xs" onClick={() => copy(copyAsMarkdown(match, draft), t('links.copied_markdown'))}>
            <Copy size={13} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t(match.image ? 'links.action_copy_filename' : 'links.action_copy_target')}>
          <IconButton
            label={t(match.image ? 'links.action_copy_filename' : 'links.action_copy_target')}
            size="xs"
            onClick={() => copy(match.image ? fileNameOf(target) : target.trim(), t('links.copied_target'))}
          >
            <ClipboardType size={13} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('links.action_delete')}>
          <IconButton label={t('links.action_delete')} size="xs" disabled={Boolean(request.creating)} onClick={remove}>
            <Trash2 size={13} />
          </IconButton>
        </Tooltip>
      </div>

      <p className="px-2.5 pb-2 text-[10.5px] leading-snug text-[var(--text-quaternary)]">
        {missing ? t('links.warning_missing') : t('links.hint_enter')}
      </p>
    </div>,
    document.body,
  )
}
