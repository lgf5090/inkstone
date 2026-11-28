/**
 * Settings, in two halves: how this app behaves, and where its reminders may go.
 *
 * The channel half is drawn from the shared field table rather than from nine hand-written forms, so a
 * field added to an adapter appears here without this file knowing what a bot token is. What it does own
 * is the shape of the interaction: a secret that is already stored is never shown, and leaving the box
 * empty keeps it — the only arrangement that lets a reader change a webhook address without retyping a
 * token they cannot see.
 */
import { useMemo, useState, type ReactElement } from 'react'
import { ChevronDown, Copy, ExternalLink, Send, Trash2 } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Button, IconButton, SectionLabel } from '../../components/primitives'
import { Field, Input, Segmented, Select, Switch, Textarea, CommitNumberInput } from '../../components/form'
import { CHANNEL_DEFINITIONS, channelLabelKey, INBOUND_HOOK_PATH, type ChannelDefinition, type ChannelField } from '@shared/subscriptions/channels'
import { copyText } from '../../lib/clipboard'
import { useUi } from '../../store/ui'
import { FALLBACK_RATES } from '@shared/subscriptions/currency'
import { CURRENCY_CODES, PAYMENT_LIMIT_MAX, PAYMENT_LIMIT_MIN, type ChannelKind, type ChannelState, type NotifyLocale, type SubscriptionSettings } from '@shared/subscriptions/model'
import { CurrencySelect } from './currency-flag'
import { formatLocalDate } from '@shared/subscriptions/time'

/**
 * Which currencies get a box.
 *
 * Not every currency the app can be told in: thirty boxes is a wall, and a reader pins a rate because a
 * number on their own dashboard is wrong, so the currencies they are actually billed in are the ones that
 * belong here — plus anything they have already pinned, plus the currency the totals are added up in, in
 * case that one is the number nobody can find. Anything else is one choice away in the add list.
 */
function pinnableCurrencies(rates: Record<string, string>, currencies: readonly string[], base: string): string[] {
  const codes = new Set<string>([...Object.keys(rates), ...currencies, base])
  return [...codes].filter((code) => code !== 'CNY').sort()
}

const TIMEZONES = [
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Australia/Sydney', 'Australia/Melbourne', 'Pacific/Auckland', 'UTC',
]

export function SubscriptionSettings({
  settings,
  channels,
  currencies,
  categories,
  onClose,
  onSaveSettings,
  onSaveChannel,
  onClearChannel,
  onTestChannel,
  onRotateToken,
  onRotateCalendarToken,
  onDiagnostics,
}: {
  settings: SubscriptionSettings
  channels: readonly ChannelState[]
  currencies: readonly string[]
  categories: readonly string[]
  onClose: () => void
  onSaveSettings: (patch: Record<string, unknown>) => Promise<boolean>
  onSaveChannel: (kind: ChannelKind, input: { enabled?: boolean; config: Record<string, unknown> }) => Promise<boolean>
  onClearChannel: (kind: ChannelKind) => Promise<boolean>
  onTestChannel: (kind: ChannelKind) => Promise<void>
  onRotateToken: () => Promise<{ token: string; hint: string } | null>
  onRotateCalendarToken: () => Promise<{ token: string; hint: string } | null>
  onDiagnostics: () => void
}): ReactElement {
  const [tab, setTab] = useState<'general' | 'channels'>('general')
  const [hours, setHours] = useState(settings.notificationHours.join(', '))
  // The boxes hold text, not numbers: a reader mid-way through typing `7.` has not asked for a rate of
  // seven, and a box they cleared has asked for the feed back.
  const [rates, setRates] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(settings.rateOverrides).map(([code, value]) => [code, String(value)])))
  const [budgets, setBudgets] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(settings.budgetCategories).map(([name, value]) => [name, String(value)])))
  const [token, setToken] = useState<string | null>(null)
  const [calendarToken, setCalendarToken] = useState<string | null>(null)
  // Built once: the address the copy button puts on the clipboard and the line that shows it to the reader
  // must not be two strings that can drift.
  const inboundAddress = token ? `${location.origin}${INBOUND_HOOK_PATH}/${token}` : ''
  const calendarAddress = calendarToken ? `${location.origin}${INBOUND_HOOK_PATH}/calendar/${calendarToken}` : ''

  /**
   * Send the pins as one map, because the boxes above are the whole map.
   *
   * A number field reports an empty string while it holds nonsense, so the only state a box can leave
   * behind is the one the reader can see: empty means the feed again for that currency, and a number means
   * that number.
   */
  const saveRates = async (next: Record<string, string>): Promise<void> => {
    const patch: Record<string, number> = {}
    for (const [code, text] of Object.entries(next)) {
      const trimmed = text.trim()
      if (!trimmed) continue
      const numeric = Number(trimmed)
      if (Number.isFinite(numeric) && numeric > 0) patch[code] = numeric
    }
    await onSaveSettings({ rateOverrides: patch })
  }

  /**
   * Send the ceilings as one map, for the same reason the pins are sent that way: the boxes are the map.
   *
   * A blank box is a ceiling the reader gave up on, which has to be absent from what goes out rather than
   * sent as zero — zero would come back as a ceiling nobody can spend under.
   */
  const saveBudgets = async (next: Record<string, string>): Promise<void> => {
    const ceilings: Record<string, number> = {}
    for (const [name, text] of Object.entries(next)) {
      const trimmed = text.trim()
      if (!trimmed) continue
      const numeric = Number(trimmed)
      if (Number.isFinite(numeric) && numeric > 0) ceilings[name] = numeric
    }
    await onSaveSettings({ budgetCategories: ceilings })
  }

  const saveGeneral = async (patch: Record<string, unknown>): Promise<void> => {
    await onSaveSettings(patch)
  }

  return (
    <div className="space-y-3">
      <Segmented
        value={tab}
        onChange={setTab}
        size="sm"
        options={[
          { value: 'general', label: t('subscriptions.settings.general') },
          { value: 'channels', label: t('subscriptions.settings.channels') },
        ]}
      />

      {tab === 'general' && (
        <div className="space-y-3">
          <div className="grid gap-2.5 sm:grid-cols-2">
            <Field label={t('subscriptions.settings.timezone')} hint={t('subscriptions.settings.timezone_hint')}>
              <Select value={settings.timezone} onChange={(event) => void saveGeneral({ timezone: event.target.value })}>
                {[...new Set([settings.timezone, ...TIMEZONES])].map((zone) => <option key={zone} value={zone}>{zone}</option>)}
              </Select>
            </Field>
            <Field label={t('subscriptions.settings.hours')} hint={t('subscriptions.settings.hours_hint')}>
              <Input
                value={hours}
                placeholder={t('subscriptions.settings.hours_placeholder')}
                onChange={(event) => setHours(event.target.value)}
                onBlur={() => void saveGeneral({ notificationHours: hours })}
              />
            </Field>
            <Field label={t('subscriptions.settings.digest')} hint={t('subscriptions.settings.digest_hint')}>
              <Select value={settings.digest} onChange={(event) => void saveGeneral({ digest: event.target.value })}>
                <option value="off">{t('subscriptions.settings.digest_off')}</option>
                <option value="daily">{t('subscriptions.settings.digest_daily')}</option>
                <option value="weekly">{t('subscriptions.settings.digest_weekly')}</option>
              </Select>
            </Field>
            <Field label={t('subscriptions.settings.digest_hour')}>
              <CommitNumberInput
                min={0}
                max={23}
                inputMode="numeric"
                value={settings.digestHour}
                onCommit={(value) => { if (value !== null) void saveGeneral({ digestHour: value }) }}
              />
            </Field>
            <Field label={t('subscriptions.settings.history_limit')}>
              <CommitNumberInput
                min={PAYMENT_LIMIT_MIN}
                max={PAYMENT_LIMIT_MAX}
                inputMode="numeric"
                value={settings.paymentHistoryLimit}
                onCommit={(value) => { if (value !== null) void saveGeneral({ paymentHistoryLimit: value }) }}
              />
            </Field>
            <Field label={t('subscriptions.settings.language')}>
              <Select value={settings.locale} onChange={(event) => void saveGeneral({ locale: event.target.value as NotifyLocale })}>
                <option value="zh-CN">{t('subscriptions.settings.language_zh')}</option>
                <option value="en-US">{t('subscriptions.settings.language_en')}</option>
              </Select>
            </Field>
            <Field label={t('subscriptions.settings.base_currency')} hint={t('subscriptions.settings.base_currency_hint')}>
              <CurrencySelect value={settings.baseCurrency} onChange={(code) => { void saveGeneral({ baseCurrency: code }) }} />
            </Field>
            {/* A ceiling the reader sets, not one the app infers: the dashboard already says what was
                spent, and the number only means anything against a limit they chose themselves. */}
            <Field label={t('subscriptions.settings.budget')} hint={t('subscriptions.settings.budget_hint')}>
              <CommitNumberInput
                min={0}
                step={1}
                allowEmpty
                value={settings.budgetMonthly}
                placeholder={t('subscriptions.settings.budget_placeholder')}
                onCommit={(value) => { void saveGeneral({ budgetMonthly: value }) }}
              />
            </Field>
            {/* The year is its own ceiling because an annual plan spends twelve months of cost in one
                month, and a reader who set only the monthly number is told they overspent on the day they
                bought the thing that makes their other months cheap. */}
            <Field label={t('subscriptions.settings.budget_yearly')} hint={t('subscriptions.settings.budget_yearly_hint')}>
              <CommitNumberInput
                min={0}
                step={1}
                allowEmpty
                value={settings.budgetYearly}
                placeholder={t('subscriptions.settings.budget_placeholder')}
                onCommit={(value) => { void saveGeneral({ budgetYearly: value }) }}
              />
            </Field>
          </div>

          {/* The feed answers once a day, for everybody. A reader billed in a currency that moves faster
              than that — or at their bank's price rather than an index — had no way to say so, and every
              total was quietly made with the number they disagree with. */}
          <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2.5 py-2">
            <SectionLabel>{t('subscriptions.settings.rates')}</SectionLabel>
            <p className="mt-1 text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
              {t('subscriptions.settings.rates_hint')}
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2" data-rate-boxes="">
              {pinnableCurrencies(rates, currencies, settings.baseCurrency).map((code) => (
                <Field
                  key={code}
                  label={t('subscriptions.settings.rate_row', { currency: code })}
                  hint={FALLBACK_RATES[code] === undefined
                    ? t('subscriptions.settings.rate_no_fallback')
                    : t('subscriptions.settings.rate_fallback', { rate: String(FALLBACK_RATES[code]) })}
                >
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    value={rates[code] ?? ''}
                    placeholder={FALLBACK_RATES[code] === undefined ? '' : String(FALLBACK_RATES[code])}
                    onChange={(event) => setRates((current) => ({ ...current, [code]: event.target.value }))}
                    onBlur={() => void saveRates(rates)}
                  />
                </Field>
              ))}
            </div>
            {CURRENCY_CODES.filter((code) => code !== 'CNY' && !(code in rates)).length > 0 && (
              <div className="mt-2 w-[140px]">
                <Field label={t('subscriptions.settings.rate_add')}>
                  <Select
                    value=""
                    onChange={(event) => {
                      const picked = event.target.value
                      if (picked) setRates((current) => ({ ...current, [picked]: '' }))
                    }}
                  >
                    <option value="">{t('subscriptions.settings.rate_add_placeholder')}</option>
                    {CURRENCY_CODES.filter((code) => code !== 'CNY' && !(code in rates)).map((code) => (
                      <option key={code} value={code}>{code}</option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
            {Object.keys(settings.rateOverrides).length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                onClick={() => { setRates({}); void saveRates({}) }}
              >
                {t('subscriptions.settings.rates_clear')}
              </Button>
            )}
          </div>

          {/* A ceiling on a category is the question about a pile rather than about one plan: the dashboard
              already splits the year by category, and this is where a reader says what each pile may cost. */}
          <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2.5 py-2">
            <SectionLabel>{t('subscriptions.settings.category_budgets')}</SectionLabel>
            <p className="mt-1 text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
              {t('subscriptions.settings.category_budgets_hint')}
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2" data-category-budget-boxes="">
              {Object.keys(budgets).map((name) => (
                <Field key={name} label={name}>
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    value={budgets[name]}
                    placeholder={t('subscriptions.settings.budget_placeholder')}
                    onChange={(event) => setBudgets((current) => ({ ...current, [name]: event.target.value }))}
                    onBlur={() => void saveBudgets(budgets)}
                  />
                </Field>
              ))}
            </div>
            {categories.filter((name) => !(name in budgets)).length > 0 && (
              <div className="mt-2 w-[160px]">
                <Field label={t('subscriptions.settings.category_budget_add')}>
                  <Select
                    value=""
                    onChange={(event) => {
                      const picked = event.target.value
                      if (picked) setBudgets((current) => ({ ...current, [picked]: '' }))
                    }}
                  >
                    <option value="">{t('subscriptions.settings.category_budget_add_placeholder')}</option>
                    {categories.filter((name) => !(name in budgets)).map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
            {Object.keys(settings.budgetCategories).length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                onClick={() => { setBudgets({}); void saveBudgets({}) }}
              >
                {t('subscriptions.settings.category_budgets_clear')}
              </Button>
            )}
            {categories.length === 0 && (
              <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                {t('subscriptions.settings.category_budgets_none')}
              </p>
            )}
          </div>

          <label className="flex items-center justify-between gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2.5 py-2">
            <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('subscriptions.settings.show_lunar')}</span>
            <Switch
              checked={settings.showLunar}
              onChange={(next) => void saveGeneral({ showLunar: next })}
              label={t('subscriptions.settings.show_lunar')}
            />
          </label>

          <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2.5 py-2">
            <SectionLabel>{t('subscriptions.settings.inbound')}</SectionLabel>
            <p className="mt-1 text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">{t('subscriptions.settings.inbound_hint')}</p>
            {settings.inboundTokenHint && (
              <p className="mt-1 font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]">••••{settings.inboundTokenHint}</p>
            )}
            <div className="mt-1.5 flex items-center gap-1.5">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void onRotateToken().then((rotated) => { if (rotated) setToken(rotated.token) })
                }}
              >
                {t('subscriptions.settings.inbound_rotate')}
              </Button>
              {token && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Copy size={13} />}
                  onClick={() => void copyText(inboundAddress).then((taken) => {
                    if (!taken) useUi.getState().toast({ title: t('subscriptions.settings.copy_failed'), tone: 'danger' })
                  })}
                >
                  {t('subscriptions.settings.inbound_copy')}
                </Button>
              )}
            </div>
            {token && (
              <p className="mt-1 break-all rounded-[var(--r-xs)] bg-[var(--bg-inset)] px-2 py-1 font-mono text-[length:var(--text-10-5)] text-[var(--warning)]">
                {t('subscriptions.settings.inbound_once', { token: inboundAddress })}
              </p>
            )}
            <div className="mt-2 border-t border-[var(--border-subtle)] pt-2">
              <p className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('subscriptions.settings.calendar')}</p>
              <p className="mt-1 text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
                {t('subscriptions.settings.calendar_hint')}
              </p>
              {settings.calendarTokenHint && (
                <p className="mt-1 font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]">••••{settings.calendarTokenHint}</p>
              )}
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    void onRotateCalendarToken().then((rotated) => { if (rotated) setCalendarToken(rotated.token) })
                  }}
                >
                  {t('subscriptions.settings.calendar_rotate')}
                </Button>
                {calendarToken && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Copy size={13} />}
                    onClick={() => void copyText(calendarAddress).then((taken) => {
                      if (!taken) useUi.getState().toast({ title: t('subscriptions.settings.copy_failed'), tone: 'danger' })
                    })}
                  >
                    {t('subscriptions.settings.calendar_copy')}
                  </Button>
                )}
              </div>
              {calendarToken && (
                <p className="mt-1 break-all rounded-[var(--r-xs)] bg-[var(--bg-inset)] px-2 py-1 font-mono text-[length:var(--text-10-5)] text-[var(--warning)]">
                  {t('subscriptions.settings.calendar_once', { token: calendarAddress })}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <Button size="sm" variant="ghost" onClick={onDiagnostics}>{t('subscriptions.settings.diagnostics')}</Button>
            <Button size="sm" variant="ghost" onClick={onClose}>{t('subscriptions.settings.close')}</Button>
          </div>
        </div>
      )}

      {tab === 'channels' && (
        <div className="space-y-1.5">
          {CHANNEL_DEFINITIONS.map((definition) => {
            const state = channels.find((channel) => channel.kind === definition.kind)
            return (
              <ChannelPanel
                key={definition.kind}
                kind={definition.kind}
                definition={definition}
                state={state}
                timezone={settings.timezone}
                onSave={onSaveChannel}
                onClear={onClearChannel}
                onTest={onTestChannel}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function ChannelPanel({
  kind,
  definition,
  state,
  timezone,
  onSave,
  onClear,
  onTest,
}: {
  kind: ChannelKind
  definition: ChannelDefinition
  state: ChannelState | undefined
  timezone: string
  onSave: (kind: ChannelKind, input: { enabled?: boolean; config: Record<string, unknown>; clearFields?: string[] }) => Promise<boolean>
  onClear: (kind: ChannelKind) => Promise<boolean>
  onTest: (kind: ChannelKind) => Promise<void>
}): ReactElement {
  const { fields } = definition
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState<Record<string, unknown>>(() => ({ ...(state?.config ?? {}) }))
  const [clearFields, setClearFields] = useState<string[]>([])
  const [enabled, setEnabled] = useState(state?.enabled ?? false)
  const [busy, setBusy] = useState(false)
  const [toggling, setToggling] = useState(false)

  const configured = state?.configured ?? false
  // A channel with fields cannot send until they are filled in; one with none is ready as soon as it is
  // switched on, so gating its switch on `configured` would ask the reader to configure nothing.
  const needsConfiguration = fields.length > 0 && !configured
  const summary = useMemo(() => {
    if (!configured) return t('subscriptions.channel.not_configured')
    // The hint says *which* server or token is stored; with nothing to name, the bare fact is the whole line.
    return state?.hint ? t('subscriptions.channel.configured', { hint: state.hint }) : t('subscriptions.channel.configured_plain')
  }, [configured, state?.hint])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const ok = await onSave(kind, { enabled, config, clearFields })
      if (ok) {
        setConfig({})
        setClearFields([])
      }
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (next: boolean): Promise<void> => {
    setToggling(true)
    setEnabled(next)
    const ok = await onSave(kind, { enabled: next, config: {}, clearFields: [] })
    if (!ok) setEnabled(!next)
    setToggling(false)
  }

  const clear = async (): Promise<void> => {
    const previous = enabled
    setToggling(true)
    setEnabled(false)
    const ok = await onClear(kind)
    if (!ok) setEnabled(previous)
    else {
      setConfig({})
      setClearFields([])
    }
    setToggling(false)
  }

  const clearField = (key: string): void => {
    setClearFields((current) => current.includes(key) ? current : [...current, key])
    setConfig((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)]">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          onClick={() => setOpen(value => !value)}
          aria-expanded={open}
          className="min-w-0 flex-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          <span className="flex items-center gap-1.5 text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
            {t(channelLabelKey(kind))}
            <ChevronDown size={13} aria-hidden="true" className={cn('shrink-0 text-[var(--text-quaternary)] transition-transform', open && 'rotate-180')} />
            {!configured && <span className="rounded-[var(--r-xs)] bg-[var(--accent-soft)] px-1.5 py-0.5 text-[length:var(--text-10)] font-medium text-[var(--accent-on-soft)]">{t('subscriptions.channel.configure')}</span>}
          </span>
          <span className={cn('mt-0.5 block truncate text-[length:var(--text-11)]', state?.lastTestStatus === 'failed' ? 'text-[var(--danger)]' : 'text-[var(--text-quaternary)]')}>
            {state?.lastTestStatus === 'failed' && state.lastTestError ? state.lastTestError : summary}
          </span>
          {state?.lastTestAt && (
            <span className="mt-0.5 block text-[length:var(--text-10)] text-[var(--text-quaternary)]">
              {t('subscriptions.channel.tested_at', { time: formatLocalDate(state.lastTestAt, timezone, 'datetime') })}
            </span>
          )}
        </button>
        <Switch
          checked={enabled}
          disabled={needsConfiguration || toggling}
          onChange={(next) => { void toggle(next) }}
          label={t('subscriptions.channel.enable')}
        />
      </div>
      {open && (
        <div className="space-y-2 border-t border-[var(--border-subtle)] px-2.5 py-2">
          {definition.helpUrl && definition.helpLabelKey && (
            <a className="inline-flex items-center gap-1 text-[length:var(--text-11)] text-[var(--accent)] underline underline-offset-2" href={definition.helpUrl} target="_blank" rel="noreferrer noopener">
              {t(definition.helpLabelKey)}
              <ExternalLink size={11} aria-hidden="true" />
            </a>
          )}
          {fields.map((field) => (
            <ChannelFieldInput
              key={field.key}
              field={field}
              value={config[field.key]}
              configured={state?.configuredFields.includes(field.key) ?? false}
              clearing={clearFields.includes(field.key)}
              onChange={(value) => setConfig(current => ({ ...current, [field.key]: value }))}
              onClear={() => clearField(field.key)}
            />
          ))}
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>{t('subscriptions.channel.save')}</Button>
            <Button size="sm" variant="secondary" icon={<Send size={13} />} disabled={!configured} onClick={() => void onTest(kind)}>
              {t('subscriptions.channel.test')}
            </Button>
            {/* Clearing forgets a credential bundle. A channel with no fields never had one, so the only
                honest way to stop it is the switch, and offering a press that changes nothing is a trap. */}
            {fields.length > 0 && (
              <IconButton
                label={t('subscriptions.channel.clear')}
                size="sm"
                className="ml-auto text-[var(--danger)]"
                disabled={!configured || toggling}
                onClick={() => { void clear() }}
              >
                <Trash2 size={14} />
              </IconButton>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ChannelFieldInput({
  field,
  value,
  configured,
  clearing,
  onChange,
  onClear,
}: {
  field: ChannelField
  value: unknown
  configured: boolean
  clearing: boolean
  onChange: (value: unknown) => void
  onClear: () => void
}): ReactElement {
  const sensitive = field.type === 'password' || ('sensitive' in field && field.sensitive)
  if (field.type === 'switch') {
    return (
      <label className="flex items-center justify-between gap-3">
        <span className="text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{t(field.labelKey)}</span>
        <Switch checked={value === true} onChange={onChange} label={t(field.labelKey)} />
      </label>
    )
  }
  if (field.type === 'select') {
    return (
      <Field label={t(field.labelKey)}>
        <Select value={String(value ?? field.options[0]?.value ?? '')} onChange={(event) => onChange(event.target.value)}>
          {field.options.map((option) => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}
        </Select>
      </Field>
    )
  }
  return (
    <Field
      label={t(field.labelKey)}
      hint={sensitive && configured && !clearing ? t('subscriptions.channel.secret_configured') : undefined}
    >
      <div className="flex items-center gap-1.5">
        {field.type === 'json' || field.type === 'textarea' ? (
          <Textarea
            rows={field.rows ?? 3}
            value={sensitive ? '' : String(value ?? '')}
            placeholder={field.placeholderKey ? t(field.placeholderKey) : undefined}
            onChange={(event) => onChange(event.target.value)}
            className="font-mono text-[length:var(--text-11)]"
          />
        ) : (
          <Input
            type={sensitive ? 'password' : field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
            value={sensitive ? '' : String(value ?? '')}
            placeholder={field.placeholderKey ? t(field.placeholderKey) : undefined}
            autoComplete="off"
            onChange={(event) => onChange(event.target.value)}
          />
        )}
        {sensitive && configured && !clearing && (
          <IconButton label={t('subscriptions.channel.clear_field', { field: t(field.labelKey) })} size="sm" className="shrink-0 text-[var(--danger)]" onClick={onClear}>
            <Trash2 size={13} />
          </IconButton>
        )}
        {clearing && <span className="shrink-0 text-[length:var(--text-10)] text-[var(--danger)]">{t('subscriptions.channel.clear_pending')}</span>}
      </div>
    </Field>
  )
}