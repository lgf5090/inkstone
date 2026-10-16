/**
 * Choosing which folders the assistant may read.
 *
 * Two surfaces ask the same question — the account's standing scope, and one project's knowledge — so the
 * picker is one component with a value and a change handler rather than two lists that drift apart. The
 * paths are shown rather than names because a vault has two "Notes" before lunch.
 *
 * The list is capped because the scope travels in the system prompt on every turn: a reader who selects
 * the whole tree one folder at a time would be paying for that list with every message.
 */

import { useEffect, useState } from 'react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'

export const MAX_SCOPE_FOLDERS = 12

/** One notebook folder, named both ways: a chip shows the name, a picker shows the path. */
export interface VaultFolderOption {
  id: string
  name: string
  path: string
}

/**
 * The reader's note folders with their full paths.
 *
 * Asked for by every surface that has to name a folder — the standing scope, a project's knowledge, a
 * prompt's — and none of them can name one from an id alone.
 */
export function useVaultFolders(): VaultFolderOption[] {
  const [folders, setFolders] = useState<VaultFolderOption[]>([])
  useEffect(() => {
    void api.folders.list().then((result) => {
      const byId = new Map(result.folders.map((folder) => [folder.id, folder]))
      const pathOf = (id: string): string => {
        const parts: string[] = []
        let cursor = byId.get(id)
        for (let depth = 0; cursor && depth < 12; depth++) {
          parts.unshift(cursor.name)
          cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
        }
        return parts.join(' / ')
      }
      setFolders(result.folders.map((folder) => ({ id: folder.id, name: folder.name, path: pathOf(folder.id) })))
    }).catch(() => setFolders([]))
  }, [])
  return folders
}

export function NoteScopePicker({ value, onChange, disabled }: {
  value: readonly string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
}) {
  const folders = useVaultFolders()

  if (!folders.length) {
    return <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('assistant.settings.note_scope_none')}</p>
  }

  return (
    <ul className="flex max-h-52 flex-col gap-px overflow-y-auto">
      {folders.map((folder) => {
        const on = value.includes(folder.id)
        return (
          <li key={folder.id}>
            <button
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => {
                const next = on ? value.filter((entry) => entry !== folder.id) : [...value, folder.id]
                onChange(next.slice(0, MAX_SCOPE_FOLDERS))
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1 text-left text-[length:var(--text-12-5)] disabled:opacity-60',
                on ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
              )}
            >
              <span aria-hidden className={cn('size-2 shrink-0 rounded-full border', on ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--border-strong)]')} />
              <span className="min-w-0 truncate">{folder.path}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
