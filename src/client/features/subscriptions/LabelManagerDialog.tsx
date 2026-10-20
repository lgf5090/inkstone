/**
 * Where a type or a category is named, renamed and given its face.
 *
 * The registry used to be write-only: saving a subscription added a name and nothing ever removed or
 * corrected one, so a typo sat in the suggestion list forever and a two-tag value arrived as one name
 * while the rail showed two filters. This is the surface that makes those states reachable.
 *
 * Built-in names appear here too once they are in use, which is the point rather than a side effect —
 * a reader who decides the built-in streaming type should be amber instead of red is editing the same
 * row as one who named a service themselves.
 */
import { useState, type ReactElement } from 'react'
import { Check, Plus, Trash2, X } from 'lucide-react'
import { labelNamesOf, LABEL_MAX, type LabelEntry, type LabelKind } from '@shared/subscriptions/model'
import { Button, IconButton } from '../../components/primitives'
import { Input } from '../../components/form'
import { Modal } from '../../components/overlay'
import { t, useLocaleRepaint } from '../../lib/i18n'
import { isImeComposing } from '../../lib/ime'
import { LabelGlyph, LabelStylePicker, useLabelIdentity } from './label-identity'
import { useSubscriptions } from './store'

export function LabelManagerDialog({ open, onClose }: {
  open: boolean
  onClose: () => void
}): ReactElement {
  useLocaleRepaint()
  const types = useSubscriptions((state) => state.types)
  const categories = useSubscriptions((state) => state.categories)

  return (
    <Modal open={open} onClose={onClose} title={t('subscriptions.picker.manage')} width={560} bodyClassName="px-4 py-3">
      <p className="pb-3 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">
        {t('subscriptions.picker.manage_hint')}
      </p>
      <div className="space-y-5">
        <LabelSection kind="type" title={t('subscriptions.picker.types_title')} labels={types} />
        <LabelSection kind="category" title={t('subscriptions.picker.categories_title')} labels={categories} />
      </div>
    </Modal>
  )
}

function LabelSection({ kind, title, labels }: {
  kind: LabelKind
  title: string
  labels: readonly LabelEntry[]
}): ReactElement {
  const [draft, setDraft] = useState('')
  const store = useSubscriptions.getState
  const known = labels.map((entry) => entry.name)

  const add = async (): Promise<void> => {
    const name = draft.trim()
    if (!name || known.includes(name)) return
    if (await store().addLabel(kind, name)) setDraft('')
  }

  return (
    <section>
      <h3 className="pb-1.5 text-[length:var(--text-11)] font-medium uppercase tracking-wide text-[var(--text-quaternary)]">{title}</h3>
      {labels.length === 0 && (
        <p className="py-1 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('subscriptions.picker.empty')}</p>
      )}
      <ul className="space-y-1">
        {labels.map((entry) => <LabelRow key={`${kind}:${entry.name}`} kind={kind} entry={entry} />)}
      </ul>
      <div className="flex items-center gap-1.5 pt-2">
        <Input
          className="min-w-0 flex-1"
          value={draft}
          maxLength={LABEL_MAX}
          aria-label={`${title} — ${t('subscriptions.picker.add')}`}
          placeholder={title}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (isImeComposing(event)) return
            if (event.key === 'Enter') {
              event.preventDefault()
              void add()
            }
          }}
        />
        <Button variant="ghost" icon={<Plus size={13} />} disabled={!draft.trim() || known.includes(draft.trim())} onClick={() => void add()}>
          {t('subscriptions.picker.add')}
        </Button>
      </div>
    </section>
  )
}

function LabelRow({ kind, entry }: { kind: LabelKind; entry: LabelEntry }): ReactElement {
  const [renaming, setRenaming] = useState(false)
  const [value, setValue] = useState(entry.name)
  const identityOf = useLabelIdentity()
  const store = useSubscriptions.getState
  const identity = identityOf(kind, entry.name)
  // A name typed with a separator is not one label, and the row cannot edit what the registry does not
  // hold as one — so the field shows what is there and the count says why it is more than one word.
  const tokens = labelNamesOf(entry.name, kind)

  const commitRename = async (): Promise<void> => {
    const to = value.trim()
    setRenaming(false)
    if (!to || to === entry.name) {
      setValue(entry.name)
      return
    }
    if (await store().renameLabel(kind, entry.name, to)) return
    setValue(entry.name)
  }

  return (
    <li className="flex items-center gap-2 rounded-[var(--r-sm)] px-1.5 py-1 hover:bg-[var(--bg-hover)]">
      <LabelGlyph identity={identity} label={entry.name} size={13} named />
      {renaming ? (
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <Input
            className="min-w-0 flex-1"
            value={value}
            autoFocus
            maxLength={LABEL_MAX}
            aria-label={t('subscriptions.picker.rename_to')}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              // A label is a word the reader types, often in Han: while the input method is still
              // composing, Enter belongs to it and would otherwise commit a half-typed name.
              if (isImeComposing(event)) return
              if (event.key === 'Enter') void commitRename()
              if (event.key === 'Escape') {
                setValue(entry.name)
                setRenaming(false)
              }
            }}
            onBlur={() => void commitRename()}
          />
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setRenaming(true)}
          className="min-w-0 flex-1 truncate text-left text-[length:var(--text-12-5)] text-[var(--text-primary)]"
          title={t('subscriptions.picker.rename')}
        >
          {entry.name}
          {tokens.length > 1 && <span className="pl-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{tokens.length}</span>}
        </button>
      )}
      {renaming ? (
        <>
          <IconButton variant="ghost" label={t('subscriptions.picker.rename')} onClick={() => void commitRename()}><Check size={13} /></IconButton>
          <IconButton
            variant="ghost"
            label={t('subscriptions.cancel')}
            onClick={() => {
              setValue(entry.name)
              setRenaming(false)
            }}
          >
            <X size={13} />
          </IconButton>
        </>
      ) : (
        <>
          <LabelStylePicker kind={kind} name={entry.name} onPick={(style) => void store().setLabelStyle(kind, entry.name, style)} />
          <IconButton
            variant="ghost"
            label={t('subscriptions.picker.remove')}
            onClick={() => void store().removeLabel(kind, entry.name)}
          >
            <Trash2 size={13} />
          </IconButton>
        </>
      )}
    </li>
  )
}
