/**
 * The keys one provider rotates through.
 *
 * The provider's own key is the first of the ring and is edited with the provider; this is where the second
 * and third arrive, which is what turns a rate limit from a failed turn into a moment. A key is written
 * once and never read back — the row carries the last four characters the worker kept, which tells two
 * apart and is useless to anyone reading over a shoulder.
 *
 * The list is read when the section is opened rather than with the tab: most providers never carry a second
 * key, and a request per provider for a fact nobody is looking at is a request too many.
 */
import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { AssistantProvider, AssistantProviderKey } from '@shared/assistant'
import type { KeyBalance, ProviderBalanceAnswer } from '@shared/provider-balance'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Input, Switch } from '../../components/form'
import { Tooltip, confirm } from '../../components/overlay'
import { cn } from '../../lib/cn'
import { useUi } from '../../store/ui'
import { storedKeyLabel } from './assistant-settings-shared'

/** When a key last answered, in the reader's own words rather than as a timestamp. */
function lastUsed(at: number | null): string {
  if (!at) return t('assistant.keys.never_used')
  return new Date(at).toLocaleString()
}

/**
 * What a balance is worth saying, in one of five sentences.
 *
 * Written out rather than assembled from the reason, because a key built at runtime is a key nobody can
 * find with a search and the translation gate cannot see either.
 */
function balanceWords(reading: KeyBalance): string {
  if (reading.ok) {
    return t('assistant.balance.amount', {
      amount: reading.amount.toLocaleString(undefined, { maximumFractionDigits: 3 }),
      currency: reading.currency,
    })
  }
  switch (reading.reason) {
    case 'unauthorized': return t('assistant.balance.unauthorized')
    case 'unreachable': return t('assistant.balance.unreachable')
    case 'unsupported': return t('assistant.balance.unsupported')
    case 'unreadable': return t('assistant.balance.unreadable')
  }
}

/**
 * One key's wallet, worn by the row that owns it.
 *
 * The number is short and the question behind it is not: with three keys on a provider, the only way a reader
 * can tell whose balance they are looking at is the row it sits in, so the tooltip names that row out loud —
 * the label they gave it and the last four characters. A failed reading is shown in the same place rather
 * than hidden, because "this vendor refused this key" is worth knowing about that key.
 */
function BalanceChip({ reading, name }: { reading: KeyBalance | undefined, name: string }) {
  if (!reading) return null
  return (
    <Tooltip label={t('assistant.balance.tip', { key: name, hint: reading.keyHint })} side="top">
      <span
        className={cn(
          'shrink-0 tabular text-[length:var(--text-10-5)]',
          reading.ok ? 'text-[var(--text-secondary)]' : 'text-[var(--text-quaternary)]',
        )}
      >
        {balanceWords(reading)}
      </span>
    </Tooltip>
  )
}

export function ProviderKeys({ provider }: { provider: AssistantProvider }) {
  const toast = useUi((state) => state.toast)
  const [keys, setKeys] = useState<AssistantProviderKey[] | null>(null)
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ label: '', apiKey: '' })
  const [busy, setBusy] = useState(false)
  // What each key is owed. Asked when the ring is opened rather than with the tab, for the same reason the
  // keys are: most readers never look here, and a vendor call for a number nobody is reading is a call too
  // many. A reading is never stored — it is a fact about the moment it was asked.
  const [balances, setBalances] = useState<ProviderBalanceAnswer | null>(null)
  const [balanceProblem, setBalanceProblem] = useState<string | null>(null)
  const [balanceBusy, setBalanceBusy] = useState(false)

  const loadBalances = useCallback(async () => {
    setBalanceBusy(true)
    setBalanceProblem(null)
    try {
      setBalances(await api.assistant.providerBalance(provider.id))
    } catch (error) {
      setBalances(null)
      setBalanceProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBalanceBusy(false)
    }
  }, [provider.id])

  const load = useCallback(async () => {
    try {
      setKeys((await api.assistant.providerKeys(provider.id)).keys)
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' })
      setKeys([])
    }
  }, [provider.id, toast])

  useEffect(() => {
    if (!open) return
    void load()
    void loadBalances()
  }, [open, load, loadBalances])

  /** The reading for one row of the ring, or nothing to say about it yet. */
  const balanceOf = (keyId: string): KeyBalance | undefined => balances?.readings.find((entry) => entry.keyId === keyId)

  // One writer at a time: every action here rewrites the same list, and two in flight would leave the
  // screen showing whichever answered last rather than what is stored.
  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    try {
      await work()
      await load()
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const add = async () => {
    const apiKey = draft.apiKey.trim()
    if (!apiKey) return
    await run(async () => {
      await api.assistant.createProviderKey(provider.id, { label: draft.label.trim(), apiKey })
      setDraft({ label: '', apiKey: '' })
      setAdding(false)
    })
  }

  return (
    <div className="pl-9">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-[var(--r-md)] px-1 py-1 text-left',
          'text-[length:var(--text-11-5)] text-[var(--text-tertiary)]',
          'transition-colors duration-[var(--dur-fast)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]',
        )}
      >
        <KeyRound size={12} className="shrink-0" />
        {t('assistant.keys.title')}
        {keys && keys.length > 0 && (
          <span className="rounded-full bg-[var(--accent-soft)] px-1.5 text-[length:var(--text-10-5)] tabular text-[var(--accent-on-soft)]">
            {keys.length + (provider.hasKey ? 1 : 0)}
          </span>
        )}
        <ChevronDown size={12} className={cn('ml-auto transition-transform duration-[var(--dur-fast)]', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="mt-1 flex flex-col gap-1.5 pb-1">
          <p className="text-[length:var(--text-11)] leading-snug text-[var(--text-quaternary)]">{t('assistant.keys.hint')}</p>

          {/* The provider's own key heads the ring, and is listed here so the count above means something:
              a reader who adds one key should see two, not wonder which one the ring is using. */}
          <div className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2 py-1.5 text-[length:var(--text-11-5)]">
            <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{t('assistant.keys.primary')}</span>
            {/* The same words the provider row and the edit form use, so one stored key reads the same
                way everywhere: its last four characters, never the plaintext. */}
            <span className="shrink-0 font-mono text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              {storedKeyLabel(provider)}
            </span>
            <BalanceChip reading={balanceOf('')} name={t('assistant.keys.primary')} />
          </div>

          {keys === null ? (
            <div className="flex justify-center py-2"><Spinner /></div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {keys.map((key) => (
                <li
                  key={key.id}
                  className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                      {key.label || t('assistant.keys.unnamed')}
                    </p>
                    <p className="truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                      <span className="font-mono">{key.hasKey ? key.keyHint : t('assistant.settings.key_missing')}</span>
                      {' · '}
                      {lastUsed(key.lastUsedAt)}
                      {key.errorCount > 0 && ` · ${t('assistant.keys.errors', { count: key.errorCount })}`}
                    </p>
                  </div>
                  <BalanceChip reading={balanceOf(key.id)} name={key.label || t('assistant.keys.unnamed')} />
                  <Switch
                    checked={key.enabled}
                    disabled={busy}
                    label={t('assistant.keys.enabled', { label: key.label || t('assistant.keys.unnamed') })}
                    onChange={(checked) => void run(async () => {
                      await api.assistant.updateProviderKey(provider.id, key.id, { enabled: checked })
                    })}
                  />
                  <IconButton
                    label={t('assistant.keys.remove', { label: key.label || t('assistant.keys.unnamed') })}
                    size="xs"
                    onClick={() => {
                      void confirm({
                        title: t('assistant.keys.remove', { label: key.label || t('assistant.keys.unnamed') }),
                        description: t('assistant.keys.remove_hint'),
                        confirmLabel: t('common.delete'),
                        tone: 'danger',
                      }).then((yes) => {
                        if (yes) void run(async () => {
                          await api.assistant.deleteProviderKey(provider.id, key.id)
                        })
                      })
                    }}
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}

          {/* One line for the whole ring: whether it can be asked at all, and the means to ask again. A
              provider that reports nothing is said so, rather than leaving the numbers off with no reason —
              silence here reads as "zero left", which is the opposite of the truth. */}
          {balanceProblem !== null && (
            <p role="status" className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{balanceProblem}</p>
          )}
          {balanceProblem === null && balances === null && (
            <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('assistant.balance.reading')}</p>
          )}
          {balances !== null && !balances.supported && (
            <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('assistant.balance.unsupported_provider')}</p>
          )}
          {balances?.supported === true && (
            <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} disabled={balanceBusy} onClick={() => void loadBalances()}>
              {t('assistant.balance.refresh')}
            </Button>
          )}

          {adding ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <Input
                aria-label={t('assistant.keys.label')}
                value={draft.label}
                placeholder={t('assistant.keys.label')}
                maxLength={60}
                className="min-w-0 flex-1"
                onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
              />
              <Input
                aria-label={t('assistant.keys.secret')}
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                placeholder={t('assistant.keys.secret')}
                className="min-w-0 flex-1"
                onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))}
              />
              <Button size="sm" variant="primary" disabled={busy || !draft.apiKey.trim()} onClick={() => void add()}>
                {t('assistant.model.save')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => { setAdding(false); setDraft({ label: '', apiKey: '' }) }}>
                {t('common.cancel')}
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="secondary" icon={<Plus size={13} />} disabled={busy} onClick={() => setAdding(true)}>
              {t('assistant.keys.add')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
