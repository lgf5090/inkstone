/**
 * The tag chooser shared by a snippet's own tag row and the batch bar.
 *
 * A checkbox list rather than a text field: tags are a set, and a reader adding the same tag to eight
 * selected snippets should see what is already on them. A nested tag is shown with its path so two
 * tags called `demo` are not read as one. Creating a tag in the box adds it to this set and to the
 * account's tag tree in one step; there is no separate "manage tags" screen for a five-second task.
 */
import { useEffect, useMemo, useState } from 'react'
import { Check, Plus } from 'lucide-react'
import type { ScriptTag } from '@shared/scriptshub/types'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Input, commitOnEnter } from '../../components/form'
import { Modal } from '../../components/overlay'
import { tagPathOf } from './store'

export function TagPickerDialog({
  open,
  tags,
  selected,
  title,
  onClose,
  onConfirm,
  onCreate,
}: {
  open: boolean
  tags: readonly ScriptTag[]
  selected: readonly string[]
  title: string
  onClose: () => void
  onConfirm: (ids: string[]) => Promise<void> | void
  onCreate?: (name: string) => Promise<ScriptTag>
}) {
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(selected))
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const flat = useMemo(() => [...tags].sort((a, b) => tagPathOf(tags, a.id).map((tag) => tag.name).join('/').localeCompare(
    tagPathOf(tags, b.id).map((tag) => tag.name).join('/'),
  )), [tags])
  useEffect(() => {
    if (open) setChosen(new Set(selected))
  }, [open, selected.join(',')])

  const toggle = (id: string) => {
    setChosen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const create = async () => {
    const name = draft.trim()
    if (!name || !onCreate) return
    setSaving(true)
    try {
      const tag = await onCreate(name)
      setChosen((current) => new Set([...current, tag.id]))
      setDraft('')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={460}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('scriptshub.common.cancel')}</Button>
          <Button
            variant="primary"
            loading={saving}
            onClick={() => {
              setSaving(true)
              void Promise.resolve(onConfirm([...chosen])).finally(() => {
                setSaving(false)
                onClose()
              })
            }}
          >
            {t('scriptshub.common.apply')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        {onCreate && (
          <div className="flex gap-2">
            <Input
              value={draft}
              aria-label={t('scriptshub.dialog.new_tag')}
              placeholder={t('scriptshub.dialog.tag_placeholder')}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => commitOnEnter(event, () => void create())}
            />
            <Button variant="secondary" icon={<Plus size={13} aria-hidden="true" />} disabled={!draft.trim()} loading={saving} onClick={() => void create()}>
              {t('scriptshub.common.add')}
            </Button>
          </div>
        )}
        <div className="max-h-[46vh] space-y-1 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] p-1.5">
          {flat.length === 0 && (
            <p className="px-2 py-6 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('scriptshub.sidebar.no_tags')}</p>
          )}
          {flat.map((tag) => {
            const path = tagPathOf(tags, tag.id).map((entry) => entry.name).join(' / ')
            const on = chosen.has(tag.id)
            return (
              <button
                key={tag.id}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => toggle(tag.id)}
                className={cn(
                  'flex min-h-9 w-full items-center gap-2 rounded-[var(--r-sm)] px-2 text-left text-[length:var(--text-12)]',
                  on ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn('flex size-4 shrink-0 items-center justify-center rounded-[var(--r-xs)] border', on ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]' : 'border-[var(--border-default)]')}
                >
                  {on && <Check size={11} aria-hidden="true" />}
                </span>
                {tag.color && <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />}
                <span className="min-w-0 flex-1 truncate">{path}</span>
                {tag.snippetCount > 0 && <span className="tabular shrink-0 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{tag.snippetCount}</span>}
              </button>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}
