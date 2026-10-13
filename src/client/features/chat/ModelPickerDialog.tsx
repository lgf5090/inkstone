/**
 * The vendor's own model list, ticked into the reader's assistant.
 *
 * Nothing here is a bundled catalogue: the rows are what this key can call right now, and when the listing
 * fails the dialog says so and leaves the manual entry as the way in. Search and the chips are the reader's
 * filters over that list — a service answers with hundreds of ids and the one they want is named something
 * like `deepseek-v3.2-exp`, so the list has to be narrowed without leaving the dialog.
 */
import { useEffect, useMemo, useState } from 'react'
import { Check, RefreshCw, Search } from 'lucide-react'
import type { AssistantModel, AssistantProvider, AssistantVendorModel } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { matchesQuery } from '../../lib/fuzzy'
import { usePinyinVersion } from '../../lib/pinyin'
import { cn } from '../../lib/cn'
import { Input } from '../../components/form'
import { Button } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { useAssistant } from './assistant-store'

export interface PickerRow {
  model: AssistantVendorModel
  added: boolean
}

/** The vendor families in the list, so the chips are the account's own, not a list of brands. */
export function vendorFamilies(listed: AssistantVendorModel[]): string[] {
  return [...new Set(listed.map((entry) => entry.ownedBy).filter((entry): entry is string => Boolean(entry)))].sort()
}

export function pickerRows(
  listed: AssistantVendorModel[],
  existing: AssistantModel[],
  query: string,
  family: string | null,
  onlyNew: boolean,
): PickerRow[] {
  const owned = new Set(existing.map((model) => model.model))
  return listed
    .filter((entry) => (family ? entry.ownedBy === family : true) && (onlyNew ? !owned.has(entry.id) : true))
    .filter((entry) => matchesQuery(`${entry.id} ${entry.label}`, query))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id))
    .map((model) => ({ model, added: owned.has(model.id) }))
}

export function ModelPickerDialog({ provider, onAdded, onClose, onCustom }: {
  provider: AssistantProvider
  onAdded: (count: number) => void
  onClose: () => void
  onCustom: () => void
}) {
  const models = useAssistant((state) => state.models)
  const listed = useAssistant((state) => state.vendorModels)
  const loading = useAssistant((state) => state.vendorModelsLoading)
  const error = useAssistant((state) => state.vendorModelsError)
  const load = useAssistant((state) => state.loadVendorModels)
  const addVendorModels = useAssistant((state) => state.addVendorModels)
  const [query, setQuery] = useState('')
  const [family, setFamily] = useState<string | null>(null)
  const [onlyNew, setOnlyNew] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const pinyinVersion = usePinyinVersion()

  useEffect(() => { void load(provider.id) }, [provider.id, load])

  const rows = useMemo(
    () => pickerRows(listed, models, query, family, onlyNew),
    // The filter reads the reading table, so a listing that lands before the dictionary does must be rebuilt.
    [listed, models, query, family, onlyNew, pinyinVersion],
  )
  const families = useMemo(() => vendorFamilies(listed), [listed])
  const toggle = (id: string) => setPicked((current) => (current.includes(id)
    ? current.filter((entry) => entry !== id)
    : [...current, id]))

  const submit = async () => {
    setBusy(true)
    const count = await addVendorModels(provider.id, picked)
    setBusy(false)
    onAdded(count)
    if (count) onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('assistant.picker.title', { label: provider.label })}
      description={provider.baseUrl}
      width={620}
      bodyClassName="p-4"
    >
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-1.5">
          <Input
            leading={<Search size={13} />}
            aria-label={t('assistant.picker.search')}
            placeholder={t('assistant.picker.search')}
            value={query}
            autoFocus
            className="min-w-0 flex-1"
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            aria-label={t('assistant.picker.refresh')}
            onClick={() => void load(provider.id)}
            className="flex size-8 shrink-0 items-center justify-center rounded-[var(--r-sm)] border border-[var(--border-default)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip active={!onlyNew} onClick={() => setOnlyNew(false)}>{t('assistant.picker.all')}</FilterChip>
          <FilterChip active={onlyNew} onClick={() => setOnlyNew(true)}>{t('assistant.picker.new_only')}</FilterChip>
          {families.map((entry) => (
            <FilterChip key={entry} active={family === entry} onClick={() => setFamily(family === entry ? null : entry)}>
              {entry}
            </FilterChip>
          ))}
        </div>

        {error && (
          <p className="rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-sunken)] px-2.5 py-2 text-[11.5px] leading-snug text-[var(--warning)]">
            {t('assistant.picker.failed')}
            <span className="mt-0.5 block break-words text-[var(--text-tertiary)]">{error}</span>
          </p>
        )}
        {!loading && !error && rows.length === 0 && (
          <p className="py-6 text-center text-[12px] text-[var(--text-quaternary)]">{t('assistant.picker.none')}</p>
        )}

        <ul className="max-h-[46vh] min-h-[140px] overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-raised)] p-1">
          {rows.map(({ model, added }) => {
            const pickedHere = picked.includes(model.id)
            return (
              <li key={model.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={pickedHere}
                  onClick={() => toggle(model.id)}
                  className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left hover:bg-[var(--bg-hover)]"
                >
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded border',
                      pickedHere ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]' : 'border-[var(--border-strong)]',
                    )}
                  >
                    {pickedHere && <Check size={11} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] text-[var(--text-primary)]">{model.label}</span>
                    <span className="block truncate font-mono text-[10.5px] text-[var(--text-quaternary)]">{model.id}</span>
                  </span>
                  {added && (
                    <span className="shrink-0 text-[10.5px] text-[var(--text-quaternary)]">{t('assistant.picker.already')}</span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>

        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <Button variant="ghost" size="sm" onClick={onCustom}>{t('assistant.picker.custom')}</Button>
          <div className="flex-1" />
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!picked.length || busy} onClick={() => void submit()}>
            {t('assistant.picker.add', { count: picked.length })}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function FilterChip({ active, onClick, children }: { active: boolean, onClick: () => void, children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-full border px-2 py-0.5 text-[11.5px]',
        active
          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
          : 'border-[var(--border-default)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]',
      )}
    >
      {children}
    </button>
  )
}
