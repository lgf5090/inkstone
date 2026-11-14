/**
 * The keys one provider rotates through, and what each of them is owed.
 *
 * The provider's own key is the first of the ring and is edited with the provider; this is where the second
 * and third arrive, which is what turns a rate limit from a failed turn into a moment. A key is written
 * once and never read back — the row carries the last four characters the worker kept, which tells two
 * apart and is useless to anyone reading over a shoulder.
 *
 * The list is read when the section is opened rather than with the tab: most providers never carry a second
 * key, and a request per provider for a fact nobody is looking at is a request too many. The balances are
 * the exception, and are asked with the card, because the reader asked to see what each provider is worth
 * without having to open anything first — `useProviderBalances` is the one owner and the card hands the
 * readings to both the header chips and these rows.
 */
import { useCallback, useEffect, useState } from 'react'
import { Activity, ChevronDown, KeyRound, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { AssistantKeyProbe, AssistantProvider, AssistantProviderKey } from '@shared/assistant'
import type { KeyBalance, ProviderBalanceAnswer } from '@shared/provider-balance'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Input, Switch } from '../../components/form'
import { Tooltip, confirm } from '../../components/overlay'
import { cn } from '../../lib/cn'
import { useUi } from '../../store/ui'
import { storedKeyLabel } from './assistant-settings-shared'
import { KeyInsights } from './KeyInsights'

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

/**
 * What the last probe said about one key, and why.
 *
 * Three words, not two. "Cannot tell" is a real answer — a limit, an outage or a timeout says nothing
 * about the credential — and the tooltip carries the reason, because a badge has room for one word and
 * the reader's next move depends on which one it is.
 */
function ProbeBadge({ probe }: { probe: AssistantKeyProbe | undefined }) {
  if (!probe) return null
  const words = probe.outcome === 'passed'
    ? t('assistant.keys.probe_passed')
    : probe.outcome === 'failed'
      ? t('assistant.keys.probe_failed')
      : t('assistant.keys.probe_unknown')
  const reason = probe.reason ? t(`assistant.keys.probe_reason.${probe.reason}`) : ''
  // The round-trip of a passing probe is the only number here worth a reader's attention: it is how two
  // working keys are told apart when one of them is slower than the other.
  const latency = probe.outcome === 'passed' && probe.latencyMs !== null
    ? ` ${t('assistant.keys.probe_latency', { ms: probe.latencyMs })}`
    : ''
  return (
    <Tooltip label={`${words}${reason ? ` · ${reason}` : ''} · ${lastUsed(probe.probedAt)}`} side="top">
      <span
        className={cn(
          'shrink-0 tabular text-[length:var(--text-10-5)]',
          probe.outcome === 'passed'
            ? 'text-[var(--text-secondary)]'
            : probe.outcome === 'failed' ? 'text-[var(--danger)]' : 'text-[var(--text-quaternary)]',
        )}
      >
        {words}{latency}
      </span>
    </Tooltip>
  )
}

/** The name a chip has to say out loud: the row's own words, never its secret. */
function keyName(reading: KeyBalance): string {
  if (!reading.keyId) return t('assistant.keys.primary')
  return reading.label || t('assistant.keys.unnamed')
}

/**
 * What one provider's keys are worth, held by the card that owns them.
 *
 * The readings are asked with the card rather than with the panel because the reader wants the number while
 * deciding which provider to look at — but one owner still matters: the header chips and the rows below
 * show the same facts, and asking twice would put two numbers beside each other that could disagree.
 */
export interface ProviderWallet {
  balances: ProviderBalanceAnswer | null
  problem: string | null
  busy: boolean
  reload: () => Promise<void>
}

export function useProviderBalances(provider: AssistantProvider): ProviderWallet {
  const [balances, setBalances] = useState<ProviderBalanceAnswer | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    setBusy(true)
    setProblem(null)
    try {
      setBalances(await api.assistant.providerBalance(provider.id))
    } catch (error) {
      setBalances(null)
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [provider.id])

  useEffect(() => {
    void reload()
  }, [reload])

  return { balances, problem, busy, reload }
}

/**
 * What the card is worth, worn by its header.
 *
 * Only the readings that answered are shown here: a refusal needs a sentence to be honest about itself, and
 * the header has no room for one — the rows in the ring below carry those. A provider that reports nothing
 * shows nothing, which is the same silence as a wallet this vendor will not talk about, and the expanded
 * ring is where that gets said out loud.
 */
export function WalletChips({ wallet }: { wallet: ProviderWallet }) {
  const readable = (wallet.balances?.readings ?? [])
    .filter((entry): entry is KeyBalance & { ok: true } => entry.ok)
  if (readable.length === 0) return null
  return (
    <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-x-2">
      {readable.map((reading) => (
        <BalanceChip key={reading.keyId || 'own'} reading={reading} name={keyName(reading)} />
      ))}
    </div>
  )
}

export function ProviderKeys({ provider, wallet }: { provider: AssistantProvider, wallet: ProviderWallet }) {
  const toast = useUi((state) => state.toast)
  const [keys, setKeys] = useState<AssistantProviderKey[] | null>(null)
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ label: '', apiKey: '' })
  const [busy, setBusy] = useState(false)
  // Which row is being renamed, and what has been typed into it so far. The name is the only thing that
  // tells three wallets apart once the last four characters have scrolled out of the tooltip.
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renamed, setRenamed] = useState('')
  /** What the last probe concluded, per key. Empty until somebody asks. */
  const [probes, setProbes] = useState<AssistantKeyProbe[]>([])
  /** The ring's first key has no row here, so its last use arrives with this answer rather than the card. */
  const [primaryLastUsedAt, setPrimaryLastUsedAt] = useState<number | null>(provider.keyLastUsedAt)
  const [probing, setProbing] = useState(false)
  /** Which slice the stats/logs panel is open on: a key, or the provider as a whole. */
  const [insights, setInsights] = useState<{ keyId?: string, keyLabel?: string, keyHint?: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const answer = await api.assistant.providerKeys(provider.id)
      setKeys(answer.keys)
      setProbes(answer.probes)
      setPrimaryLastUsedAt(answer.primaryLastUsedAt)
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' })
      setKeys([])
    }
  }, [provider.id, toast])

  /**
   * Asks the provider about every key at once.
   *
   * Not wrapped in `run`: a probe changes nothing about the ring, so the wallet does not have to be
   * re-read — and one request per key is already the most this screen does at a time.
   */
  const probe = async () => {
    setProbing(true)
    try {
      const answer = await api.assistant.probeProviderKeys(provider.id)
      setProbes(answer.results)
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setProbing(false)
    }
  }

  const probeOf = (keyId: string): AssistantKeyProbe | undefined => probes.find((entry) => entry.keyId === keyId)

  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  /** The reading for one row of the ring, or nothing to say about it yet. */
  const balanceOf = (keyId: string): KeyBalance | undefined => wallet.balances?.readings.find((entry) => entry.keyId === keyId)

  // One writer at a time: every action here rewrites the same list, and two in flight would leave the
  // screen showing whichever answered last rather than what is stored. The wallet is re-read with it,
  // because a row that gained a name or left the ring changes what the chips beside it are saying — the
  // vendor is not asked twice, the worker holds the reading for a few minutes.
  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    try {
      await work()
      await load()
      await wallet.reload()
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

  /**
   * Names a row that already exists.
   *
   * The name is worth an edit of its own because it is what the balance chips and the tooltips say: a ring
   * of three keys that were never labelled is three rows reading "Unnamed key", and the last four
   * characters only separate them while nothing else has scrolled away.
   */
  const rename = async (keyId: string) => {
    await run(async () => {
      await api.assistant.updateProviderKey(provider.id, keyId, { label: renamed.trim() })
      setRenaming(null)
    })
  }

  const ringSize = (keys?.length ?? 0) + (provider.hasKey ? 1 : 0)

  return (
    <div className="pl-9">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--r-md)] px-1 py-1 text-left',
            'text-[length:var(--text-11-5)] text-[var(--text-tertiary)]',
            'transition-colors duration-[var(--dur-fast)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]',
          )}
        >
          <KeyRound size={12} className="shrink-0" />
          {t('assistant.keys.title')}
          {ringSize > 0 && (
            <span className="rounded-full bg-[var(--accent-soft)] px-1.5 text-[length:var(--text-10-5)] tabular text-[var(--accent-on-soft)]">
              {ringSize}
            </span>
          )}
          <ChevronDown size={12} className={cn('ml-auto transition-transform duration-[var(--dur-fast)]', open && 'rotate-180')} />
        </button>
        {/* Offered only once there is something to ask about: a probe of an empty ring is a request that
            can only answer "there is nothing here". */}
        {open && (
          <IconButton label={t('assistant.insights.open')} size="xs" onClick={() => setInsights({})}>
            <Activity size={12} />
          </IconButton>
        )}
        {open && ringSize > 0 && (
          <Button size="sm" variant="ghost" disabled={probing || busy} onClick={() => void probe()}>
            {probing ? t('assistant.keys.probe_running') : t('assistant.keys.probe')}
          </Button>
        )}
      </div>

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
              {" · "}
              {lastUsed(primaryLastUsedAt)}
            </span>
            <ProbeBadge probe={probeOf('')} />
            <Button size="sm" variant="ghost" onClick={() => setInsights({ keyId: '', keyLabel: t('assistant.keys.primary'), keyHint: provider.keyHint })}>
              {t('assistant.insights.tab_stats')}
            </Button>
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
                  {renaming === key.id ? (
                    <form
                      className="flex min-w-0 flex-1 items-center gap-1.5"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void rename(key.id)
                      }}
                    >
                      <Input
                        autoFocus
                        aria-label={t('assistant.keys.label')}
                        value={renamed}
                        maxLength={60}
                        className="min-w-0 flex-1"
                        onChange={(event) => setRenamed(event.target.value)}
                      />
                      <Button type="submit" size="sm" variant="primary" disabled={busy}>
                        {t('assistant.model.save')}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setRenaming(null)}>
                        {t('common.cancel')}
                      </Button>
                    </form>
                  ) : (
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                        {key.label || t('assistant.keys.unnamed')}
                      </p>
                      <p className="truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                        <span className="font-mono">{key.hasKey ? key.keyHint : t('assistant.settings.key_missing')}</span>
                        {' · '}
                        {lastUsed(key.lastUsedAt)}
                        {key.errorCount > 0 && ` · ${t('assistant.keys.errors', { count: key.errorCount })}`}
                        {/* Why this key is not being used right now — a silence would read as a bug. */}
                        {key.coolingUntil !== null && key.coolingUntil > Date.now()
                          && ` · ${t('assistant.keys.cooling', { mins: Math.max(1, Math.ceil((key.coolingUntil - Date.now()) / 60_000)) })}`}
                      </p>
                    </div>
                  )}
                  <ProbeBadge probe={probeOf(key.id)} />
                  <BalanceChip reading={balanceOf(key.id)} name={key.label || t('assistant.keys.unnamed')} />
                  {renaming !== key.id && (
                    <IconButton
                      label={t('assistant.insights.open')}
                      size="xs"
                      onClick={() => setInsights({ keyId: key.id, keyLabel: key.label, keyHint: key.keyHint })}
                    >
                      <Activity size={12} />
                    </IconButton>
                  )}
                  {renaming !== key.id && (
                    <IconButton
                      label={t('assistant.keys.rename', { label: key.label || t('assistant.keys.unnamed') })}
                      size="xs"
                      onClick={() => {
                        setRenaming(key.id)
                        setRenamed(key.label)
                      }}
                    >
                      <Pencil size={12} />
                    </IconButton>
                  )}
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
          {wallet.problem !== null && (
            <p role="status" className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{wallet.problem}</p>
          )}
          {wallet.problem === null && wallet.balances === null && (
            <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('assistant.balance.reading')}</p>
          )}
          {wallet.balances !== null && !wallet.balances.supported && (
            <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('assistant.balance.unsupported_provider')}</p>
          )}
          {wallet.balances?.supported === true && (
            <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} disabled={wallet.busy} onClick={() => void wallet.reload()}>
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

      {/* One panel, two tabs, three scopes. It lives here rather than inside a row so the numbers a key
          carries can be read next to the provider's — the comparison is the point. */}
      <KeyInsights
        open={insights !== null}
        onClose={() => setInsights(null)}
        provider={provider}
        {...(insights?.keyId !== undefined ? { keyId: insights.keyId } : {})}
        {...(insights?.keyLabel !== undefined ? { keyLabel: insights.keyLabel } : {})}
        {...(insights?.keyHint !== undefined ? { keyHint: insights.keyHint } : {})}
      />
    </div>
  )
}
