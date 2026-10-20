/**
 * One reminder rule, drawn once for whoever owns saving it.
 *
 * The rule's type decides which controls exist: a before-expiry rule has a number and a unit, an
 * on-expiry rule has neither (it *is* "that day"), and an after-expiry rule has a repeat interval
 * instead. Showing all three for every kind leaves a reader guessing which one the scheduler reads —
 * which is why this shape is not something the detail panel and the create form should each invent.
 *
 * Persistence stays with the caller. The detail panel patches one rule over HTTP the moment it changes;
 * the form edits a local draft and saves the whole set with the subscription. Both need the same
 * controls and neither needs the other's save model.
 */
import type { ReactElement } from 'react'
import { Trash2 } from 'lucide-react'
import { t, type MessageKey } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Input, Select, Switch } from '../../components/form'
import {
  REPEAT_INTERVAL_MAX,
  REPEAT_UNTIL,
  RULE_VALUE_MAX,
  type ReminderKind,
  type ReminderRuleInput,
  type ReminderUnit,
  type RepeatUntil,
} from '@shared/subscriptions/model'

const REPEAT_UNTIL_KEYS: Record<RepeatUntil, MessageKey> = {
  renewed: 'subscriptions.rules.until_renewed',
  acknowledged: 'subscriptions.rules.until_seen',
  never: 'subscriptions.rules.until_never',
}

export function ReminderRuleRow({ rule, onPatch, onRemove, canAcknowledge = false, onAcknowledge, removable = true }: {
  rule: ReminderRuleInput
  onPatch: (patch: ReminderRuleInput) => void
  onRemove?: () => void
  /** Only an expired subscription has anything to have seen, so only then is the button offered. */
  canAcknowledge?: boolean
  onAcknowledge?: () => void
  removable?: boolean
}): ReactElement {
  const kind = rule.type ?? 'before_expiry'
  const isBefore = kind === 'before_expiry'
  const isAfter = kind === 'after_expiry'
  const repeatUntil = rule.repeatUntil ?? 'renewed'
  return (
    <li className="flex flex-wrap items-center gap-1.5 rounded-[var(--r-md)] px-1 py-1 hover:bg-[var(--bg-hover)]">
      <Select
        aria-label={t('subscriptions.rules.title')}
        value={kind}
        onChange={(event) => onPatch({ type: event.target.value as ReminderKind })}
        className="h-7 w-[104px] shrink-0 text-[length:var(--text-11-5)]"
      >
        <option value="before_expiry">{t('subscriptions.rules.type_before')}</option>
        <option value="on_expiry">{t('subscriptions.rules.type_on')}</option>
        <option value="after_expiry">{t('subscriptions.rules.type_after')}</option>
      </Select>
      {isBefore && (
        <>
          <Input
            aria-label={t('subscriptions.rules.value')}
            type="number"
            min={0}
            max={RULE_VALUE_MAX}
            value={rule.value ?? 0}
            onChange={(event) => onPatch({ value: Number(event.target.value) })}
            className="h-7 w-14 shrink-0 text-center text-[length:var(--text-11-5)] tabular-nums"
          />
          <Select
            aria-label={t('subscriptions.rules.unit')}
            value={rule.unit ?? 'days'}
            onChange={(event) => onPatch({ unit: event.target.value as ReminderUnit })}
            className="h-7 w-[72px] shrink-0 text-[length:var(--text-11-5)]"
          >
            <option value="days">{t('subscriptions.rules.unit_days')}</option>
            <option value="hours">{t('subscriptions.rules.unit_hours')}</option>
          </Select>
        </>
      )}
      {isAfter && (
        <>
          <span className="flex min-w-0 items-center gap-1">
            <Input
              aria-label={t('subscriptions.rules.repeat_every_value')}
              type="number"
              min={1}
              max={REPEAT_INTERVAL_MAX}
              value={rule.repeatInterval ?? 24}
              onChange={(event) => onPatch({ repeatInterval: Number(event.target.value) })}
              className="h-7 w-14 shrink-0 text-center text-[length:var(--text-11-5)] tabular-nums"
            />
            <span className="truncate text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{t('subscriptions.rules.unit_hours')}</span>
          </span>
          {/* Offered because the engine reads it. The field existed and was stored from the first
              version without anything ever consulting it, which made the dropdown a promise nobody kept. */}
          <Select
            aria-label={t('subscriptions.rules.repeat_until')}
            value={repeatUntil}
            onChange={(event) => onPatch({ repeatUntil: event.target.value as RepeatUntil })}
            className="h-7 w-[104px] shrink-0 text-[length:var(--text-11-5)]"
          >
            {REPEAT_UNTIL.map((value) => <option key={value} value={value}>{t(REPEAT_UNTIL_KEYS[value])}</option>)}
          </Select>
        </>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {isAfter && repeatUntil === 'acknowledged' && rule.acknowledgedAt && (
          <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('subscriptions.rules.acknowledged')}</span>
        )}
        {isAfter && repeatUntil === 'acknowledged' && !rule.acknowledgedAt && canAcknowledge && onAcknowledge && (
          <Button size="sm" variant="ghost" onClick={onAcknowledge}>{t('subscriptions.rules.mark_seen')}</Button>
        )}
        <Switch
          checked={rule.isEnabled !== false}
          onChange={(next) => onPatch({ isEnabled: next })}
          label={t('subscriptions.rules.enabled')}
        />
        {removable && onRemove && (
          <IconButton label={t('subscriptions.rules.remove')} size="xs" onClick={onRemove}>
            <Trash2 size={12} />
          </IconButton>
        )}
      </span>
    </li>
  )
}
