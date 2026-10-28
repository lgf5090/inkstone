/** A searchable list of the account's notes, used to open a tab or pick a copy target. */
import { useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { InknoteNoteMeta } from '@shared/inknote/types'
import { t } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { Modal } from '../../../components/overlay'
import { FilterInput } from '../../../components/FilterInput'
import { compileQuery, queryKeeps } from '../../../lib/query-match'
import { usePinyinVersion } from '../../../lib/pinyin'
import { isImeComposing } from '../../../lib/ime'
import { useInknoteStore } from '../store'

const EMPTY_NOTES: InknoteNoteMeta[] = []

export function NotePickerDialog({ open, onClose, onPick, title, excludeIds }: {
  open: boolean
  onClose: () => void
  onPick: (note: InknoteNoteMeta) => void
  title: string
  excludeIds?: readonly string[]
}) {
  const notes = useInknoteStore((state) => state.library?.notes) ?? EMPTY_NOTES
  const notebooks = useInknoteStore((state) => state.library?.notebooks) ?? []
  const [text, setText] = useState('')
  const [active, setActive] = useState(0)
  const pinyinVersion = usePinyinVersion()
  const query = useMemo(() => compileQuery(text), [text, pinyinVersion])
  const excluded = useMemo(() => new Set(excludeIds ?? []), [excludeIds])
  const visible = useMemo(() => notes
    .filter((note) => !excluded.has(note.id) && queryKeeps(query, note.title))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt), [notes, excluded, query, pinyinVersion])

  useEffect(() => {
    if (!open) return
    setText('')
    setActive(0)
  }, [open])
  useEffect(() => { setActive(0) }, [text])

  const pick = (note: InknoteNoteMeta | undefined) => {
    if (!note) return
    onPick(note)
    onClose()
  }

  const move = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event)) return
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => Math.min(visible.length - 1, value + 1)) }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => Math.max(0, value - 1)) }
    if (event.key === 'Enter') { event.preventDefault(); pick(visible[active]) }
  }

  return (
    <Modal open={open} onClose={onClose} title={title} width={520}>
      <div className="space-y-2">
        <FilterInput value={text} onChange={setText} query={query} label={title} size="panel" onKeyDown={move} escapeWhenEmpty="release"/>
        {visible.length === 0 && <p className="py-4 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('inknote.picker.empty')}</p>}
        <div className="max-h-80 overflow-y-auto">
          {visible.map((note, index) => (
            <button key={note.id} type="button" aria-current={index === active ? 'true' : undefined} onClick={() => pick(note)} className={cn('flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left', index === active ? 'bg-[var(--bg-active)]' : 'hover:bg-[var(--bg-hover)]')}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[length:var(--text-12)]">{note.title || t('inknote.untitled')}</span>
                <span className="block truncate text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
                  {notebooks.find((notebook) => notebook.id === note.notebookId)?.name ?? ''} · {t('inknote.pages_count', { count: note.pageCount })}
                </span>
              </span>
              {note.pinned && <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-tertiary)]">★</span>}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}
