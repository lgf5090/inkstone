/**
 * The text comparison screen.
 *
 * Two sources go in — typed, dropped or pasted — and the answer comes out twice: as the aligned
 * editors the merge view draws, and as the counts and patch the reader can copy. Above the size
 * threshold the editors are replaced by the windowed row list, because the merge view renders the
 * whole document and a hundred thousand lines of it would stop the tab.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Copy, Download, FileDown, Keyboard, Save, Shuffle, SlidersHorizontal } from 'lucide-react'
import type { TextEncoding } from '@shared/tools/compare/encoding'
import { formatUnifiedPatch } from '@shared/tools/compare/engine'
import { TEXT_LIMITS, type TextViewMode } from '@shared/tools/compare/types'
import { Button, IconButton } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { Tabs } from '../../../../components/tabs'
import { Tooltip } from '../../../../components/overlay'
import { Empty } from '../../../../components/feedback'
import { t } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { compareApi } from '../api'
import { useCompareStore } from '../store'
import { OptionsPanel } from './OptionsPanel'
import { TextSideCard } from './TextSideCard'
import { StatsBar } from '../components/StatsBar'
import { SaveDialog } from '../components/SaveDialog'
import { MergeHost, type MergeHostHandle } from '../lib/MergeHost'
import { VirtualDiffView } from '../lib/VirtualDiffView'
import { decodeFile, fileLooksBinary, UnreadableTextError } from '../lib/files'
import { downloadBlob, safeFilename } from '../lib/download'
import { useTextDiff } from '../lib/use-text-diff'
import { useDebouncedValue } from '../lib/use-debounced'
import { LANGUAGE_CHOICES } from '../lib/languages'

const LARGE_COMPARISON = 1_500_000
const SIDE_ERRORS = ['unknown-encoding', 'binary', 'too-large', 'decode-failed'] as const
type SideError = (typeof SIDE_ERRORS)[number] | null

export function TextCompareView({ onShowShortcuts }: { onShowShortcuts: () => void }) {
  const left = useCompareStore((s) => s.left)
  const right = useCompareStore((s) => s.right)
  const options = useCompareStore((s) => s.options)
  const mode = useCompareStore((s) => s.mode)
  const collapseUnchanged = useCompareStore((s) => s.collapseUnchanged)
  const language = useCompareStore((s) => s.language)
  const setSide = useCompareStore((s) => s.setSide)
  const swapSides = useCompareStore((s) => s.swapSides)
  const resetSides = useCompareStore((s) => s.resetSides)
  const setOptions = useCompareStore((s) => s.setOptions)
  const resetOptions = useCompareStore((s) => s.resetOptions)
  const setMode = useCompareStore((s) => s.setMode)
  const setCollapseUnchanged = useCompareStore((s) => s.setCollapseUnchanged)
  const setLanguage = useCompareStore((s) => s.setLanguage)

  const [showOptions, setShowOptions] = useState(false)
  const [showInputs, setShowInputs] = useState(true)
  const [hunkIndex, setHunkIndex] = useState(0)
  const [scrolledHunk, setScrolledHunk] = useState(-1)
  const [saving, setSaving] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [busySide, setBusySide] = useState<'left' | 'right' | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [errors, setErrors] = useState<{ left: SideError, right: SideError }>({ left: null, right: null })
  const pendingFile = useRef<{ side: 'left' | 'right', file: File } | null>(null)
  const hostRef = useRef<MergeHostHandle>(null)
  const recorded = useRef('')

  const settledLeft = useDebouncedValue(left.text, 350)
  const settledRight = useDebouncedValue(right.text, 350)
  const diffState = useTextDiff(settledLeft, settledRight, options)
  const diff = diffState.diff
  const bothPresent = left.text.length > 0 && right.text.length > 0
  const large = settledLeft.length + settledRight.length > LARGE_COMPARISON || (diff?.rows.length ?? 0) > 40_000

  useEffect(() => {
    setHunkIndex(0)
    setScrolledHunk(-1)
  }, [diff])

  // One run per distinct comparison, and only once it has settled: while a second large file is still
  // decoding, the two sides briefly hold mismatched documents, and counting that transient would
  // report a comparison the reader never saw (and a difference far larger than the real one).
  useEffect(() => {
    if (!diff || !bothPresent || diffState.pending) return
    const key = [
      settledLeft.length,
      settledRight.length,
      diff.stats.added,
      diff.stats.removed,
      diff.stats.changed,
      options.ignoreWhitespace ? 1 : 0,
      options.ignoreCase ? 1 : 0,
      options.ignoreLineEndings ? 1 : 0,
      options.ignoreRegex,
    ].join(':')
    if (recorded.current === key) return
    const handle = window.setTimeout(() => {
      if (recorded.current === key) return
      recorded.current = key
      void compareApi.recordRun({
        kind: 'text',
        mode,
        left_name: left.name || null,
        right_name: right.name || null,
        left_ext: extensionOf(left.name),
        right_ext: extensionOf(right.name),
        added_lines: diff.stats.added,
        removed_lines: diff.stats.removed,
        changed_blocks: diff.stats.changedBlocks,
        identical: diff.hunks.length === 0,
        left_bytes: left.bytes,
        right_bytes: right.bytes,
      }).catch(() => {
        // The ledger is a convenience; a failed write must never block a comparison the reader can see.
      })
    }, 900)
    return () => window.clearTimeout(handle)
  }, [diff, bothPresent, diffState.pending, settledLeft.length, settledRight.length, options, mode, left.name, right.name, left.bytes, right.bytes])

  const decode = useCallback(async (side: 'left' | 'right', file: File, encoding?: TextEncoding) => {
    setBusySide(side)
    setProgress(null)
    setErrors((current) => ({ ...current, [side]: null }))
    try {
      if (file.size > TEXT_LIMITS.maxBytes) throw new UnreadableTextError('too-large')
      if (!encoding && await fileLooksBinary(file)) throw new UnreadableTextError('binary')
      const decoded = await decodeFile(file, encoding ?? null, (loaded, total) => {
        setProgress(`${Math.round((loaded / Math.max(1, total)) * 100)}%`)
      })
      setSide(side, { text: decoded.text, name: file.name, bytes: decoded.bytes, encoding: decoded.encoding })
      pendingFile.current = null
    } catch (error) {
      const reason = error instanceof UnreadableTextError ? error.message : 'decode-failed'
      setErrors((current) => ({
        ...current,
        [side]: (SIDE_ERRORS as readonly string[]).includes(reason) ? reason as SideError : 'decode-failed',
      }))
      if (reason === 'unknown-encoding') pendingFile.current = { side, file }
    } finally {
      setBusySide(null)
      setProgress(null)
    }
  }, [setSide])

  const pickEncoding = useCallback((side: 'left' | 'right', encoding: TextEncoding) => {
    const pending = pendingFile.current
    if (pending && pending.side === side) void decode(side, pending.file, encoding)
  }, [decode])

  const patch = useMemo(() => {
    if (!diff) return ''
    return formatUnifiedPatch(diff, left.name || 'left', right.name || 'right')
  }, [diff, left.name, right.name])

  const jump = useCallback((direction: 1 | -1) => {
    const total = diff?.hunks.length ?? 0
    if (!total) return
    const next = (hunkIndex + direction + total) % total
    setHunkIndex(next)
    setScrolledHunk(next)
    hostRef.current?.jumpToHunk(next, direction)
  }, [diff, hunkIndex])

  const largeFocusRow = useMemo(() => {
    if (!diff || scrolledHunk < 0) return null
    const hunk = diff.hunks[scrolledHunk]
    if (!hunk) return null
    return diff.rows.findIndex((row) => row.leftNo === hunk.leftStart || row.rightNo === hunk.rightStart)
  }, [diff, scrolledHunk])

  const copyPatch = async () => {
    try {
      await navigator.clipboard.writeText(patch)
      useUi.getState().toast({ title: t('tools.compare.export.copied'), tone: 'success' })
    } catch {
      useUi.getState().toast({ title: t('tools.compare.export.copy_failed'), tone: 'danger' })
    }
  }

  const exportReport = () => {
    if (!diff) return
    const lines = [
      `# ${t('tools.compare.report.title')}`,
      '',
      `- ${t('tools.compare.text.left')}: ${left.name || '—'}`,
      `- ${t('tools.compare.text.right')}: ${right.name || '—'}`,
      `- ${t('tools.compare.stats.added')}: ${diff.stats.added}`,
      `- ${t('tools.compare.stats.removed')}: ${diff.stats.removed}`,
      `- ${t('tools.compare.stats.changed')}: ${diff.stats.changed}`,
      `- ${t('tools.compare.stats.blocks')}: ${diff.stats.changedBlocks}`,
      `- ${t('tools.compare.stats.unchanged')}: ${diff.stats.same}`,
      '',
      '```diff',
      patch || t('tools.compare.text.identical'),
      '```',
    ]
    downloadBlob(safeFilename(left.name || right.name, 'comparison', '.md'), lines.join('\n'), 'text/markdown;charset=utf-8')
  }

  const save = async (name: string) => {
    if (!diff) return
    setSaving(true)
    try {
      const leftFile = new File([left.text], left.name || 'left.txt', { type: 'text/plain' })
      const rightFile = new File([right.text], right.name || 'right.txt', { type: 'text/plain' })
      const [leftAsset, rightAsset] = await Promise.all([
        compareApi.uploadAsset('text', leftFile, left.encoding),
        compareApi.uploadAsset('text', rightFile, right.encoding),
      ])
      await compareApi.createProject({
        name,
        kind: 'text',
        left_label: left.name || null,
        right_label: right.name || null,
        options,
        summary: {
          added: diff.stats.added,
          removed: diff.stats.removed,
          changed: diff.stats.changed,
          changedBlocks: diff.stats.changedBlocks,
          same: diff.stats.same,
          leftLines: diff.leftLines.length,
          rightLines: diff.rightLines.length,
        },
        left_asset_id: leftAsset.id,
        right_asset_id: rightAsset.id,
      })
      useUi.getState().toast({ title: t('tools.compare.save.saved'), tone: 'success' })
      setSaveOpen(false)
    } catch {
      useUi.getState().toast({ title: t('tools.compare.save.failed'), tone: 'danger' })
    } finally {
      setSaving(false)
    }
  }

  const tabs = [
    { id: 'side_by_side' as TextViewMode, label: t('tools.compare.view.side_by_side') },
    { id: 'inline' as TextViewMode, label: t('tools.compare.view.inline') },
  ]

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col gap-3 overflow-y-auto p-3 sm:p-4"
      onKeyDown={(event) => {
        if (event.key === 'F7') {
          event.preventDefault()
          jump(-1)
        } else if (event.key === 'F8') {
          event.preventDefault()
          jump(1)
        } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'D' || event.key === 'd')) {
          event.preventDefault()
          hostRef.current?.selectAllDiffs()
        } else if (event.altKey && (event.key === 'n' || event.key === 'N')) {
          event.preventDefault()
          setCollapseUnchanged(!collapseUnchanged)
        }
      }}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">{t('tools.compare.text.title')}</h2>
          <p className="mt-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('tools.compare.text.desc')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={swapSides} disabled={!left.text && !right.text}>
            <span className="flex items-center gap-1"><Shuffle size={13} aria-hidden="true" />{t('tools.compare.text.swap')}</span>
          </Button>
          <Tooltip label={t('tools.compare.shortcuts.title')}>
            <IconButton size="sm" label={t('tools.compare.shortcuts.title')} onClick={onShowShortcuts}>
              <Keyboard size={14} />
            </IconButton>
          </Tooltip>
          <Button size="sm" variant="ghost" onClick={() => setShowOptions((open) => !open)} aria-expanded={showOptions}>
            <span className="flex items-center gap-1"><SlidersHorizontal size={13} aria-hidden="true" />{t('tools.compare.option.title')}</span>
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setSaveOpen(true)} disabled={!diff || !bothPresent}>
            <span className="flex items-center gap-1"><Save size={13} aria-hidden="true" />{t('tools.compare.save.open')}</span>
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Tabs label={t('tools.compare.view.label')} value={mode} onChange={setMode} items={tabs} />
          <span className="h-4 w-px bg-[var(--border-subtle)]" aria-hidden="true" />
          <SelectMenu
            label={t('tools.compare.language.label')}
            value={language}
            options={LANGUAGE_CHOICES.map((choice) => ({ value: choice.id, label: t(choice.labelKey as never) }))}
            onChange={(value) => setLanguage(value)}
            size="sm"
            width={190}
          />
          {mode === 'side_by_side' && (
            <Button size="sm" variant="ghost" onClick={() => setCollapseUnchanged(!collapseUnchanged)} aria-pressed={collapseUnchanged}>
              {collapseUnchanged ? t('tools.compare.option.fold_on') : t('tools.compare.option.fold_off')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setShowInputs((open) => !open)} aria-expanded={showInputs}>
            <span className="flex items-center gap-1">
              {showInputs ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
              {t('tools.compare.text.inputs')}
            </span>
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => jump(-1)} disabled={!diff?.hunks.length} aria-label={t('tools.compare.nav.prev')}>
            <span className="flex items-center gap-1"><ChevronUp size={13} aria-hidden="true" />{'F7'}</span>
          </Button>
          <span data-testid="compare-hunk-position" className="min-w-[56px] text-center font-mono text-[length:var(--text-11)] text-[var(--text-secondary)]">
            {diff?.hunks.length ? `${hunkIndex + 1} / ${diff.hunks.length}` : '0 / 0'}
          </span>
          <Button size="sm" variant="ghost" onClick={() => jump(1)} disabled={!diff?.hunks.length} aria-label={t('tools.compare.nav.next')}>
            <span className="flex items-center gap-1"><ChevronDown size={13} aria-hidden="true" />{'F8'}</span>
          </Button>
        </div>
      </div>

      {showOptions && <OptionsPanel options={options} onChange={setOptions} onReset={resetOptions} />}

      {showInputs && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <TextSideCard
            side={left}
            label={t('tools.compare.text.left')}
            placeholder={t('tools.compare.text.placeholder')}
            onChange={(text) => setSide('left', { ...left, text })}
            onFile={(file) => void decode('left', file)}
            onClear={() => setSide('left', { text: '', name: '', bytes: 0, encoding: null })}
            busy={busySide === 'left'}
            error={errors.left}
            onPickEncoding={(encoding) => pickEncoding('left', encoding)}
            progress={busySide === 'left' ? progress : null}
          />
          <TextSideCard
            side={right}
            label={t('tools.compare.text.right')}
            placeholder={t('tools.compare.text.placeholder')}
            onChange={(text) => setSide('right', { ...right, text })}
            onFile={(file) => void decode('right', file)}
            onClear={() => setSide('right', { text: '', name: '', bytes: 0, encoding: null })}
            busy={busySide === 'right'}
            error={errors.right}
            onPickEncoding={(encoding) => pickEncoding('right', encoding)}
            progress={busySide === 'right' ? progress : null}
          />
        </div>
      )}

      {!bothPresent ? (
        <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
          <Empty
            art="select"
            compact
            title={t('tools.compare.text.need_both')}
            description={t('tools.compare.text.need_both_desc')}
            action={<Button size="sm" variant="secondary" onClick={resetSides}>{t('tools.compare.text.reset')}</Button>}
          />
        </div>
      ) : diffState.pending ? (
        <div role="status" aria-live="polite" className="flex flex-1 items-center justify-center rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-8 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('tools.compare.text.computing')}
        </div>
      ) : diffState.error ? (
        <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4 text-[length:var(--text-12)] text-[var(--danger)]">
          {diffState.error}
        </div>
      ) : diff ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <StatsBar stats={diff.stats} identical={diff.hunks.length === 0} />
            <div className="flex flex-wrap items-center gap-1.5">
              {large && <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('tools.compare.text.large_mode')}</span>}
              <Button size="sm" variant="ghost" onClick={() => void copyPatch()} disabled={!patch}>
                <span className="flex items-center gap-1"><Copy size={13} aria-hidden="true" />{t('tools.compare.export.copy_patch')}</span>
              </Button>
              <Button size="sm" variant="ghost" onClick={() => downloadBlob(safeFilename(left.name || right.name, 'comparison', '.patch'), patch, 'text/x-patch;charset=utf-8')} disabled={!patch}>
                <span className="flex items-center gap-1"><Download size={13} aria-hidden="true" />{t('tools.compare.export.download_patch')}</span>
              </Button>
              <Button size="sm" variant="ghost" onClick={exportReport}>
                <span className="flex items-center gap-1"><FileDown size={13} aria-hidden="true" />{t('tools.compare.export.report')}</span>
              </Button>
            </div>
          </div>
          {diff.coarse && (
            <p className="rounded-[var(--r-sm)] border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-2 py-1 text-[length:var(--text-11)] text-[var(--warning)]">
              {t('tools.compare.text.coarse')}
            </p>
          )}
          <div className="min-h-[320px] flex-1 overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)]">
            {large ? (
              <VirtualDiffView
                rows={diff.rows}
                label={t('tools.compare.text.title')}
                leftLabel={left.name || t('tools.compare.text.left')}
                rightLabel={right.name || t('tools.compare.text.right')}
                focusIndex={largeFocusRow}
              />
            ) : (
              <MergeHost
                ref={hostRef}
                left={settledLeft}
                right={settledRight}
                diff={diff}
                options={options}
                mode={mode}
                collapseUnchanged={collapseUnchanged}
                language={language}
                leftName={left.name}
                rightName={right.name}
              />
            )}
          </div>
          <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            {t('tools.compare.text.keyboard_hint')}
          </p>
        </>
      ) : null}

      <SaveDialog
        open={saveOpen}
        defaultName={left.name && right.name ? `${left.name} ↔ ${right.name}` : (left.name || right.name || t('tools.compare.save.default_name'))}
        busy={saving}
        onClose={() => setSaveOpen(false)}
        onSave={(name) => void save(name)}
      />
    </div>
  )
}

function extensionOf(name: string): string | null {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim())
  return match ? match[1]!.toLowerCase() : null
}
