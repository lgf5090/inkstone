import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  MinusCircle,
  Pencil,
  RefreshCw,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react'
import {
  initialFor,
  isHttpUrl,
  type NavCheckError,
  type NavCheckLevel,
  type NavCheckResult,
  type NavLink,
} from '@shared/nav/model'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { relativeTime } from '../../lib/time'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { Checkbox, Segmented, Select } from '../../components/form'
import { Modal, confirm, prompt } from '../../components/overlay'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { categoryOptions, isNavCheckLevel, navApi } from './api'
import { NavIcon } from './nav-icons'
import { useNavStore } from './nav-store'

/** The reference implementation scans eight links per request and keeps three requests in flight. */
const CHECK_BATCH = 8
const CHECK_CONCURRENCY = 3
const CHECK_RENDER_PAGE = 200
const LIVE_STATE_LIMIT = 400
const PUBLISH_INTERVAL_MS = 250
const CACHE_INTERVAL_MS = 2000
const SCAN_DEADLINE_MS = 10 * 60_000
const CACHE_LIMIT = 20_000
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const MODAL_WIDTH = 960

type CheckPhase = 'idle' | 'scanning' | 'done' | 'cancelled'
type CheckFilter = 'all' | 'broken' | 'warning' | 'ok'

interface CheckRow {
  status: number | null
  ok: boolean
  level: NavCheckLevel
  durationMs: number
  errorCode?: NavCheckError
  finalUrl?: string
  checkedAt: number
}

const CHECK_ERRORS: ReadonlySet<string> = new Set<NavCheckError>([
  'timeout',
  'network',
  'blocked_target',
  'invalid_url',
  'too_many_redirects',
  'http_error',
])

function cacheKey(): string | null {
  const userId = useSession.getState().user?.id
  return userId ? `inkstone.nav.linkCheck.${userId}` : null
}

function parseRow(value: unknown): CheckRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.checkedAt !== 'number' || !Number.isFinite(raw.checkedAt)) return null
  if (typeof raw.durationMs !== 'number' || !Number.isFinite(raw.durationMs)) return null
  if (typeof raw.ok !== 'boolean') return null
  if (typeof raw.level !== 'string' || !isNavCheckLevel(raw.level)) return null
  if (raw.status !== null && typeof raw.status !== 'number') return null
  const row: CheckRow = {
    status: raw.status as number | null,
    ok: raw.ok,
    level: raw.level,
    durationMs: raw.durationMs,
    checkedAt: raw.checkedAt,
  }
  if (typeof raw.errorCode === 'string' && CHECK_ERRORS.has(raw.errorCode)) {
    row.errorCode = raw.errorCode as NavCheckError
  }
  if (typeof raw.finalUrl === 'string') row.finalUrl = raw.finalUrl
  return row
}

function readCache(now = Date.now()): { rows: Record<string, CheckRow>; lastCheckedAt: number | null } {
  const empty = { rows: {} as Record<string, CheckRow>, lastCheckedAt: null }
  if (typeof window === 'undefined') return empty
  const key = cacheKey()
  if (!key) return empty
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return empty
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
    const rows: Record<string, CheckRow> = {}
    for (const [linkId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const row = parseRow(value)
      if (!row || now - row.checkedAt >= CACHE_TTL_MS) continue
      rows[linkId] = row
    }
    const kept = Object.entries(rows)
      .sort((left, right) => right[1].checkedAt - left[1].checkedAt)
      .slice(0, CACHE_LIMIT)
    const lastCheckedAt = kept.reduce((latest, [, row]) => Math.max(latest, row.checkedAt), 0)
    return { rows: Object.fromEntries(kept), lastCheckedAt: lastCheckedAt || null }
  } catch {
    // A corrupt cache only costs a rescan; opening the checker must never fail because of it.
    return empty
  }
}

function writeCache(rows: Record<string, CheckRow>, now = Date.now()): void {
  if (typeof window === 'undefined') return
  const key = cacheKey()
  if (!key) return
  const kept = Object.entries(rows)
    .filter(([, row]) => now - row.checkedAt < CACHE_TTL_MS)
    .sort((left, right) => right[1].checkedAt - left[1].checkedAt)
    .slice(0, CACHE_LIMIT)
  try {
    window.localStorage.setItem(key, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // The scan itself still worked; a full or unavailable storage only loses the cache.
  }
}

function toRow(result: NavCheckResult, checkedAt: number): CheckRow {
  const row: CheckRow = {
    status: result.status,
    ok: result.ok,
    level: result.level,
    durationMs: result.durationMs,
    checkedAt,
  }
  if (result.errorCode) row.errorCode = result.errorCode
  if (result.finalUrl) row.finalUrl = result.finalUrl
  return row
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t('nav.error.generic')
}

function levelLabel(level: NavCheckLevel): string {
  if (level === 'ok') return t('nav.checker.ok')
  if (level === 'warning') return t('nav.checker.warning')
  if (level === 'broken') return t('nav.checker.broken')
  return t('nav.checker.skipped')
}

function errorLabel(code: NavCheckError): string {
  if (code === 'timeout') return t('nav.checker.error.timeout')
  if (code === 'network') return t('nav.checker.error.network')
  if (code === 'blocked_target') return t('nav.checker.error.blocked_target')
  if (code === 'invalid_url') return t('nav.checker.error.invalid_url')
  if (code === 'too_many_redirects') return t('nav.checker.error.too_many_redirects')
  return t('nav.checker.error.http_error')
}

const LEVEL_TONE: Record<NavCheckLevel, string> = {
  ok: 'text-[var(--success)]',
  warning: 'text-[var(--warning)]',
  broken: 'text-[var(--danger)]',
  skipped: 'text-[var(--text-tertiary)]',
}

function LevelIcon({ level }: { level: NavCheckLevel }) {
  if (level === 'ok') return <CheckCircle2 size={12} aria-hidden="true" />
  if (level === 'warning') return <AlertTriangle size={12} aria-hidden="true" />
  if (level === 'broken') return <XCircle size={12} aria-hidden="true" />
  return <MinusCircle size={12} aria-hidden="true" />
}

function LinkGlyph({ link }: { link: NavLink }) {
  const icon = link.icon?.trim()
  if (icon && (isHttpUrl(icon) || icon.startsWith('/api/nav/icons/'))) {
    return (
      <img
        src={icon}
        alt=""
        width={16}
        height={16}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className="size-4 shrink-0 rounded-[var(--r-xs)] object-contain"
      />
    )
  }
  if (icon) return <NavIcon name={icon} size={14} className="shrink-0 text-[var(--text-tertiary)]" />
  return (
    <span
      aria-hidden="true"
      className="flex size-4 shrink-0 items-center justify-center rounded-[var(--r-xs)] bg-[var(--bg-raised)] text-[length:var(--text-10)] font-semibold text-[var(--text-tertiary)]"
    >
      {initialFor(link.title, link.url)}
    </span>
  )
}

function StatusCell({ row, checking }: { row?: CheckRow; checking: boolean }) {
  if (checking) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
        <Spinner size={11} />
        {t('nav.checker.checking')}
      </span>
    )
  }
  if (!row) {
    return (
      <span className="text-[length:var(--text-12)] text-[var(--text-quaternary)]" aria-hidden="true">
        —
      </span>
    )
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className={cn('inline-flex items-center gap-1 text-[length:var(--text-11-5)] font-medium', LEVEL_TONE[row.level])}>
        <LevelIcon level={row.level} />
        {levelLabel(row.level)}
      </span>
      {row.status !== null && (
        <span className="text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">{row.status}</span>
      )}
      <span className="text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">
        {Math.round(row.durationMs)} {t('nav.checker.ms')}
      </span>
    </span>
  )
}

/**
 * The link checker: every bookmark scanned in small batches, filtered and selectively acted on.
 *
 * The panel only holds what the reader is looking at — results live in a per-user cache keyed by link
 * id, so a refresh within a day brings the last verdicts back without touching the network.
 */
export function LinkCheckerModal({ open, onClose, onEditLink }: {
  open: boolean
  onClose: () => void
  onEditLink: (link: NavLink) => void
}) {
  const links = useNavStore((state) => state.links)
  const categories = useNavStore((state) => state.categories)
  const batch = useNavStore((state) => state.batch)
  const deleteLink = useNavStore((state) => state.deleteLink)
  const toast = useUi((state) => state.toast)

  const [phase, setPhase] = useState<CheckPhase>('idle')
  const [filter, setFilter] = useState<CheckFilter>('all')
  const [results, setResults] = useState<Record<string, CheckRow>>({})
  const [checking, setChecking] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [progress, setProgress] = useState({ checked: 0, total: 0 })
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null)
  const [renderPage, setRenderPage] = useState({ key: 'all', limit: CHECK_RENDER_PAGE })
  const [busy, setBusy] = useState(false)
  const [moveTarget, setMoveTarget] = useState('')

  const abortRef = useRef<AbortController | null>(null)
  const resultsRef = useRef<Record<string, CheckRow>>({})
  const checkingRef = useRef<Set<string>>(new Set())
  const checkedRef = useRef(0)
  const totalRef = useRef(0)
  const scanLargeRef = useRef(false)
  const deadlineHitRef = useRef(false)
  const publishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cacheTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const deadlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    abortRef.current?.abort()
    abortRef.current = null
    if (publishTimerRef.current !== null) {
      clearTimeout(publishTimerRef.current)
      publishTimerRef.current = null
    }
    if (cacheTimerRef.current !== null) {
      clearTimeout(cacheTimerRef.current)
      cacheTimerRef.current = null
    }
    if (deadlineTimerRef.current !== null) {
      clearTimeout(deadlineTimerRef.current)
      deadlineTimerRef.current = null
    }
    scanLargeRef.current = false
    checkedRef.current = 0
    totalRef.current = 0
    checkingRef.current = new Set()
    deadlineHitRef.current = false
    const cached = readCache()
    resultsRef.current = cached.rows
    setResults(cached.rows)
    setLastCheckedAt(cached.lastCheckedAt)
    setPhase('idle')
    setFilter('all')
    setChecking(new Set())
    setSelected(new Set())
    setProgress({ checked: 0, total: 0 })
    setBusy(false)
    setMoveTarget('')
    setRenderPage({ key: 'all', limit: CHECK_RENDER_PAGE })
  }, [open])

  useEffect(() => () => {
    abortRef.current?.abort()
    if (publishTimerRef.current !== null) clearTimeout(publishTimerRef.current)
    if (cacheTimerRef.current !== null) clearTimeout(cacheTimerRef.current)
    if (deadlineTimerRef.current !== null) clearTimeout(deadlineTimerRef.current)
  }, [])

  const categoryNames = useMemo(() => {
    const names = new Map<string, string>()
    for (const category of categories) names.set(category.id, category.name)
    return names
  }, [categories])

  const counts = useMemo(() => {
    const next = { ok: 0, warning: 0, broken: 0, skipped: 0 }
    for (const link of links) {
      const row = results[link.id]
      if (!row) continue
      next[row.level] += 1
    }
    return next
  }, [links, results])

  const brokenLinks = useMemo(
    () => links.filter((link) => results[link.id]?.level === 'broken' && isHttpUrl(link.url)),
    [links, results],
  )

  const visibleLinks = useMemo(
    () => links.filter((link) => filter === 'all' || results[link.id]?.level === filter),
    [links, results, filter],
  )
  const renderLimit = renderPage.key === filter ? renderPage.limit : CHECK_RENDER_PAGE
  const renderedLinks = visibleLinks.slice(0, renderLimit)
  const hasMoreRows = renderedLinks.length < visibleLinks.length
  useEffect(() => {
    setRenderPage((current) => current.key === filter ? current : { key: filter, limit: CHECK_RENDER_PAGE })
  }, [filter])

  const hasResults = lastCheckedAt !== null || Object.keys(results).length > 0
  const percent = progress.total > 0 ? Math.round((progress.checked / progress.total) * 100) : 0
  const moveOptions = useMemo(() => categoryOptions(categories), [categories])

  function writeCacheSoon(): void {
    if (cacheTimerRef.current !== null) return
    cacheTimerRef.current = setTimeout(() => {
      cacheTimerRef.current = null
      writeCache(resultsRef.current)
    }, CACHE_INTERVAL_MS)
  }

  function publishNow(): void {
    if (publishTimerRef.current !== null) {
      clearTimeout(publishTimerRef.current)
      publishTimerRef.current = null
    }
    setResults(resultsRef.current)
    setChecking(new Set(checkingRef.current))
    setProgress({ checked: checkedRef.current, total: totalRef.current })
  }

  function schedulePublish(): void {
    if (publishTimerRef.current !== null) return
    publishTimerRef.current = setTimeout(() => {
      publishTimerRef.current = null
      publishNow()
      writeCacheSoon()
    }, PUBLISH_INTERVAL_MS)
  }

  function flushScanState(): void {
    if (publishTimerRef.current !== null) {
      clearTimeout(publishTimerRef.current)
      publishTimerRef.current = null
    }
    if (cacheTimerRef.current !== null) {
      clearTimeout(cacheTimerRef.current)
      cacheTimerRef.current = null
    }
    setResults(resultsRef.current)
    setChecking(new Set())
    setProgress({ checked: checkedRef.current, total: totalRef.current })
    writeCache(resultsRef.current)
  }

  function applyResults(rows: Record<string, CheckRow>, immediate = !scanLargeRef.current): void {
    if (!Object.keys(rows).length) return
    resultsRef.current = { ...resultsRef.current, ...rows }
    if (immediate) {
      setResults(resultsRef.current)
      writeCache(resultsRef.current)
      return
    }
    schedulePublish()
  }

  function clearResults(ids: readonly string[]): void {
    if (!ids.length) return
    const next = { ...resultsRef.current }
    for (const id of ids) delete next[id]
    resultsRef.current = next
    setResults(next)
    writeCache(next)
  }

  async function startScan(targets: NavLink[]): Promise<void> {
    const queue = targets.filter((link) => isHttpUrl(link.url))
    if (!queue.length) {
      toast({ title: t('nav.checker.none') })
      return
    }
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const startedAt = Date.now()
    if (deadlineTimerRef.current !== null) clearTimeout(deadlineTimerRef.current)
    deadlineTimerRef.current = setTimeout(() => {
      deadlineTimerRef.current = null
      deadlineHitRef.current = true
      controller.abort()
    }, SCAN_DEADLINE_MS)
    scanLargeRef.current = queue.length > LIVE_STATE_LIMIT
    checkedRef.current = 0
    totalRef.current = queue.length
    checkingRef.current = new Set(queue.map((link) => link.id))
    deadlineHitRef.current = false
    setPhase('scanning')
    setProgress({ checked: 0, total: queue.length })
    setChecking(new Set(checkingRef.current))
    setSelected(new Set())

    const chunks: NavLink[][] = []
    for (let index = 0; index < queue.length; index += CHECK_BATCH) {
      chunks.push(queue.slice(index, index + CHECK_BATCH))
    }
    let nextChunk = 0

    const worker = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        if (Date.now() - startedAt > SCAN_DEADLINE_MS) {
          deadlineHitRef.current = true
          controller.abort()
          return
        }
        const chunk = chunks[nextChunk]
        nextChunk += 1
        if (!chunk) return
        try {
          const urls = [...new Set(chunk.map((link) => link.url))]
          const { results: batchRows } = await navApi.check(urls, controller.signal)
          if (controller.signal.aborted) return
          const byUrl = new Map(batchRows.map((row) => [row.url, row]))
          const now = Date.now()
          const rows: Record<string, CheckRow> = {}
          for (const link of chunk) {
            const result = byUrl.get(link.url)
            if (result) rows[link.id] = toRow(result, now)
          }
          applyResults(rows)
          checkedRef.current += chunk.length
          for (const link of chunk) checkingRef.current.delete(link.id)
          if (scanLargeRef.current) {
            schedulePublish()
          } else {
            setProgress({ checked: checkedRef.current, total: totalRef.current })
            setChecking(new Set(checkingRef.current))
          }
        } catch (error) {
          if (controller.signal.aborted) return
          throw error
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, chunks.length) }, worker))
    } catch (error) {
      if (deadlineTimerRef.current !== null) { clearTimeout(deadlineTimerRef.current); deadlineTimerRef.current = null }
      controller.abort()
      flushScanState()
      setPhase('cancelled')
      toast({ title: errorMessage(error), tone: 'danger' })
      return
    }
    if (controller.signal.aborted) {
      if (deadlineTimerRef.current !== null) { clearTimeout(deadlineTimerRef.current); deadlineTimerRef.current = null }
      flushScanState()
      if (deadlineHitRef.current) {
        setPhase('cancelled')
        toast({ title: t('nav.checker.deadline'), tone: 'danger' })
      }
      return
    }
    if (deadlineTimerRef.current !== null) { clearTimeout(deadlineTimerRef.current); deadlineTimerRef.current = null }
    abortRef.current = null
    flushScanState()
    setPhase('done')
    setLastCheckedAt(Date.now())
  }

  function stopScan(): void {
    if (deadlineTimerRef.current !== null) { clearTimeout(deadlineTimerRef.current); deadlineTimerRef.current = null }
    abortRef.current?.abort()
    abortRef.current = null
    flushScanState()
    setPhase('cancelled')
  }

  async function requestClose(): Promise<void> {
    if (phase === 'scanning') {
      const confirmed = await confirm({
        title: t('nav.checker.close_confirm'),
        tone: 'danger',
        confirmLabel: t('nav.close'),
        cancelLabel: t('nav.cancel'),
      })
      if (!confirmed) return
      if (deadlineTimerRef.current !== null) {
        clearTimeout(deadlineTimerRef.current)
        deadlineTimerRef.current = null
      }
      abortRef.current?.abort()
      abortRef.current = null
      flushScanState()
    }
    onClose()
  }

  async function recheck(link: NavLink): Promise<void> {
    if (checking.has(link.id)) return
    setChecking((current) => new Set(current).add(link.id))
    try {
      const { results: rows } = await navApi.check([link.url])
      const row = rows[0]
      if (row) {
        applyResults({ [link.id]: toRow(row, Date.now()) }, true)
        setLastCheckedAt(Date.now())
      }
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' })
    } finally {
      setChecking((current) => {
        const next = new Set(current)
        next.delete(link.id)
        return next
      })
    }
  }

  async function removeLink(link: NavLink): Promise<void> {
    const confirmed = await confirm({
      title: t('nav.link.delete_confirm'),
      description: link.title,
      tone: 'danger',
      confirmLabel: t('nav.delete'),
      cancelLabel: t('nav.cancel'),
    })
    if (!confirmed) return
    try {
      await deleteLink(link.id)
      clearResults([link.id])
      setSelected((current) => {
        const next = new Set(current)
        next.delete(link.id)
        return next
      })
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' })
    }
  }

  function toggleSelected(id: string, next: boolean): void {
    setSelected((current) => {
      const value = new Set(current)
      if (next) value.add(id)
      else value.delete(id)
      return value
    })
  }

  function selectVisible(): void {
    setSelected(new Set(renderedLinks.map((link) => link.id)))
  }

  function selectAllFiltered(): void {
    setSelected(new Set(visibleLinks.map((link) => link.id)))
  }

  function selectBroken(): void {
    setSelected(new Set(brokenLinks.map((link) => link.id)))
  }

  async function bulkDelete(): Promise<void> {
    const ids = [...selected]
    if (!ids.length || busy) return
    const confirmed = await confirm({
      title: t('nav.checker.batch_delete'),
      description: t('nav.checker.selected', { count: ids.length }),
      tone: 'danger',
      confirmLabel: t('nav.delete'),
      cancelLabel: t('nav.cancel'),
    })
    if (!confirmed) return
    setBusy(true)
    try {
      await batch({ action: 'delete', ids })
      clearResults(ids)
      setSelected(new Set())
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function bulkRewrite(): Promise<void> {
    const ids = [...selected]
    if (!ids.length || busy) return
    const template = await prompt({
      title: t('nav.checker.batch_rewrite'),
      description: t('nav.checker.rewrite_hint'),
      placeholder: 'https://example.com{path}',
    })
    if (!template) return
    setBusy(true)
    try {
      await batch({ action: 'rewrite', ids, template })
      clearResults(ids)
      setSelected(new Set())
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function bulkMove(): Promise<void> {
    const ids = [...selected]
    if (!ids.length || !moveTarget || busy) return
    setBusy(true)
    try {
      await batch({ action: 'move', ids, fallbackCategoryId: moveTarget })
      setSelected(new Set())
      setMoveTarget('')
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  function rowActions(link: NavLink) {
    const scanning = phase === 'scanning'
    return (
      <div className="flex shrink-0 items-center justify-end gap-0.5">
        <IconButton
          label={`${t('nav.retry')} ${link.title}`}
          size="sm"
          disabled={scanning || checking.has(link.id)}
          onClick={() => void recheck(link)}
        >
          <RefreshCw size={12} />
        </IconButton>
        <IconButton label={`${t('nav.edit')} ${link.title}`} size="sm" onClick={() => onEditLink(link)}>
          <Pencil size={12} />
        </IconButton>
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${t('nav.open')} ${link.title}`}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--r-md)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <ExternalLink size={12} />
        </a>
        <IconButton
          label={`${t('nav.delete')} ${link.title}`}
          size="sm"
          className="text-[var(--danger)]"
          onClick={() => void removeLink(link)}
        >
          <Trash2 size={12} />
        </IconButton>
      </div>
    )
  }

  function rowDetails(link: NavLink) {
    const row = results[link.id]
    return (
      <>
        {row?.errorCode && (
          <p className="text-[length:var(--text-10-5)] text-[var(--danger)]">{errorLabel(row.errorCode)}</p>
        )}
        {row?.finalUrl && row.finalUrl !== link.url && (
          <p className="break-all text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{row.finalUrl}</p>
        )}
      </>
    )
  }

  if (!open) return null

  return (
    <Modal
      open={open}
      onClose={() => void requestClose()}
      title={t('nav.checker.title')}
      width={MODAL_WIDTH}
      bodyClassName="flex flex-col gap-3"
      footer={
        <>
          <Button variant="ghost" onClick={() => void requestClose()}>
            {t('nav.close')}
          </Button>
          {phase === 'scanning' ? (
            <Button variant="secondary" icon={<Square size={12} />} onClick={stopScan}>
              {t('nav.checker.stop')}
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<RefreshCw size={13} />}
              disabled={busy}
              onClick={() => void startScan(links)}
            >
              {hasResults ? t('nav.checker.restart') : t('nav.checker.start')}
            </Button>
          )}
        </>
      }
    >
      {links.length === 0 ? (
        <p className="py-8 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">
          {t('nav.checker.none')}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {phase !== 'scanning' && brokenLinks.length > 0 && (
              <Button
                size="sm"
                variant="secondary"
                icon={<RefreshCw size={12} />}
                disabled={busy}
                onClick={() => void startScan(brokenLinks)}
              >
                {t('nav.checker.recheck_broken')}
              </Button>
            )}
            <p className="min-w-0 flex-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">
              {t('nav.checker.help')}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Segmented<CheckFilter>
              size="sm"
              label={t('nav.checker.title')}
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: `${t('nav.checker.all')} (${links.length})` },
                { value: 'broken', label: `${t('nav.checker.broken')} (${counts.broken})` },
                { value: 'warning', label: `${t('nav.checker.warning')} (${counts.warning})` },
                { value: 'ok', label: `${t('nav.checker.ok')} (${counts.ok})` },
              ]}
            />
            {lastCheckedAt !== null && (
              <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                {t('nav.checker.last', { time: relativeTime(lastCheckedAt) })}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('nav.checker.total', { count: links.length })}
            </span>
            <span className="text-[length:var(--text-11)] text-[var(--success)]">
              {t('nav.checker.ok')} {counts.ok}
            </span>
            <span className="text-[length:var(--text-11)] text-[var(--warning)]">
              {t('nav.checker.warning')} {counts.warning}
            </span>
            <span className="text-[length:var(--text-11)] text-[var(--danger)]">
              {t('nav.checker.broken')} {counts.broken}
            </span>
            <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('nav.checker.skipped')} {counts.skipped}
            </span>
            {checking.size > 0 && (
              <span className="text-[length:var(--text-11)] text-[var(--accent)]">
                {t('nav.checker.checking')} {checking.size}
              </span>
            )}
          </div>

          {(phase === 'scanning' || phase === 'cancelled') && progress.total > 0 && (
            <div>
              <div
                role="progressbar"
                aria-label={t('nav.checker.progress')}
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.checked}
                className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-inset)]"
              >
                <div
                  className="h-full bg-[var(--accent)] transition-[width] duration-[var(--dur-base)]"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p
                role={phase === 'cancelled' ? 'status' : undefined}
                className="mt-1 text-[length:var(--text-10-5)] tabular text-[var(--text-tertiary)]"
              >
                {t('nav.checker.checked', { checked: progress.checked, total: progress.total })} · {percent}%
                {phase === 'cancelled' && ` · ${t('nav.checker.cancelled', { checked: progress.checked, total: progress.total })}`}
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2">
            <Button size="sm" variant="ghost" onClick={selectVisible}>
              {t('nav.checker.select_current')}
            </Button>
            {hasMoreRows && (
              <Button size="sm" variant="ghost" onClick={selectAllFiltered}>
                {t('nav.checker.select_all_results', { count: visibleLinks.length })}
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={brokenLinks.length === 0} onClick={selectBroken}>
              {t('nav.checker.select_broken')}
            </Button>
            <Button size="sm" variant="ghost" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>
              {t('nav.checker.clear_selection')}
            </Button>
            {selected.size > 0 && (
              <>
                <span className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">
                  {t('nav.checker.selected', { count: selected.size })}
                </span>
                <div className="ml-auto flex flex-wrap items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<Trash2 size={12} />}
                    disabled={busy}
                    onClick={() => void bulkDelete()}
                  >
                    {t('nav.checker.batch_delete')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Pencil size={12} />}
                    disabled={busy}
                    onClick={() => void bulkRewrite()}
                  >
                    {t('nav.checker.batch_rewrite')}
                  </Button>
                  <Select
                    aria-label={t('nav.checker.move_target')}
                    value={moveTarget}
                    onChange={(event) => setMoveTarget(event.target.value)}
                    className="w-40"
                  >
                    <option value="">{t('nav.checker.move_target')}</option>
                    {moveOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </Select>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!moveTarget || busy}
                    onClick={() => void bulkMove()}
                  >
                    {t('nav.checker.batch_move')}
                  </Button>
                </div>
              </>
            )}
          </div>

          {visibleLinks.length === 0 ? (
            <p className="py-8 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">
              {t('nav.empty_search.title')}
            </p>
          ) : (
            <>
              {hasMoreRows && (
                <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                  {t('nav.checker.showing', { shown: renderedLinks.length, total: visibleLinks.length })}
                </p>
              )}
              <div className="hidden md:block">
                <table className="w-full table-fixed border-collapse text-left">
                  <caption className="sr-only">{t('nav.checker.title')}</caption>
                  <thead>
                    <tr className="border-b border-[var(--border-subtle)] text-[length:var(--text-10-5)] uppercase tracking-wide text-[var(--text-quaternary)]">
                      <th scope="col" className="w-8 pb-2">
                        <span className="sr-only">{t('nav.checker.select_current')}</span>
                      </th>
                      <th scope="col" className="pb-2">{t('nav.link.title')}</th>
                      <th scope="col" className="w-[190px] pb-2">{t('nav.checker.title')}</th>
                      <th scope="col" className="w-[132px] pb-2 text-right">
                        <span className="sr-only">{t('nav.more')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {renderedLinks.map((link) => (
                      <tr key={link.id} className="border-b border-[var(--border-subtle)] last:border-b-0">
                        <td className="py-2 pr-1 align-top">
                          <Checkbox
                            checked={selected.has(link.id)}
                            onChange={(next) => toggleSelected(link.id, next)}
                            ariaLabel={`${t('nav.checker.select_current')} ${link.title}`}
                          />
                        </td>
                        <td className="min-w-0 py-2 pr-3 align-top">
                          <div className="flex min-w-0 items-start gap-1.5">
                            <span className="mt-0.5"><LinkGlyph link={link} /></span>
                            <div className="min-w-0 flex-1">
                              <span className="block truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
                                {link.title}
                              </span>
                              <a
                                href={link.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="block break-all text-[length:var(--text-10-5)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                              >
                                {link.url}
                              </a>
                              <span className="block truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                                {categoryNames.get(link.categoryId) ?? t('nav.uncategorized')}
                              </span>
                              {rowDetails(link)}
                            </div>
                          </div>
                        </td>
                        <td className="py-2 pr-2 align-top">
                          <StatusCell row={results[link.id]} checking={checking.has(link.id)} />
                        </td>
                        <td className="py-2 align-top">{rowActions(link)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul className="flex flex-col gap-2 md:hidden">
                {renderedLinks.map((link) => (
                  <li
                    key={link.id}
                    className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2.5"
                  >
                    <div className="flex items-start gap-2">
                      <Checkbox
                        checked={selected.has(link.id)}
                        onChange={(next) => toggleSelected(link.id, next)}
                        ariaLabel={`${t('nav.checker.select_current')} ${link.title}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-start gap-1.5">
                          <span className="mt-0.5"><LinkGlyph link={link} /></span>
                          <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
                            {link.title}
                          </span>
                        </div>
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-0.5 block break-all text-[length:var(--text-10-5)] text-[var(--text-tertiary)]"
                        >
                          {link.url}
                        </a>
                        <div className="mt-1">
                          <StatusCell row={results[link.id]} checking={checking.has(link.id)} />
                        </div>
                        {rowDetails(link)}
                        <div className="mt-1.5 flex justify-end">{rowActions(link)}</div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              {hasMoreRows && (
                <div className="mt-2 flex justify-center">
                  <Button size="sm" variant="secondary" onClick={() => setRenderPage({ key: filter, limit: renderLimit + CHECK_RENDER_PAGE })}>
                    {t('nav.load_more', { shown: renderedLinks.length, total: visibleLinks.length })}
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  )
}
