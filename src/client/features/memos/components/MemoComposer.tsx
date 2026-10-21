import { useId, useState, type KeyboardEvent, type ReactElement } from 'react'
import { MEMO_DEFAULT_VISIBILITY } from '@shared/memos/constants'
import { MEMO_VISIBILITIES, type Memo, type MemoVisibility } from '@shared/memos/types'
import { Button } from '../../../components/primitives'
import { Select, Textarea } from '../../../components/form'
import { t, type MessageKey } from '../../../lib/i18n'
import { isImeComposing } from '../../../lib/ime'
import { useUi } from '../../../store/ui'
import { useMemos } from '../state'

const VISIBILITY_KEYS: Record<MemoVisibility, MessageKey> = {
  private: 'memos.visibility.private',
  protected: 'memos.visibility.protected',
  public: 'memos.visibility.public',
}

export interface MemoComposerProps {
  memo?: Memo
  spaceId?: string | null
  onSaved?: (memo: Memo) => void
  onCancel?: () => void
}

export function MemoComposer({ memo, spaceId = null, onSaved, onCancel }: MemoComposerProps): ReactElement {
  const fieldId = useId()
  const [text, setText] = useState(memo?.content ?? '')
  const [visibility, setVisibility] = useState<MemoVisibility>(memo?.visibility ?? MEMO_DEFAULT_VISIBILITY)
  const [saving, setSaving] = useState(false)
  const conflict = useMemos((state) => state.conflict)
  const clearConflict = useMemos((state) => state.clearConflict)
  const editing = memo !== undefined
  const showConflict = memo !== undefined && conflict?.memoId === memo.id

  const submit = async (): Promise<void> => {
    if (saving || !text.trim()) return
    setSaving(true)
    const state = useMemos.getState()
    const saved = memo
      ? await state.patch(memo.id, { rev: memo.rev, content: text })
      : await state.create({ content: text, visibility, spaceId })
    setSaving(false)
    if (!saved) {
      useUi.getState().toast({
        title: t('memos.composer.failed'),
        description: useMemos.getState().mutationError ?? undefined,
        tone: 'danger',
      })
      return
    }
    useUi.getState().toast({
      title: editing ? t('memos.composer.saved') : t('memos.composer.created'),
      tone: 'success',
    })
    if (!editing) {
      setText('')
      setVisibility(MEMO_DEFAULT_VISIBILITY)
    }
    onSaved?.(saved)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || isImeComposing(event)) return
    if (!event.metaKey && !event.ctrlKey) return
    event.preventDefault()
    void submit()
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2.5 shadow-sm"
    >
      <label htmlFor={fieldId} className="sr-only">
        {t(editing ? 'memos.composer.edit_label' : 'memos.composer.label')}
      </label>
      <Textarea
        id={fieldId}
        value={text}
        rows={editing ? 5 : 3}
        autoFocus={editing}
        placeholder={t('memos.composer.placeholder')}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!editing ? (
          <Select
            aria-label={t('memos.composer.visibility')}
            value={visibility}
            onChange={(event) => {
              const next = MEMO_VISIBILITIES.find((value) => value === event.target.value)
              if (next) setVisibility(next)
            }}
            className="h-8 w-28 text-[length:var(--text-11-5)] md:h-7"
          >
            {MEMO_VISIBILITIES.map((value) => (
              <option key={value} value={value}>{t(VISIBILITY_KEYS[value])}</option>
            ))}
          </Select>
        ) : null}
        <span className="hidden text-[length:var(--text-10-5)] text-[var(--text-quaternary)] sm:inline">
          {t('memos.composer.hint')}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {onCancel ? (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              {t('memos.composer.cancel')}
            </Button>
          ) : null}
          <Button type="submit" size="sm" variant="primary" loading={saving} disabled={!text.trim()}>
            {saving ? t('memos.composer.saving') : t('memos.composer.save')}
          </Button>
        </div>
      </div>
      {showConflict ? (
        <div role="alert" className="mt-2 flex items-start gap-2 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2 py-1.5">
          <p className="min-w-0 flex-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--danger)]">
            {t('memos.composer.conflict')}
          </p>
          <Button size="sm" variant="ghost" className="h-6 shrink-0 px-1.5" onClick={clearConflict}>
            {t('memos.composer.dismiss')}
          </Button>
        </div>
      ) : null}
    </form>
  )
}
