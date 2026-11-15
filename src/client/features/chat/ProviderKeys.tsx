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
import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2, ChevronDown, Copy, Eye, EyeOff, KeyRound, Pencil, Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import type { AssistantKeyProbe, AssistantKeyRotation, AssistantProvider, AssistantProviderKey } from '@shared/assistant'
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
import { useAssistant } from './assistant-store'

/** How long a revealed key stays on screen before it hides itself. */
const REVEAL_MS = 15_000

/**
 * Where one key sits in the order a turn walks the ring.
 *
 * The first place is marked rather than numbered: "1" reads as a rank a key earned, and this is a turn
 * order that changes every time one of them answers. The rest keep their number, which is what a reader
 * checks after a key starts resting.
 */
function TurnOrder({ entry }: { entry: AssistantKeyRotation | undefined }) {
  if (!entry) return null
  if (entry.position === 1) {
    return (
      <Tooltip label={t('assistant.keys.next_mark')} side="top">
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--success)_14%,transparent)] px-1.5 text-[length:var(--text-10-5)] text-[var(--success)]">
          <span className="size-1 rounded-full bg-[var(--success)]" aria-hidden />
          {t('assistant.keys.next')}
        </span>
      </Tooltip>
    )
  }
  if (entry.modelBlocked) {
    return (
      <Tooltip label={t('assistant.keys.blocked_model')} side="top">
        <span className="shrink-0 tabular text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">#{entry.position}</span>
      </Tooltip>
    )
  }
  return <span className="shrink-0 tabular text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">#{entry.position}</span>
}

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
          'flex shrink-0 items-center gap-1 tabular text-[length:var(--text-10-5)]',
          probe.outcome === 'passed'
            ? 'text-[var(--text-secondary)]'
            : probe.outcome === 'failed'
              ? 'rounded-full bg-[color-mix(in_oklab,var(--danger)_14%,transparent)] px-1.5 font-medium text-[var(--danger)]'
              : 'text-[var(--text-quaternary)]',
        )}
      >
        {probe.outcome === 'failed' && <AlertTriangle size={10} aria-hidden />}
        {probe.outcome === 'passed' && <CheckCircle2 size={10} className="text-[var(--success)]" aria-hidden />}
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

export function ProviderKeys({ provider, wallet, onProbes }: {
  provider: AssistantProvider, wallet: ProviderWallet, onProbes?: (probes: AssistantKeyProbe[]) => void,
}) {
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
  /** The one key whose plaintext is on screen, and which row it belongs to. Cleared on a timer. */
  const [revealed, setRevealed] = useState<{ keyId: string, key: string } | null>(null)
  const [revealing, setRevealing] = useState<string | null>(null)
  /** The ring in walking order: who signs the next turn, and who is resting behind whom. */
  const [rotation, setRotation] = useState<AssistantKeyRotation[]>([])
  /** The reader's standing choice to keep secrets on screen; see the setting that turns it on. */
  const revealAlways = useAssistant((state) => state.settings?.revealKeysAlways ?? false)
  /** Plaintext for every key, held only while that choice is on and the panel is open. */
  const [alwaysShown, setAlwaysShown] = useState<Record<string, string>>({})
  /** Which slice the stats/logs panel is open on: a key, or the provider as a whole. */
  const [insights, setInsights] = useState<{ keyId?: string, keyLabel?: string, keyHint?: string } | null>(null)

  /** Switching providers must not let the previous ring's answer land in the new panel. */
  const loadId = useRef(0)

  const load = useCallback(async () => {
    const id = ++loadId.current
    try {
      const [answer, order] = await Promise.all([
        api.assistant.providerKeys(provider.id),
        // The order is an annotation: a panel that could not read it still has keys to show. The wrapper
        // catches a missing method as well as a rejected call, which is what a test double looks like.
        Promise.resolve()
          .then(() => api.assistant.keyRotation(provider.id))
          .catch(() => ({ order: [] as AssistantKeyRotation[] })),
      ])
      if (id !== loadId.current) return
      setKeys(answer.keys)
      setProbes(answer.probes)
      onProbes?.(answer.probes)
      setPrimaryLastUsedAt(answer.primaryLastUsedAt)
      setRotation(order.order)
    } catch (error) {
      if (id !== loadId.current) return
      toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' })
      setKeys([])
    }
  }, [provider.id, toast, onProbes])

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
      onProbes?.(answer.results)
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setProbing(false)
    }
  }

  const probeOf = (keyId: string): AssistantKeyProbe | undefined => probes.find((entry) => entry.keyId === keyId)

  const invalidKeys = probes
    .filter((entry) => entry.outcome === 'failed' && entry.reason === 'invalid_credential' && entry.keyId)
    .map((entry) => entry.keyId)
    .filter((keyId) => keys?.some((key) => key.id === keyId && key.enabled))

  /** The plaintext this row may show: the standing choice first, then a one-off reveal. */
  const plainOf = (keyId: string): string | null =>
    alwaysShown[keyId] ?? (revealed?.keyId === keyId ? revealed.key : null)

  /** Where this key sits in the order a turn would walk, or nothing when the ring has not been read. */
  const rotationOf = (keyId: string): AssistantKeyRotation | undefined =>
    rotation.find((entry) => entry.keyId === keyId)

  /**
   * Asks the worker for one plaintext key.
   *
   * The worker writes an activity line before it answers, so this is a thing the reader did rather than a
   * thing that happened. The plaintext lives in this component for {REVEAL_MS} and then goes away on its
   * own — a key left on screen is a key in the next screenshot.
   */
  const revealKey = async (keyId: string): Promise<string | null> => {
    setRevealing(keyId)
    try {
      const answer = keyId
        ? await api.assistant.revealExtraKey(provider.id, keyId)
        : await api.assistant.revealProviderKey(provider.id)
      return answer.key
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' })
      return null
    } finally {
      setRevealing(null)
    }
  }

  const toggleReveal = async (keyId: string) => {
    if (revealed?.keyId === keyId) {
      setRevealed(null)
      return
    }
    const key = await revealKey(keyId)
    if (key) setRevealed({ keyId, key })
  }

  const copyKey = async (keyId: string) => {
    const key = plainOf(keyId) ?? await revealKey(keyId)
    if (!key) return
    let copied = false
    try {
      await navigator.clipboard.writeText(key)
      copied = true
    } catch (error) {
      console.warn('clipboard write refused', error)
    }
    if (copied) {
      toast({ title: t('assistant.keys.copied'), tone: 'default' })
      return
    }
    // A browser that refuses the clipboard still gets the plaintext on screen, which is the fallback.
    setRevealed({ keyId, key })
    toast({ title: t('assistant.keys.copy_failed'), tone: 'warning' })
  }

  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  useEffect(() => {
    if (!revealed) return
    const timer = setTimeout(() => setRevealed(null), REVEAL_MS)
    return () => clearTimeout(timer)
  }, [revealed])

  // The standing choice reads the whole ring once per open. Each read is an audited reveal, which is the
  // price of the choice: a screen full of plaintext is a screen whose readings are countable.
  useEffect(() => {
    if (!open || !revealAlways) {
      setAlwaysShown({})
      return
    }
    let cancelled = false
    void (async () => {
      const next: Record<string, string> = {}
      const ids = [''].concat((keys ?? []).filter((entry) => entry.hasKey).map((entry) => entry.id))
      for (const keyId of ids) {
        try {
          const answer = keyId
            ? await api.assistant.revealExtraKey(provider.id, keyId)
            : await api.assistant.revealProviderKey(provider.id)
          next[keyId] = answer.key
        } catch {
          // One unreadable key must not stop the rest of the ring from being shown.
        }
        if (cancelled) return
      }
      if (!cancelled) setAlwaysShown(next)
    })()
    return () => { cancelled = true }
  }, [open, revealAlways, keys, provider.id])

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

  const disableInvalid = async () => {
    const agreed = await confirm({
      title: t('assistant.keys.disable_invalid_title', { count: invalidKeys.length }),
      description: t('assistant.keys.disable_invalid_body'),
      confirmLabel: t('assistant.keys.disable_invalid', { count: invalidKeys.length }),
      tone: 'danger',
    })
    if (!agreed) return
    await run(async () => {
      // Every attempt is settled before run() reloads the ring, so a partial failure still shows what
      // was actually stored rather than the state the panel had before the button was pressed.
      const settled = await Promise.allSettled(
        invalidKeys.map((keyId) => api.assistant.updateProviderKey(provider.id, keyId, { enabled: false })),
      )
      const missed = settled.filter((entry) => entry.status === 'rejected').length
      if (missed > 0) toast({ title: t('assistant.keys.disable_partial', { count: missed }), tone: 'danger' })
    })
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
            'text-[length:var(--text-12)] text-[var(--text-tertiary)]',
            'transition-colors duration-[var(--dur-fast)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]',
          )}
        >
          <KeyRound size={12} className="shrink-0" />
          {t('assistant.keys.title')}
          {ringSize > 0 && (
            <span
              role="img"
              aria-label={t('assistant.keys.count', { count: ringSize })}
              title={t('assistant.keys.count', { count: ringSize })}
              className="rounded-full bg-[var(--accent-soft)] px-1.5 text-[length:var(--text-10-5)] tabular text-[var(--accent-on-soft)]"
            >
              {ringSize}
            </span>
          )}
          <ChevronDown size={12} className={cn('ml-auto transition-transform duration-[var(--dur-fast)]', open && 'rotate-180')} />
        </button>
        {/* Offered only once there is something to ask about: a probe of an empty ring is a request that
            can only answer "there is nothing here". */}
        {/* Who a turn would sign with, before the reader has to open anything: the one fact that makes
            "three keys" mean something at a glance. */}
        {open && rotation.length > 1 && rotation[0] && (
          <Tooltip
            label={rotation[0].label || t('assistant.keys.primary')}
            side="top"
          >
            <span className="flex shrink-0 items-center gap-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              <span className="size-1.5 rounded-full bg-[var(--success)]" aria-hidden />
              {t('assistant.keys.next_up', { hint: rotation[0].keyHint || t('assistant.keys.primary') })}
            </span>
          </Tooltip>
        )}
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
        {open && invalidKeys.length > 0 && (
          <Button size="sm" variant="ghost" disabled={probing || busy} onClick={() => void disableInvalid()}>
            {t('assistant.keys.disable_invalid', { count: invalidKeys.length })}
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-1 flex flex-col gap-1.5 pb-1">
          <p className="text-[length:var(--text-10-5)] leading-snug text-[var(--text-quaternary)]">{t('assistant.keys.hint')}</p>

          {/* The provider's own key heads the ring, and is listed here so the count above means something:
              a reader who adds one key should see two, not wonder which one the ring is using. */}
          <div
            className={cn(
              'flex items-center gap-2 rounded-[var(--r-md)] border-l-[3px] border-y border-r px-2 py-1.5 text-[length:var(--text-12)]',
              probeOf('')?.outcome === 'failed'
                ? 'border-l-[var(--danger)] border-y-[color-mix(in_oklab,var(--danger)_30%,transparent)] border-r-[color-mix(in_oklab,var(--danger)_30%,transparent)] bg-[color-mix(in_oklab,var(--danger)_7%,transparent)]'
                : 'border-l-[var(--border-subtle)] border-y-[var(--border-subtle)] border-r-[var(--border-subtle)]',
            )}
          >
            <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{t('assistant.keys.primary')}</span>
            {/* The same words the provider row and the edit form use, so one stored key reads the same
                way everywhere: its last four characters, never the plaintext. */}
            <span className="shrink-0 font-mono text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              {plainOf('') ? (
                <span className="select-all text-[var(--accent)]">{plainOf('')}</span>
              ) : (
                <>
                  {storedKeyLabel(provider)}
                  {" · "}
                  {lastUsed(primaryLastUsedAt)}
                </>
              )}
            </span>
            {provider.hasKey && (
              <IconButton
                label={plainOf('') ? t('assistant.keys.hide') : t('assistant.keys.reveal')}
                size="xs"
                disabled={revealing === ''}
                onClick={() => void toggleReveal('')}
              >
                {plainOf('') ? <EyeOff size={12} /> : <Eye size={12} />}
              </IconButton>
            )}
            {provider.hasKey && (
              <IconButton label={t('assistant.keys.copy')} size="xs" disabled={revealing === ''} onClick={() => void copyKey('')}>
                <Copy size={12} />
              </IconButton>
            )}
            <TurnOrder entry={rotationOf('')} />
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
                  className={cn(
                    'flex items-center gap-2 rounded-[var(--r-md)] border-l-[3px] border-y border-r px-2 py-1.5',
                    probeOf(key.id)?.outcome === 'failed'
                      ? 'border-l-[var(--danger)] border-y-[color-mix(in_oklab,var(--danger)_30%,transparent)] border-r-[color-mix(in_oklab,var(--danger)_30%,transparent)] bg-[color-mix(in_oklab,var(--danger)_7%,transparent)]'
                      : 'border-l-[var(--border-subtle)] border-y-[var(--border-subtle)] border-r-[var(--border-subtle)]',
                  )}
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
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <TurnOrder entry={rotationOf(key.id)} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[length:var(--text-12)] text-[var(--text-secondary)]">
                          {key.label || t('assistant.keys.unnamed')}
                        </p>
                      <p className="truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                        {plainOf(key.id) ? (
                          <span className="select-all font-mono text-[var(--accent)]">{plainOf(key.id)}</span>
                        ) : (
                          <span className="font-mono">{key.hasKey ? key.keyHint : t('assistant.settings.key_missing')}</span>
                        )}
                        {' · '}
                        {lastUsed(key.lastUsedAt)}
                        {key.errorCount > 0 && ` · ${t('assistant.keys.errors', { count: key.errorCount })}`}
                        {/* Why this key is not being used right now — a silence would read as a bug. */}
                          {key.coolingUntil !== null && key.coolingUntil > Date.now()
                            && ` · ${t('assistant.keys.cooling', { mins: Math.max(1, Math.ceil((key.coolingUntil - Date.now()) / 60_000)) })}`}
                        </p>
                      </div>
                    </div>
                  )}
                  <ProbeBadge probe={probeOf(key.id)} />
                  <BalanceChip reading={balanceOf(key.id)} name={key.label || t('assistant.keys.unnamed')} />
                  <div className="flex shrink-0 items-center gap-0.5">
                    {renaming !== key.id && key.hasKey && (
                      <IconButton
                        label={plainOf(key.id) ? t('assistant.keys.hide') : t('assistant.keys.reveal')}
                        size="xs"
                        disabled={revealing === key.id}
                        onClick={() => void toggleReveal(key.id)}
                      >
                        {plainOf(key.id) ? <EyeOff size={12} /> : <Eye size={12} />}
                      </IconButton>
                    )}
                    {renaming !== key.id && key.hasKey && (
                      <IconButton label={t('assistant.keys.copy')} size="xs" disabled={revealing === key.id} onClick={() => void copyKey(key.id)}>
                        <Copy size={12} />
                      </IconButton>
                    )}
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
                    {renaming !== key.id && (key.errorCount > 0 || (key.coolingUntil !== null && key.coolingUntil > Date.now())) && (
                      <IconButton
                        label={t('assistant.keys.reset')}
                        size="xs"
                        disabled={busy}
                        onClick={() => void run(async () => {
                          await api.assistant.resetExtraKey(provider.id, key.id)
                        })}
                      >
                        <RotateCcw size={12} />
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
                  </div>
                  <IconButton
                    className="ml-auto hover:bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] hover:text-[var(--danger)]"
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
