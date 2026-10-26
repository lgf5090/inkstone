/**
 * The dialog a refused write opens.
 *
 * The queue parks an event whose revision went stale and asks here: the reader sees both versions of
 * every part they could have changed and picks which one survives. Nothing is written while the dialog
 * is open, and the row on the calendar stays as they left it, so a conflict is a choice rather than a
 * loss.
 */
import { useMemo, useState } from 'react'
import type { CalendarEventDto, CalendarEventInput } from '@shared/calendar/model'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Segmented } from '../../components/form'
import { Modal } from '../../components/overlay'
import { conflictFields, mergeConflict } from './conflict'
import type { ConflictChoice, ConflictFieldKey, ConflictView } from './conflict'
import type { ConflictResolution } from './persistence'

/** The parked write this dialog decides about: always an edit, because a delete is answered by `confirm`. */
export interface ConflictTarget {
  id: string
  mine: CalendarEventInput
  theirs: CalendarEventDto
}

interface CalendarConflictDialogProps {
  request: ConflictTarget
  view: ConflictView
  onDecide: (resolution: ConflictResolution) => void
}

const CHOICES: readonly ConflictChoice[] = ['mine', 'theirs']

export function CalendarConflictDialog({ request, view, onDecide }: CalendarConflictDialogProps) {
  const [picks, setPicks] = useState<Partial<Record<ConflictFieldKey, ConflictChoice>>>({})
  const fields = useMemo(() => conflictFields(request.mine, request.theirs, view), [request, view])
  const differing = useMemo(() => fields.filter((field) => field.differs), [fields])
  const choose = (key: ConflictFieldKey, choice: ConflictChoice): void => {
    setPicks(current => ({ ...current, [key]: choice }))
  }
  const chooseEverywhere = (choice: ConflictChoice): void => {
    setPicks(Object.fromEntries(differing.map((field) => [field.key, choice])) as Record<ConflictFieldKey, ConflictChoice>)
  }

  return (
    <Modal
      open
      onClose={() => { onDecide({ action: 'server' }) }}
      title={t('calendar.conflict.heading', { title: request.theirs.title || t('calendar.event.untitled') })}
      description={t('calendar.conflict.hint')}
      width={680}
      footer={(
        <>
          <Button variant="ghost" onClick={() => { onDecide({ action: 'server' }) }}>
            {t('calendar.conflict.discard')}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onDecide({
                action: 'save',
                input: mergeConflict(request.mine, request.theirs, picks),
                rev: request.theirs.rev,
              })
            }}
          >
            {t('calendar.conflict.save')}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('calendar.conflict.differences', { count: differing.length })}
          </p>
          <div className="flex gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => { chooseEverywhere('mine') }}>
              {t('calendar.conflict.use_all_mine')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { chooseEverywhere('theirs') }}>
              {t('calendar.conflict.use_all_theirs')}
            </Button>
          </div>
        </div>

        <ul className="flex flex-col gap-2.5">
          {fields.map((field) => {
            const selected = picks[field.key] === 'mine' ? 'mine' : 'theirs'
            if (!field.differs) {
              return (
                <li key={field.key} className="flex flex-wrap items-baseline gap-2 text-[length:var(--text-12-5)]">
                  <span className="font-medium text-[var(--text-tertiary)]">{field.label}</span>
                  <span className="min-w-0 flex-1 break-words text-[var(--text-quaternary)]">{field.mine}</span>
                </li>
              )
            }
            return (
              <li
                key={field.key}
                className="flex flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    id={`calendar-conflict-${field.key}`}
                    className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]"
                  >
                    {field.label}
                  </span>
                  <Segmented
                    size="sm"
                    value={selected}
                    aria-labelledby={`calendar-conflict-${field.key}`}
                    options={CHOICES.map((choice) => ({
                      value: choice,
                      label: choice === 'mine' ? t('calendar.conflict.mine') : t('calendar.conflict.theirs'),
                    }))}
                    onChange={(next) => { choose(field.key, next) }}
                  />
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {CHOICES.map((choice) => {
                    const active = selected === choice
                    return (
                      <p
                        key={choice}
                        className={
                          active
                            ? 'line-clamp-3 break-words rounded-[var(--r-sm)] border border-[var(--border-strong)] bg-[var(--bg-surface)] p-2 text-[length:var(--text-12-5)] text-[var(--text-primary)]'
                            : 'line-clamp-3 break-words rounded-[var(--r-sm)] border border-[var(--border-subtle)] p-2 text-[length:var(--text-12-5)] text-[var(--text-tertiary)]'
                        }
                      >
                        {choice === 'mine' ? field.mine : field.theirs}
                      </p>
                    )
                  })}
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </Modal>
  )
}
