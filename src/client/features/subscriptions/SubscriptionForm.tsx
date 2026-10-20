/**
 * The form a subscription is created or corrected with.
 *
 * The order is the order a reader thinks in — what it is, what it costs, when it ends — and the expiry
 * field is the only one that is required, because a subscription whose date is unknown is not a
 * subscription this app can do anything with. The two derived affordances are what make the form worth
 * having over a JSON editor: "compute the expiry from the cycle" fills the date the reader would have
 * counted on their fingers, and the line under it says what that date means in days and in the lunar
 * calendar when that is switched on.
 */
import { useMemo, useState, type ReactElement } from 'react'
import { Calculator, Plus, Sparkles, X } from 'lucide-react'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Field, Input, Select, Switch, Textarea } from '../../components/form'
import { Modal } from '../../components/overlay'
import { formatAmount } from '@shared/subscriptions/format'
import { addLunarPeriod, lunar2solar, solar2lunar } from '@shared/subscriptions/lunar'
import { addCalendarPeriodInTimezone, formatDateInputInTimezone, getTimezoneDateParts, getTimestampForTimezoneParts } from '@shared/subscriptions/time'
import {
  CURRENCY_CODES,
  labelNamesOf,
  PERIOD_UNITS,
  PRESET_RULE_DRAFTS,
  RULES_LIMIT,
  type CurrencyCode,
  type PeriodUnit,
  type ReminderRuleInput,
  type SubscriptionDetail,
  type SubscriptionInput,
  type SubscriptionMode,
} from '@shared/subscriptions/model'
import { LabelGlyph, LabelStylePicker, useLabelIdentity } from './label-identity'
import { LunarDateButton } from './LunarDateButton'
import { ReminderRuleRow } from './ReminderRuleRow'
import { useSubscriptions } from './store'

interface Draft {
  name: string
  customType: string
  category: string
  amount: string
  currency: CurrencyCode
  startDate: string
  expiryDate: string
  periodValue: string
  periodUnit: PeriodUnit
  subscriptionMode: SubscriptionMode
  useLunar: boolean
  isActive: boolean
  autoRenew: boolean
  notes: string
  trialEndsAt: string
  rules: ReminderRuleInput[]
}

function draftOf(detail: SubscriptionDetail | null, timezone: string): Draft {
  const today = formatDateInputInTimezone(Date.now(), timezone)
  if (!detail) {
    return {
      name: '',
      customType: '',
      category: '',
      amount: '',
      currency: 'CNY',
      startDate: today,
      expiryDate: '',
      periodValue: '1',
      periodUnit: 'month',
      subscriptionMode: 'cycle',
      useLunar: false,
      isActive: true,
      autoRenew: true,
      notes: '',
      trialEndsAt: '',
      rules: PRESET_RULE_DRAFTS.map((rule) => ({ ...rule })),
    }
  }
  const { item } = detail
  return {
    name: item.name,
    customType: item.customType,
    category: item.category,
    amount: item.amount === null ? '' : String(item.amount),
    currency: item.currency,
    startDate: item.startDate ? item.startDate.slice(0, 10) : '',
    expiryDate: item.expiryDate.slice(0, 10),
    periodValue: String(item.periodValue),
    periodUnit: item.periodUnit,
    subscriptionMode: item.subscriptionMode,
    useLunar: item.useLunar,
    isActive: item.isActive,
    autoRenew: item.autoRenew,
    notes: item.notes,
    trialEndsAt: item.trialEndsAt ? item.trialEndsAt.slice(0, 10) : '',
    // Carried with their ids so the worker replaces this set rather than appending a second copy of it.
    rules: detail.rules.map((rule) => ({ ...rule })),
  }
}

export function SubscriptionForm({
  open,
  detail,
  timezone,
  categories,
  types,
  saving,
  onClose,
  onSubmit,
}: {
  open: boolean
  detail: SubscriptionDetail | null
  timezone: string
  categories: readonly string[]
  types: readonly string[]
  saving: boolean
  onClose: () => void
  onSubmit: (input: SubscriptionInput) => Promise<boolean>
}): ReactElement {
  const [draft, setDraft] = useState<Draft>(() => draftOf(detail, timezone))
  const [touched, setTouched] = useState(false)

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => setDraft(current => ({ ...current, [key]: value }))

  const nameInvalid = touched && !draft.name.trim()
  const expiryInvalid = touched && !draft.expiryDate

  const hint = useMemo(() => {
    if (!draft.expiryDate) return ''
    const parsed = Date.parse(`${draft.expiryDate}T00:00:00Z`)
    if (!Number.isFinite(parsed)) return ''
    const parts = getTimezoneDateParts(parsed, timezone)
    const lunar = draft.useLunar ? solar2lunar(parts.year, parts.month, parts.day) : null
    const days = Math.round((getTimestampForTimezoneParts(parts, timezone) - Date.now()) / 86_400_000)
    return [lunar ? lunar.fullStr : '', t(days < 0 ? 'subscriptions.status.days_overdue' : 'subscriptions.status.days_left', { count: Math.abs(days) })]
      .filter(Boolean)
      .join(' · ')
  }, [draft.expiryDate, draft.useLunar, timezone])

  const computeExpiry = (): void => {
    const start = draft.startDate ? Date.parse(`${draft.startDate}T00:00:00Z`) : Date.now()
    const value = Math.max(1, Math.trunc(Number(draft.periodValue) || 1))
    const unit = draft.periodUnit
    let next: number
    if (draft.useLunar) {
      const parts = getTimezoneDateParts(start, timezone)
      const lunar = solar2lunar(parts.year, parts.month, parts.day)
      const shifted = lunar ? addLunarPeriod(lunar, value, unit) : null
      const solar = shifted ? lunar2solar(shifted) : null
      next = solar ? getTimestampForTimezoneParts(solar, timezone) : start
    } else {
      next = addCalendarPeriodInTimezone(start, value, unit, timezone).getTime()
    }
    set('expiryDate', formatDateInputInTimezone(next, timezone))
  }

  const submit = async (): Promise<void> => {
    setTouched(true)
    if (!draft.name.trim() || !draft.expiryDate) return
    const ok = await onSubmit({
      name: draft.name.trim(),
      customType: draft.customType.trim(),
      category: draft.category.trim(),
      amount: draft.amount === '' ? null : Number(draft.amount),
      currency: draft.currency,
      startDate: draft.startDate || null,
      expiryDate: `${draft.expiryDate}T00:00:00Z`,
      periodValue: Math.max(1, Math.trunc(Number(draft.periodValue) || 1)),
      periodUnit: draft.periodUnit,
      subscriptionMode: draft.subscriptionMode,
      useLunar: draft.useLunar,
      isActive: draft.isActive,
      autoRenew: draft.autoRenew,
      notes: draft.notes.trim(),
      trialEndsAt: draft.trialEndsAt || null,
      reminderRules: draft.rules,
    })
    if (ok) onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={detail ? t('subscriptions.edit') : t('subscriptions.add')}
      width={640}
      bodyClassName="px-4 py-3"
      footer={(
        <div className="flex w-full items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
              <Switch checked={draft.isActive} onChange={(next) => set('isActive', next)} label={t('subscriptions.detail.toggle_on')} />
              {t('subscriptions.detail.toggle_on')}
            </label>
            <label className="flex items-center gap-1.5 text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
              <Switch checked={draft.autoRenew} onChange={(next) => set('autoRenew', next)} label={t('subscriptions.detail.auto_renew')} />
              {t('subscriptions.detail.auto_renew')}
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>{t('subscriptions.cancel')}</Button>
            <Button variant="primary" loading={saving} onClick={() => void submit()}>{t('subscriptions.save')}</Button>
          </div>
        </div>
      )}
    >
      <div className="space-y-4">
        <section className="space-y-2.5">
          <h3 className="text-[length:var(--text-11)] font-medium uppercase tracking-wide text-[var(--text-quaternary)]">{t('subscriptions.form.section_basic')}</h3>
          <Field label={t('subscriptions.form.name')} required hint={nameInvalid ? t('subscriptions.form.required') : undefined}>
            <Input
              value={draft.name}
              invalid={nameInvalid}
              placeholder={t('subscriptions.form.name_placeholder')}
              onChange={(event) => set('name', event.target.value)}
              autoFocus
            />
          </Field>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label={t('subscriptions.form.type')}>
              <div className="flex items-center gap-1.5">
                <Input
                  className="min-w-0 flex-1"
                  value={draft.customType}
                  list="subscriptions-type-options"
                  aria-label={t('subscriptions.form.type')}
                  placeholder={t('subscriptions.form.type_placeholder')}
                  onChange={(event) => set('customType', event.target.value)}
                />
                <LabelStylePicker
                  kind="type"
                  name={draft.customType}
                  onPick={(style) => void useSubscriptions.getState().setLabelStyle('type', draft.customType, style)}
                />
              </div>
            </Field>
            <Field label={t('subscriptions.detail.category')}>
              <Input
                value={draft.category}
                list="subscriptions-category-options"
                placeholder={t('subscriptions.form.category_placeholder')}
                onChange={(event) => set('category', event.target.value)}
              />
            </Field>
          </div>
          {/* A category is a pile of tags, so the face of "video / music" is two faces and one picker cannot
              answer which it is editing. The type — always one label — gets its picker inline; here the
              reader sees what each tag will look like and sets it from the manager. */}
          <LabelTokenRow value={draft.category} />
          {/* The suggestions live outside the fields: a `Field` holding two children becomes a group, and a
              group names itself instead of naming the input inside it. */}
          <datalist id="subscriptions-type-options">
            {types.map((type) => <option key={type} value={type} />)}
          </datalist>
          <datalist id="subscriptions-category-options">
            {categories.map((category) => <option key={category} value={category} />)}
          </datalist>
        </section>

        <section className="space-y-2.5">
          <h3 className="text-[length:var(--text-11)] font-medium uppercase tracking-wide text-[var(--text-quaternary)]">{t('subscriptions.form.section_cost')}</h3>
          <div className="grid grid-cols-[1fr_120px] gap-2.5">
            <Field label={t('subscriptions.form.amount')}>
              <Input
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={draft.amount}
                placeholder="0.00"
                onChange={(event) => set('amount', event.target.value)}
              />
            </Field>
            <Field label={t('subscriptions.form.currency')}>
              <Select value={draft.currency} onChange={(event) => set('currency', event.target.value as CurrencyCode)}>
                {CURRENCY_CODES.map((code) => <option key={code} value={code}>{code}</option>)}
              </Select>
            </Field>
          </div>
          {/* A trial is the one subscription that quietly becomes a bill, so the date it turns is worth a
              field of its own rather than a note the reminder engine cannot read. */}
          <Field label={t('subscriptions.form.trial_ends')} hint={t('subscriptions.form.trial_ends_hint')}>
            <div className="flex items-center gap-1.5">
              <Input
                className="min-w-0 flex-1"
                type="date"
                aria-label={t('subscriptions.form.trial_ends')}
                value={draft.trialEndsAt}
                onChange={(event) => set('trialEndsAt', event.target.value)}
              />
              {draft.trialEndsAt && (
                <IconButton label={t('subscriptions.form.trial_ends_clear')} size="sm" onClick={() => set('trialEndsAt', '')}>
                  <X size={13} />
                </IconButton>
              )}
            </div>
          </Field>
        </section>

        <section className="space-y-2.5">
          <h3 className="text-[length:var(--text-11)] font-medium uppercase tracking-wide text-[var(--text-quaternary)]">{t('subscriptions.form.section_cycle')}</h3>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label={t('subscriptions.form.period_value')}>
              <Input
                type="number"
                min={1}
                max={120}
                value={draft.periodValue}
                onChange={(event) => set('periodValue', event.target.value)}
              />
            </Field>
            <Field label={t('subscriptions.form.period_unit')}>
              <Select value={draft.periodUnit} onChange={(event) => set('periodUnit', event.target.value as PeriodUnit)}>
                {PERIOD_UNITS.map((unit) => <option key={unit} value={unit}>{t(unit === 'day' ? 'subscriptions.unit_day' : unit === 'year' ? 'subscriptions.unit_year' : 'subscriptions.unit_month')}</option>)}
              </Select>
            </Field>
          </div>
          <Field label={t('subscriptions.detail.mode')}>
            <Select value={draft.subscriptionMode} onChange={(event) => set('subscriptionMode', event.target.value as SubscriptionMode)}>
              <option value="cycle">{t('subscriptions.detail.mode_cycle')}</option>
              <option value="reset">{t('subscriptions.detail.mode_reset')}</option>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label={t('subscriptions.detail.start')}>
              <Input type="date" value={draft.startDate} onChange={(event) => set('startDate', event.target.value)} />
            </Field>
            <Field label={t('subscriptions.detail.expiry')} required hint={expiryInvalid ? t('subscriptions.form.required') : hint}>
              <div className="flex items-center gap-1.5">
                <Input
                  className="min-w-0 flex-1"
                  aria-label={t('subscriptions.detail.expiry')}
                  type="date"
                  value={draft.expiryDate}
                  invalid={expiryInvalid}
                  onChange={(event) => set('expiryDate', event.target.value)}
                />
                {/* The native field cannot be pointed at a lunar calendar, and a birthday or an
                    anniversary is remembered by its lunar date for half the accounts this serves. */}
                <LunarDateButton value={draft.expiryDate} onPick={(date) => set('expiryDate', date)} />
              </div>
            </Field>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" icon={<Calculator size={13} />} onClick={computeExpiry}>
              {t('subscriptions.form.calculate_expiry')}
            </Button>
            <label className="flex items-center gap-1.5 text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
              <Switch checked={draft.useLunar} onChange={(next) => set('useLunar', next)} label={t('subscriptions.form.use_lunar')} />
              {t('subscriptions.form.use_lunar')}
            </label>
            {draft.amount !== '' && (
              <span className="ml-auto text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">
                {formatAmount(Number(draft.amount), draft.currency)}
              </span>
            )}
          </div>
        </section>

        <section className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[length:var(--text-11)] font-medium uppercase tracking-wide text-[var(--text-quaternary)]">{t('subscriptions.rules.title')}</h3>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                icon={<Sparkles size={12} />}
                title={t('subscriptions.rules.preset_hint')}
                onClick={() => set('rules', PRESET_RULE_DRAFTS.map((rule) => ({ ...rule })))}
              >
                {t('subscriptions.rules.preset')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Plus size={12} />}
                disabled={draft.rules.length >= RULES_LIMIT}
                onClick={() => set('rules', [...draft.rules, { type: 'before_expiry', value: 1, unit: 'days', isEnabled: true }])}
              >
                {t('subscriptions.rules.add')}
              </Button>
            </div>
          </div>
          {/* The plan is edited here rather than only afterwards: a reader who knows a service wants a
              week's notice should not have to save it, open it, and then fix the four rules the app
              guessed for them. */}
          {draft.rules.length === 0 ? (
            <p className="px-1 py-1 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('subscriptions.rules.empty')}</p>
          ) : (
            <ul className="space-y-0.5">
              {draft.rules.map((rule, index) => (
                <ReminderRuleRow
                  key={rule.id ?? index}
                  rule={rule}
                  onPatch={(patch) => set('rules', draft.rules.map((entry, position) => position === index ? { ...entry, ...patch } : entry))}
                  onRemove={() => set('rules', draft.rules.filter((_, position) => position !== index))}
                />
              ))}
            </ul>
          )}
          {draft.rules.length >= RULES_LIMIT && (
            <p className="px-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('subscriptions.rules.limit', { max: RULES_LIMIT })}</p>
          )}
        </section>

        <Field label={t('subscriptions.form.notes')}>
          <Textarea rows={3} value={draft.notes} placeholder={t('subscriptions.form.notes_placeholder')} onChange={(event) => set('notes', event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

/**
 * What the typed categories will look like, one chip per tag.
 *
 * Quiet when there is nothing to show: this is a confirmation that a two-tag value landed as
 * two tags rather than one name with a slash in it, which is the mistake the registry used to bake in.
 */
function LabelTokenRow({ value }: { value: string }): ReactElement | null {
  const identityOf = useLabelIdentity()
  const tokens = labelNamesOf(value, 'category')
  if (!tokens.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
      {tokens.map((token) => {
        const identity = identityOf('category', token)
        return (
          <span
            key={token}
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[length:var(--text-11)]"
            style={{ color: identity.color, background: `color-mix(in oklab, ${identity.color} 14%, transparent)` }}
          >
            <LabelGlyph identity={identity} label={token} size={10} />
            {token}
          </span>
        )
      })}
    </div>
  )
}
