/**
 * The card's repeat rule: a frequency, a step, and (for weekly) the weekdays it lands on.
 *
 * Choosing "does not repeat" clears the rule; any other choice keeps the current step and weekdays so
 * switching frequency does not silently reset them. The completed card spawns its next instance from
 * this rule on the server, so the editor only writes the rule itself.
 */
import type { ReactElement } from 'react'
import type { ProjectRecurrence, ProjectRecurrenceFreq } from '@shared/project/model'
import { t } from '../../lib/i18n'
import { Checkbox, Input } from '../../components/form'
import { SelectMenu } from '../../components/select-menu'

const FREQS: readonly ProjectRecurrenceFreq[] = ['daily', 'weekly', 'monthly', 'yearly']

export function RecurrenceEditor({ value, disabled, onChange }: {
  value: ProjectRecurrence | null | undefined
  disabled: boolean
  onChange: (rule: ProjectRecurrence | null) => void
}): ReactElement {
  const freq = value?.freq ?? ''
  const interval = value?.interval ?? 1
  const weekdays = value?.byWeekday ?? []

  const withFreq = (next: ProjectRecurrenceFreq): ProjectRecurrence => ({
    freq: next,
    interval,
    ...(next === 'weekly' && weekdays.length > 0 ? { byWeekday: weekdays } : {}),
  })

  return (
    <div className="flex flex-wrap items-center gap-2" data-card-recurrence="">
      <SelectMenu
        className="w-36"
        value={freq}
        disabled={disabled}
        label={t('project.card.recurrence')}
        onChange={(next) => onChange(next === '' ? null : withFreq(next as ProjectRecurrenceFreq))}
        options={[
          { value: '', label: t('project.card.recurrence.none') },
          ...FREQS.map((entry) => ({ value: entry, label: t(`project.card.recurrence.${entry}` as Parameters<typeof t>[0]) })),
        ]}
      />
      {freq !== '' && (
        <>
          <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('project.card.recurrence.every')}</span>
          <Input
            className="w-16"
            value={String(interval)}
            disabled={disabled}
            inputMode="numeric"
            aria-label={t('project.card.recurrence.every')}
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10)
              const next = Number.isFinite(parsed) && parsed >= 1 ? Math.min(365, parsed) : 1
              onChange({ freq: freq as ProjectRecurrenceFreq, interval: next, ...(freq === 'weekly' && weekdays.length > 0 ? { byWeekday: weekdays } : {}) })
            }}
          />
          <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t(`project.card.recurrence.unit.${freq}` as Parameters<typeof t>[0])}</span>
        </>
      )}
      {freq === 'weekly' && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('project.card.recurrence.weekly')}>
          {[0, 1, 2, 3, 4, 5, 6].map((weekday) => (
            <Checkbox
              key={weekday}
              label={t(`project.card.weekday_${weekday}` as Parameters<typeof t>[0])}
              checked={weekdays.includes(weekday)}
              disabled={disabled}
              onChange={(checked) => {
                const next = checked ? [...weekdays, weekday].sort((a, b) => a - b) : weekdays.filter((entry) => entry !== weekday)
                onChange({ freq: 'weekly', interval, ...(next.length > 0 ? { byWeekday: next } : {}) })
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}