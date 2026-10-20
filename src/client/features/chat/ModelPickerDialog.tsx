/**
 * The vendor's own model list, ticked into the reader's assistant.
 *
 * Nothing here is a bundled catalogue: the rows are what this key can call right now, and when the listing
 * fails the dialog says so and leaves the manual entry as the way in. Search and the chips are the reader's
 * filters over that list — a service answers with hundreds of ids and the one they want is named something
 * like `deepseek-v3.2-exp`, so the list has to be narrowed without leaving the dialog.
 *
 * It opens in two situations that differ only in where the answer goes: on a saved provider, where the save
 * makes that provider's row match the ticks — adding what was ticked and dropping what was unticked — and on
 * the add form's unsaved address and key, where they come back as ids for the reader to confirm before anything
 * is created. The list, the filters and the count are the same work in both, which is why the second case is a
 * mode here rather than a second dialog in the form.
 */
import { useEffect, useMemo, useState } from 'react'
import { Check, RefreshCw, Search } from 'lucide-react'
import type { AssistantModel, AssistantProvider, AssistantVendorModel } from '@shared/assistant'
import { MAX_PROVIDER_MODELS } from '@shared/assistant'
import { iconForModel } from '@shared/assistant-icons'
import { t } from '../../lib/i18n'
import { matchesQuery } from '../../lib/fuzzy'
import { usePinyinVersion } from '../../lib/pinyin'
import { cn } from '../../lib/cn'
import { Input } from '../../components/form'
import { Button } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { AssistantIcon } from './AssistantIcon'
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
  /** What the reader already has: rows from a saved provider, or the ids a form is holding. */
  existing: readonly (AssistantModel | string)[],
  query: string,
  family: string | null,
  onlyNew: boolean,
): PickerRow[] {
  const owned = new Set(existing.map((entry) => (typeof entry === 'string' ? entry : entry.model)))
  return listed
    .filter((entry) => (family ? entry.ownedBy === family : true) && (onlyNew ? !owned.has(entry.id) : true))
    .filter((entry) => matchesQuery(`${entry.id} ${entry.label}`, query))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id))
    .map((model) => ({ model, added: owned.has(model.id) }))
}

export type PickerDraft = { protocol: string, baseUrl: string, apiKey: string, label: string }

export function ModelPickerDialog({ provider, draft, existing, onSynced, onPicked, onClose, onCustom }: {
  /** A saved provider: the ticks are written to it when the footer is pressed. */
  provider?: AssistantProvider
  /** An unsaved one: the listing is asked for with this key, and the ticks come back as ids. */
  draft?: PickerDraft
  /** Ids a form is already holding, so a row the reader typed can say so. */
  existing?: string[]
  /** What the save did, so the screen behind can say it: two numbers, because an untick removes. */
  onSynced?: (result: { added: number, removed: number }) => void
  onPicked?: (ids: string[]) => void
  onClose: () => void
  onCustom?: () => void
}) {
  const models = useAssistant((state) => state.models)
  const listed = useAssistant((state) => state.vendorModels)
  const loading = useAssistant((state) => state.vendorModelsLoading)
  const error = useAssistant((state) => state.vendorModelsError)
  const load = useAssistant((state) => state.loadVendorModels)
  const loadDraft = useAssistant((state) => state.loadDraftVendorModels)
  const syncVendorModels = useAssistant((state) => state.syncVendorModels)
  const [query, setQuery] = useState('')
  const [family, setFamily] = useState<string | null>(null)
  const [onlyNew, setOnlyNew] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const pinyinVersion = usePinyinVersion()

  const draftProtocol = draft?.protocol
  const draftBaseUrl = draft?.baseUrl
  const draftApiKey = draft?.apiKey
  useEffect(() => {
    if (draftProtocol && draftBaseUrl) void loadDraft({ protocol: draftProtocol, baseUrl: draftBaseUrl, apiKey: draftApiKey ?? '' })
    else if (provider) void load(provider.id)
  }, [provider, draftProtocol, draftBaseUrl, draftApiKey, load, loadDraft])

  const owned: readonly (AssistantModel | string)[] = draft ? existing ?? [] : models
  // The ticks open as what is held — the form's ids, or the models that came from this vendor's own list —
  // because the ticked set is the one the footer makes true, and an untick is how a model the vendor no
  // longer offers, or a preset that guessed at an id, leaves the account. A model typed in by hand is not
  // in the listing, so an untick cannot name it and the save leaves it alone.
  const held = useMemo(
    () => draft
      ? listed.filter((entry) => (existing ?? []).includes(entry.id)).map((entry) => entry.id)
      : models.filter((model) => model.providerId === provider?.id && listed.some((entry) => entry.id === model.model)).map((model) => model.model),
    [listed, draft, existing, models, provider],
  )
  // Seeded per listing, not per render: the reader's ticks must survive an unrelated settings reload, and
  // a fresh listing is the one moment the ticks are known to be stale.
  const [seeded, setSeeded] = useState<AssistantVendorModel[] | null>(null)
  if (listed !== seeded) {
    setSeeded(listed)
    setPicked(held)
  }
  const rows = useMemo(
    () => pickerRows(listed, owned, query, family, onlyNew),
    // The filter reads the reading table, so a listing that lands before the dictionary does must be rebuilt.
    [listed, owned, query, family, onlyNew, pinyinVersion],
  )
  const families = useMemo(() => vendorFamilies(listed), [listed])
  const providerHint = provider ?? (draft ? { icon: '', label: draft.label, baseUrl: draft.baseUrl } : null)
  const adds = picked.filter((id) => !held.includes(id)).length
  const removes = held.filter((id) => !picked.includes(id)).length
  // Ticking past the cap is refused where the reader does it, rather than dropped by the route afterwards.
  const full = draft ? picked.length >= MAX_PROVIDER_MODELS : false
  const toggle = (id: string) => setPicked((current) => {
    if (current.includes(id)) return current.filter((entry) => entry !== id)
    if (draft && current.length >= MAX_PROVIDER_MODELS) return current
    return [...current, id]
  })

  const refresh = () => {
    if (draft) void loadDraft({ protocol: draft.protocol, baseUrl: draft.baseUrl, apiKey: draft.apiKey })
    else if (provider) void load(provider.id)
  }

  const submit = async () => {
    if (draft) {
      onPicked?.(picked)
      onClose()
      return
    }
    if (!provider) return
    setBusy(true)
    const result = await syncVendorModels(provider.id, picked)
    setBusy(false)
    onSynced?.(result)
    if (result.added || result.removed) onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={draft ? t('assistant.picker.draft_title', { label: draft.label }) : t('assistant.picker.title', { label: provider?.label ?? '' })}
      description={draft ? draft.baseUrl : provider?.baseUrl}
      width={620}
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
            onClick={refresh}
            className="flex size-11 shrink-0 items-center justify-center rounded-[var(--r-md)] border border-[var(--border-default)] text-[var(--text-tertiary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:size-[34px]"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
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
          <p className="rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-sunken)] px-2.5 py-2 text-[length:var(--text-11-5)] leading-snug text-[var(--warning)]">
            {t('assistant.picker.failed')}
            <span className="mt-0.5 block break-words text-[var(--text-tertiary)]">{error}</span>
          </p>
        )}
        {!loading && !error && rows.length === 0 && (
          <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('assistant.picker.none')}</p>
        )}

        <ul className="max-h-[46vh] min-h-[140px] overflow-y-auto rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-1">
          {rows.map(({ model, added }) => {
            const pickedHere = picked.includes(model.id)
            return (
              <li key={model.id} className="mb-px last:mb-0">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={pickedHere}
                  onClick={() => toggle(model.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-[var(--r-sm)] px-2.5 py-2 text-left',
                    'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                    pickedHere ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-[var(--dur-fast)]',
                      pickedHere
                        ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]'
                        : 'border-[var(--border-strong)]',
                    )}
                  >
                    {pickedHere && <Check size={12} strokeWidth={3} />}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <AssistantIcon value={iconForModel({ icon: '', model: model.id, label: model.label }, providerHint)} size={18} />
                      <span className={cn('truncate text-[length:var(--text-12-5)]', pickedHere ? 'font-medium text-[var(--accent-on-soft)]' : 'text-[var(--text-primary)]')}>{model.label}</span>
                    </span>
                    <span className="truncate font-mono text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{model.id}</span>
                  </span>
                  {added && (
                    <span className="shrink-0 rounded-full border border-[var(--border-subtle)] px-1.5 py-px text-[length:var(--text-10)] text-[var(--text-quaternary)]">{t('assistant.picker.already')}</span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>

        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {onCustom && <Button variant="ghost" size="sm" onClick={onCustom}>{t('assistant.picker.custom')}</Button>}
          {full && (
            <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
              {t('assistant.picker.cap', { count: MAX_PROVIDER_MODELS })}
            </span>
          )}
          {!draft && (adds > 0 || removes > 0) && (
            // What the footer is about to do, said in the two numbers the save reports: a saved provider's
            // checklist changes in both directions, and "add 2" alone would hide the row it is deleting.
            <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
              {adds > 0 && t('assistant.picker.add', { count: adds })}
              {adds > 0 && removes > 0 && ' · '}
              {removes > 0 && t('assistant.picker.remove', { count: removes })}
            </span>
          )}
          <div className="flex-1" />
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={(!draft && adds + removes === 0) || (draft && !picked.length) || busy} onClick={() => void submit()}>
            {draft
              ? t('assistant.picker.use', { count: picked.length })
              : t('assistant.picker.apply')}
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
        'rounded-full border px-2.5 py-0.5 text-[length:var(--text-11-5)]',
        'transition-[background-color,border-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        active
          ? 'border-[var(--accent)] bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]'
          : 'border-[var(--border-default)] text-[var(--text-tertiary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]',
      )}
    >
      {children}
    </button>
  )
}
