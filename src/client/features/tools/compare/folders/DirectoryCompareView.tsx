/**
 * Two folders compared as trees.
 *
 * Each side is reduced to a manifest while the folder is picked — path, size, hash — and the two
 * manifests are compared by path. The screen draws the union as one tree with two columns, so a
 * reader sees "this file exists on the left only" without opening two windows and counting.
 */
import { useEffect, useState, type DragEvent } from 'react'
import { ChevronRight, Download, FolderOpen, FolderTree } from 'lucide-react'
import { Button } from '../../../../components/primitives'
import { Empty } from '../../../../components/feedback'
import { cn } from '../../../../lib/cn'
import { treeIndent } from '../../../../lib/tree/indent'
import { t } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import type { DirCompareResult, DirManifest, DirTreeNode } from '@shared/tools/compare/types'
import { compareDirectories } from '@shared/tools/compare/directory'
import { compareApi } from '../api'
import { SaveDialog } from '../components/SaveDialog'
import { downloadBlob } from '../lib/download'
import { manifestFromEntry, manifestFromFiles, type ManifestProgress } from '../lib/files'

type Side = 'left' | 'right'

const STATUS_STYLE: Readonly<Record<DirTreeNode['status'], string>> = {
  same: 'text-[var(--text-tertiary)]',
  different: 'text-[var(--warning)]',
  left_only: 'text-[var(--accent)]',
  right_only: 'text-[var(--accent)]',
}

export function DirectoryCompareView() {
  const [left, setLeft] = useState<DirManifest | null>(null)
  const [right, setRight] = useState<DirManifest | null>(null)
  const [result, setResult] = useState<DirCompareResult | null>(null)
  const [progress, setProgress] = useState<ManifestProgress | null>(null)
  const [busy, setBusy] = useState<Side | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [saveOpen, setSaveOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const ingest = async (side: Side, work: () => Promise<DirManifest>) => {
    setBusy(side)
    setProgress(null)
    try {
      const manifest = await work()
      if (side === 'left') setLeft(manifest)
      else setRight(manifest)
    } catch (error) {
      const message = error instanceof Error && error.message === 'too-many-files'
        ? t('tools.compare.dir.too_many')
        : error instanceof Error && error.message === 'too-much-data'
          ? t('tools.compare.dir.too_large')
          : t('tools.compare.dir.read_failed')
      useUi.getState().toast({ title: message, tone: 'danger' })
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  const pick = (side: Side, files: FileList | null) => {
    if (!files || !files.length) return
    const list = Array.from(files)
    const root = list[0]?.webkitRelativePath?.split('/')[0] ?? list[0]?.name ?? 'folder'
    void ingest(side, () => manifestFromFiles(list, root, setProgress))
  }

  const drop = (side: Side, event: DragEvent) => {
    event.preventDefault()
    const items = Array.from(event.dataTransfer.items ?? [])
    const entry = items.map((item) => item.webkitGetAsEntry()).find((candidate) => candidate?.isDirectory)
    if (entry) {
      void ingest(side, () => manifestFromEntry(entry, setProgress))
      return
    }
    const files = event.dataTransfer.files
    if (files?.length) void ingest(side, () => manifestFromFiles(Array.from(files), files[0]?.name ?? 'folder', setProgress))
  }

  // The comparison is derived from both manifests, not from whichever one the event handler last saw:
  // two `setInputFiles` calls can land before React re-renders, and a closure would then compare one
  // new manifest against a stale one.
  useEffect(() => {
    if (!left || !right) {
      setResult(null)
      return
    }
    const compared = compareDirectories(left, right)
    setResult(compared)
    setExpanded(new Set(compared.tree.filter((node) => !node.isFile).slice(0, 3).map((node) => node.path)))
  }, [left, right])

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const exportReport = () => {
    if (!result) return
    const lines = [
      `# ${t('tools.compare.dir.title')}`,
      '',
      `- ${t('tools.compare.text.left')}: ${left?.root ?? '—'}`,
      `- ${t('tools.compare.text.right')}: ${right?.root ?? '—'}`,
      `- ${t('tools.compare.dir.same')}: ${result.counts.same}`,
      `- ${t('tools.compare.dir.different')}: ${result.counts.different}`,
      `- ${t('tools.compare.dir.left_only')}: ${result.counts.leftOnly}`,
      `- ${t('tools.compare.dir.right_only')}: ${result.counts.rightOnly}`,
      '',
      '```',
      ...result.rows
        .filter((row) => row.status !== 'same')
        .slice(0, 500)
        .map((row) => `${row.status.padEnd(11)} ${row.path}`),
      '```',
    ]
    downloadBlob('directory-comparison.md', lines.join('\n'), 'text/markdown;charset=utf-8')
  }

  const save = async (name: string) => {
    if (!left || !right || !result) return
    setSaving(true)
    try {
      const leftFile = new File([JSON.stringify(left)], `${left.root}.manifest.json`, { type: 'application/json' })
      const rightFile = new File([JSON.stringify(right)], `${right.root}.manifest.json`, { type: 'application/json' })
      const [leftAsset, rightAsset] = await Promise.all([
        compareApi.uploadAsset('dir', leftFile),
        compareApi.uploadAsset('dir', rightFile),
      ])
      await compareApi.createProject({
        name,
        kind: 'dir',
        left_label: left.root,
        right_label: right.root,
        summary: {
          dirCounts: {
            same: result.counts.same,
            different: result.counts.different,
            leftOnly: result.counts.leftOnly,
            rightOnly: result.counts.rightOnly,
          },
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

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 overflow-y-auto p-3 sm:p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">{t('tools.compare.dir.title')}</h2>
          <p className="mt-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('tools.compare.dir.desc')}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={exportReport} disabled={!result}>
            <span className="flex items-center gap-1"><Download size={13} aria-hidden="true" />{t('tools.compare.dir.export')}</span>
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setSaveOpen(true)} disabled={!result}>
            {t('tools.compare.save.open')}
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {(['left', 'right'] as const).map((side) => {
          const manifest = side === 'left' ? left : right
          return (
            <section
              key={side}
              aria-label={side === 'left' ? t('tools.compare.text.left') : t('tools.compare.text.right')}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => drop(side, event)}
              className="flex min-h-[110px] flex-col gap-2 rounded-[var(--r-md)] border-2 border-dashed border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-1.5 text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
                  <FolderTree size={14} aria-hidden="true" />
                  {side === 'left' ? t('tools.compare.text.left') : t('tools.compare.text.right')}
                </h3>
                {busy === side && <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('tools.compare.dir.scanning')}</span>}
              </div>
              {manifest ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[length:var(--text-11)] text-[var(--text-secondary)]" title={manifest.root}>{manifest.root}</span>
                  <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                    {t('tools.compare.dir.files', { count: manifest.entries.length })}
                  </span>
                </div>
              ) : (
                <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('tools.compare.dir.hint')}</p>
              )}
              <FolderButton side={side} onPick={(files) => pick(side, files)} />
              {busy === side && progress && (
                <span className="truncate font-mono text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{progress.label}</span>
              )}
            </section>
          )
        })}
      </div>

      {result ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <CountPill label={t('tools.compare.dir.same')} value={result.counts.same} tone="neutral" />
            <CountPill label={t('tools.compare.dir.different')} value={result.counts.different} tone="warning" />
            <CountPill label={t('tools.compare.dir.left_only')} value={result.counts.leftOnly} tone="accent" />
            <CountPill label={t('tools.compare.dir.right_only')} value={result.counts.rightOnly} tone="accent" />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)]">
            <div className="grid grid-cols-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] text-[length:var(--text-11)] font-semibold text-[var(--text-secondary)]">
              <span className="truncate border-r border-[var(--border-subtle)] px-3 py-1.5">{left?.root ?? t('tools.compare.text.left')}</span>
              <span className="truncate px-3 py-1.5">{right?.root ?? t('tools.compare.text.right')}</span>
            </div>
            <div className="max-h-[52vh] overflow-auto" role="tree" aria-label={t('tools.compare.dir.title')}>
              {result.tree.map((node) => (
                <TreeNode
                  key={node.path}
                  node={node}
                  depth={0}
                  expanded={expanded}
                  onToggle={toggle}
                />
              ))}
            </div>
          </div>
          <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('tools.compare.dir.legend')}</p>
        </>
      ) : (
        <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
          <Empty art="folder" compact title={t('tools.compare.dir.need_both')} description={t('tools.compare.dir.need_both_desc')} />
        </div>
      )}

      <SaveDialog
        open={saveOpen}
        defaultName={left && right ? `${left.root} ↔ ${right.root}` : t('tools.compare.save.default_name')}
        busy={saving}
        onClose={() => setSaveOpen(false)}
        onSave={(name) => void save(name)}
      />
    </div>
  )
}

function FolderButton({ side, onPick }: { side: Side; onPick: (files: FileList | null) => void }) {
  const id = `compare-folder-${side}`
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => document.getElementById(id)?.click()}>
        <span className="flex items-center gap-1"><FolderOpen size={13} aria-hidden="true" />{t('tools.compare.dir.pick')}</span>
      </Button>
      <input
        id={id}
        type="file"
        className="hidden"
        aria-label={t('tools.compare.dir.pick')}
        multiple
        // The directory picker is the browser's own; the appearance is the button above, not the input.
        {...{ webkitdirectory: '' }}
        onChange={(event) => {
          onPick(event.target.files)
          event.target.value = ''
        }}
      />
    </>
  )
}

function CountPill({ label, value, tone }: { label: string; value: number; tone: 'neutral' | 'warning' | 'accent' }) {
  return (
    <span
      className={cn(
        'rounded-full border px-2 py-0.5 text-[length:var(--text-11)] tabular-nums',
        tone === 'neutral' && 'border-[var(--border-subtle)] text-[var(--text-secondary)]',
        tone === 'warning' && 'border-[var(--warning)]/40 text-[var(--warning)]',
        tone === 'accent' && 'border-[var(--accent)]/40 text-[var(--accent)]',
      )}
    >
      {label} {value}
    </span>
  )
}

function TreeNode({ node, depth, expanded, onToggle }: {
  node: DirTreeNode
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
}) {
  const open = expanded.has(node.path)
  const presentLeft = node.status !== 'right_only'
  const presentRight = node.status !== 'left_only'
  return (
    <div role="treeitem" aria-expanded={node.isFile ? undefined : open} aria-level={depth + 1}>
      <div className={cn('grid grid-cols-2 border-b border-[var(--border-subtle)]/60 text-[length:var(--text-12)]', node.status !== 'same' && 'bg-[var(--bg-hover)]/40')}>
        <div className="flex min-w-0 items-center gap-1 border-r border-[var(--border-subtle)] px-2 py-1" style={{ paddingLeft: treeIndent(depth) }}>
          {node.isFile ? <span aria-hidden="true" className="w-3 shrink-0" /> : (
            <button
              type="button"
              onClick={() => onToggle(node.path)}
              aria-label={open ? t('tools.compare.dir.collapse') : t('tools.compare.dir.expand')}
              className="shrink-0 rounded-[var(--r-xs)] p-0.5 hover:bg-[var(--bg-hover)]"
            >
              <ChevronRight size={12} className={cn('transition-transform', open && 'rotate-90')} aria-hidden="true" />
            </button>
          )}
          {presentLeft ? (
            <span className={cn('truncate font-mono', node.isFile ? STATUS_STYLE[node.status] : 'text-[var(--text-primary)]')} title={node.path}>{node.name}</span>
          ) : <span className="text-[var(--text-quaternary)]">—</span>}
        </div>
        <div className="flex min-w-0 items-center gap-1 px-2 py-1" style={{ paddingLeft: treeIndent(depth) }}>
          {node.isFile ? <span aria-hidden="true" className="w-3 shrink-0" /> : <span aria-hidden="true" className="w-3 shrink-0" />}
          {presentRight ? (
            <span className={cn('truncate font-mono', node.isFile ? STATUS_STYLE[node.status] : 'text-[var(--text-primary)]')} title={node.path}>{node.name}</span>
          ) : <span className="text-[var(--text-quaternary)]">—</span>}
        </div>
      </div>
      {open && node.children.map((child) => (
        <TreeNode key={child.path} node={child} depth={depth + 1} expanded={expanded} onToggle={onToggle} />
      ))}
    </div>
  )
}
