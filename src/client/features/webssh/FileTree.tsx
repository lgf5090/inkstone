import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Folder, X } from 'lucide-react'
import type { WebsshSftpEntry } from '@shared/webssh/types'
import { IconButton, Spinner } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { websshApi } from './api'

interface FileTreeProps {
  sessionId: string
  rootPath: string
  currentPath: string
  onNavigate: (path: string) => void
  onClose: () => void
}

function baseName(path: string): string {
  if (path === '/') return '/'
  return path.split('/').filter(Boolean).pop() ?? path
}

export function FileTree({ sessionId, rootPath, currentPath, onNavigate, onClose }: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([rootPath]))
  const [cache, setCache] = useState<Record<string, WebsshSftpEntry[]>>({})
  const [loading, setLoading] = useState<Record<string, boolean>>({})

  const load = useCallback(async (path: string) => {
    setLoading((current) => ({ ...current, [path]: true }))
    try {
      const listing = await websshApi.listDir(sessionId, path)
      const directories = listing.entries.filter((entry) => entry.kind === 'directory')
      setCache((current) => ({ ...current, [path]: directories }))
    } catch {
      setCache((current) => {
        const next = { ...current }
        delete next[path]
        return next
      })
    } finally {
      setLoading((current) => ({ ...current, [path]: false }))
    }
  }, [sessionId])

  useEffect(() => {
    setExpanded(new Set([rootPath]))
    setCache({})
    void load(rootPath)
  }, [rootPath, load])

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else {
        next.add(path)
        if (!cache[path]) void load(path)
      }
      return next
    })
  }

  const renderRows = (path: string, depth: number): ReactNode => {
    const children = cache[path] ?? []
    return children.map((entry) => (
      <li key={entry.path}>
        <div
          className="flex items-center gap-0.5 rounded-[var(--r-xs)] hover:bg-[var(--bg-hover)]"
          style={{ paddingInlineStart: `${depth * 12 + 2}px` }}
        >
          <button
            type="button"
            aria-label={expanded.has(entry.path) ? t('webssh.sftp.tree.collapse') : t('webssh.sftp.tree.expand')}
            aria-expanded={expanded.has(entry.path)}
            className="flex size-5 shrink-0 items-center justify-center rounded-[var(--r-xs)] text-[var(--text-quaternary)] hover:text-[var(--text-primary)]"
            onClick={() => toggle(entry.path)}
          >
            {expanded.has(entry.path) ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
          </button>
          <button
            type="button"
            aria-current={entry.path === currentPath ? 'true' : undefined}
            className={`flex min-w-0 flex-1 items-center gap-1 rounded-[var(--r-xs)] px-1 py-0.5 text-start text-[length:var(--text-11-5)] ${
              entry.path === currentPath ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
            }`}
            onClick={() => onNavigate(entry.path)}
          >
            <Folder size={12} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          </button>
        </div>
        {expanded.has(entry.path) && (loading[entry.path] ? (
          <div className="flex items-center gap-1 py-1" style={{ paddingInlineStart: `${(depth + 1) * 12 + 20}px` }}>
            <Spinner size={10} />
          </div>
        ) : (
          <ul>{renderRows(entry.path, depth + 1)}</ul>
        ))}
      </li>
    ))
  }

  return (
    <aside
      aria-label={t('webssh.sftp.tree.title')}
      className="flex min-h-0 w-[180px] shrink-0 flex-col border-e border-[var(--border-subtle)] bg-[var(--bg-sunken)]"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-1.5 py-1">
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">
          {t('webssh.sftp.tree.title')}
        </span>
        <Tooltip label={t('webssh.actions.close')}>
          <IconButton label={t('webssh.actions.close')} size="xs" onClick={onClose}>
            <X size={12} aria-hidden="true" />
          </IconButton>
        </Tooltip>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-1">
        <li>
          <div className="flex items-center gap-0.5 rounded-[var(--r-xs)] hover:bg-[var(--bg-hover)]">
            <button
              type="button"
              aria-label={expanded.has(rootPath) ? t('webssh.sftp.tree.collapse') : t('webssh.sftp.tree.expand')}
              aria-expanded={expanded.has(rootPath)}
              className="flex size-5 shrink-0 items-center justify-center rounded-[var(--r-xs)] text-[var(--text-quaternary)] hover:text-[var(--text-primary)]"
              onClick={() => toggle(rootPath)}
            >
              {expanded.has(rootPath) ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
            </button>
            <button
              type="button"
              aria-current={rootPath === currentPath ? 'true' : undefined}
              className={`flex min-w-0 flex-1 items-center gap-1 rounded-[var(--r-xs)] px-1 py-0.5 text-start text-[length:var(--text-11-5)] ${
                rootPath === currentPath ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
              }`}
              onClick={() => onNavigate(rootPath)}
            >
              <Folder size={12} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{baseName(rootPath)}</span>
            </button>
          </div>
          {expanded.has(rootPath) && (loading[rootPath] ? (
            <div className="flex items-center gap-1 py-1 ps-5"><Spinner size={10} /></div>
          ) : (
            <ul>{renderRows(rootPath, 1)}</ul>
          ))}
        </li>
      </ul>
    </aside>
  )
}
