/**
 * Account-wide calendar preferences. The draft is saved as a whole, because the API stores the full
 * preference object and a partial write would silently reset the fields this panel does not show.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { CalendarPreferences } from '@shared/calendar/model'
import { normalizeCalendarPreferences } from '@shared/calendar/model'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { Button } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { Input, Segmented, Select, SettingRow, Switch } from '../../components/form'
import { DAY_HOUR_HEIGHTS } from './model'
import { supportedTimeZones } from './timezone'

interface CalendarSettingsProps {
  open: boolean
  onClose: () => void
  preferences: CalendarPreferences
  onSave: (next: CalendarPreferences) => Promise<void>
  onOpenConnections?: () => void
}

const WEEKDAY_KEYS = [
  'calendar.settings.weekday_0',
  'calendar.settings.weekday_1',
  'calendar.settings.weekday_2',
  'calendar.settings.weekday_3',
  'calendar.settings.weekday_4',
  'calendar.settings.weekday_5',
  'calendar.settings.weekday_6',
] as const

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-[var(--border-subtle)] pb-1 last:border-b-0">
      <h3 className="pt-3 pb-1 text-[length:var(--text-11)] font-semibold uppercase tracking-[0.07em] text-[var(--text-quaternary)]">
        {title}
      </h3>
      {children}
    </section>
  )
}

export function CalendarSettings({ open, onClose, preferences, onSave, onOpenConnections }: CalendarSettingsProps) {
  const [draft, setDraft] = useState(preferences)
  const [agendaDaysText, setAgendaDaysText] = useState(String(preferences.agendaDays))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timeZones = useMemo(supportedTimeZones, [])

  useEffect(() => {
    if (!open) return
    setDraft(preferences)
    setAgendaDaysText(String(preferences.agendaDays))
    setSaving(false)
    setError(null)
    // Reset on open only: a metadata refresh while the panel is open must not discard the draft.
  }, [open])

  const patch = (changes: Partial<CalendarPreferences>): void => setDraft(current => ({ ...current, ...changes }))

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await onSave(normalizeCalendarPreferences(draft))
      useUi.getState().toast({ title: t('calendar.settings.saved'), tone: 'success' })
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error && saveError.message ? saveError.message : t('calendar.settings.save_failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('calendar.settings.title')}
      description={t('calendar.settings.description')}
      width={640}
      bodyClassName="px-0 md:px-0"
      dismissible={!saving}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {saving ? t('calendar.dialog.saving') : t('common.save')}
          </Button>
        </>
      )}
    >
      <div className="px-4 md:px-5">
        <Section title={t('calendar.settings.display')}>
          <SettingRow title={t('calendar.settings.default_view')}>
            <Segmented
              label={t('calendar.settings.default_view')}
              value={draft.defaultView}
              onChange={(value) => patch({ defaultView: value })}
              options={[
                { value: 'day', label: t('calendar.view.day') },
                { value: 'week', label: t('calendar.view.week') },
                { value: 'month', label: t('calendar.view.month') },
                { value: 'year', label: t('calendar.view.year') },
                { value: 'agenda', label: t('calendar.view.agenda') },
              ]}
              size="sm"
            />
          </SettingRow>
          <SettingRow title={t('calendar.settings.year_mode')} controlId="calendar-settings-year-mode">
            <Select
              id="calendar-settings-year-mode"
              value={draft.yearViewMode}
              onChange={(event) => patch({ yearViewMode: event.target.value as CalendarPreferences['yearViewMode'] })}
              className="w-44"
            >
              <option value="year-canvas">{t('calendar.settings.year_mode_canvas')}</option>
              <option value="fixed-week">{t('calendar.settings.year_mode_fixed')}</option>
              <option value="grid">{t('calendar.settings.year_mode_grid')}</option>
            </Select>
          </SettingRow>
          {draft.yearViewMode === 'year-canvas' && (
            <SettingRow title={t('calendar.settings.year_timed')} description={t('calendar.settings.year_timed_hint')}>
              <Switch
                label={t('calendar.settings.year_timed')}
                checked={draft.yearShowTimedEvents}
                onChange={(value) => patch({ yearShowTimedEvents: value })}
              />
            </SettingRow>
          )}
          {draft.yearViewMode === 'grid' && (
            <SettingRow title={t('calendar.settings.year_heatmap')} controlId="calendar-settings-year-heatmap">
              <Select
                id="calendar-settings-year-heatmap"
                value={String(draft.yearHeatmapLevels)}
                onChange={(event) => patch({ yearHeatmapLevels: Number(event.target.value) })}
                className="w-24"
              >
                {[3, 4, 5, 6, 7].map(level => <option key={level} value={level}>{level}</option>)}
              </Select>
            </SettingRow>
          )}
          <SettingRow title={t('calendar.settings.agenda_days')} controlId="calendar-settings-agenda-days">
            <Input
              id="calendar-settings-agenda-days"
              type="number"
              min={1}
              max={365}
              value={agendaDaysText}
              onChange={(event) => {
                const text = event.target.value
                setAgendaDaysText(text)
                const value = Number(text)
                if (Number.isInteger(value) && value >= 1 && value <= 365) patch({ agendaDays: value })
              }}
              onBlur={() => {
                const value = Number(agendaDaysText)
                if (!Number.isInteger(value) || value < 1 || value > 365) {
                  setAgendaDaysText(String(draft.agendaDays))
                }
              }}
              className="w-24"
            />
          </SettingRow>
          <SettingRow title={t('calendar.settings.agenda_empty')}>
            <Switch
              label={t('calendar.settings.agenda_empty')}
              checked={draft.agendaShowEmptyDays}
              onChange={(value) => patch({ agendaShowEmptyDays: value })}
            />
          </SettingRow>
          <SettingRow title={t('calendar.settings.week_start')} controlId="calendar-settings-week-start">
            <Select
              id="calendar-settings-week-start"
              value={String(draft.weekStart)}
              onChange={(event) => patch({ weekStart: Number(event.target.value) })}
              className="w-40"
            >
              {WEEKDAY_KEYS.map((key, index) => (
                <option key={key} value={String(index)}>{t(key)}</option>
              ))}
            </Select>
          </SettingRow>
          <SettingRow title={t('calendar.settings.show_week_numbers')}>
            <Switch
              label={t('calendar.settings.show_week_numbers')}
              checked={draft.showWeekNumbers}
              onChange={(value) => patch({ showWeekNumbers: value })}
            />
          </SettingRow>
          <SettingRow title={t('calendar.settings.show_half_hours')}>
            <Switch
              label={t('calendar.settings.show_half_hours')}
              checked={draft.showHalfHourLines}
              onChange={(value) => patch({ showHalfHourLines: value })}
            />
          </SettingRow>
          <SettingRow title={t('calendar.settings.month_scroll')} description={t('calendar.settings.month_scroll_hint')}>
            <Switch
              label={t('calendar.settings.month_scroll')}
              checked={draft.monthScroll}
              onChange={(value) => patch({ monthScroll: value })}
            />
          </SettingRow>
          <SettingRow title={t('calendar.settings.snap_month')}>
            <Switch
              label={t('calendar.settings.snap_month')}
              checked={draft.snapToMonth}
              onChange={(value) => patch({ snapToMonth: value })}
            />
          </SettingRow>
          <SettingRow title={t('calendar.settings.day_height')}>
            <Segmented
              label={t('calendar.settings.day_height')}
              value={String(draft.dayHourHeight)}
              onChange={(value) => patch({ dayHourHeight: Number(value) })}
              options={DAY_HOUR_HEIGHTS.map((height, index) => ({
                value: String(height),
                label: t(index === 0
                  ? 'calendar.settings.day_height_compact'
                  : index === 1
                    ? 'calendar.settings.day_height_comfortable'
                    : 'calendar.settings.day_height_tall'),
              }))}
              size="sm"
            />
          </SettingRow>
          <SettingRow title={t('calendar.settings.time_format')}>
            <Segmented
              label={t('calendar.settings.time_format')}
              value={draft.timeFormat}
              onChange={(value) => patch({ timeFormat: value })}
              options={[
                { value: '12h', label: t('calendar.settings.time_format_12') },
                { value: '24h', label: t('calendar.settings.time_format_24') },
              ]}
              size="sm"
            />
          </SettingRow>
        </Section>

        <Section title={t('calendar.settings.time')}>
          <SettingRow title={t('calendar.settings.time_zone')} controlId="calendar-settings-timezone">
            <Select
              id="calendar-settings-timezone"
              value={draft.timeZone}
              onChange={(event) => patch({ timeZone: event.target.value })}
              className="w-60"
            >
              {!timeZones.includes(draft.timeZone) && <option value={draft.timeZone}>{draft.timeZone}</option>}
              {timeZones.map(zone => (
                <option key={zone} value={zone}>{zone}</option>
              ))}
            </Select>
          </SettingRow>
          <SettingRow title={t('calendar.settings.secondary_time_zone')} controlId="calendar-settings-secondary-zone">
            <Select
              id="calendar-settings-secondary-zone"
              value={draft.secondaryTimeZone ?? ''}
              onChange={(event) => patch({ secondaryTimeZone: event.target.value || null })}
              className="w-60"
            >
              <option value="">{t('calendar.settings.none')}</option>
              {draft.secondaryTimeZone && !timeZones.includes(draft.secondaryTimeZone) && (
                <option value={draft.secondaryTimeZone}>{draft.secondaryTimeZone}</option>
              )}
              {timeZones.map(zone => (
                <option key={zone} value={zone}>{zone}</option>
              ))}
            </Select>
          </SettingRow>
          <SettingRow title={t('calendar.settings.calendar_system')} controlId="calendar-settings-system">
            <Select
              id="calendar-settings-system"
              value={draft.calendarSystem}
              onChange={(event) => patch({ calendarSystem: event.target.value === 'jalali' ? 'jalali' : 'gregorian' })}
              className="w-40"
            >
              <option value="gregorian">{t('calendar.settings.gregorian')}</option>
              <option value="jalali">{t('calendar.settings.jalali')}</option>
            </Select>
          </SettingRow>
        </Section>

        <Section title={t('calendar.settings.events')}>
          <SettingRow title={t('calendar.settings.reminder')} controlId="calendar-settings-reminder">
            <Select
              id="calendar-settings-reminder"
              value={String(draft.eventReminderMinutes)}
              onChange={(event) => patch({ eventReminderMinutes: Number(event.target.value) })}
              className="w-40"
            >
              <option value="0">{t('calendar.settings.reminder_off')}</option>
              {[5, 10, 15, 30, 60, 120].map(minutes => (
                <option key={minutes} value={minutes}>{t('calendar.settings.reminder_minutes', { minutes })}</option>
              ))}
              <option value="1440">{t('calendar.settings.reminder_day')}</option>
            </Select>
          </SettingRow>
          <SettingRow title={t('calendar.settings.enable_tasks')} description={t('calendar.settings.enable_tasks_hint')}>
            <Switch
              label={t('calendar.settings.enable_tasks')}
              checked={draft.enableTasks}
              onChange={(value) => patch({ enableTasks: value })}
            />
          </SettingRow>
          <SettingRow title={t('calendar.settings.event_dialog')}>
            <Switch
              label={t('calendar.settings.event_dialog')}
              checked={draft.eventDetailDialog}
              onChange={(value) => patch({ eventDetailDialog: value })}
            />
          </SettingRow>
          <SettingRow title={t('calendar.settings.event_trigger')}>
            <Segmented
              label={t('calendar.settings.event_trigger')}
              value={draft.eventDetailTrigger}
              onChange={(value) => patch({ eventDetailTrigger: value })}
              options={[
                { value: 'click', label: t('calendar.settings.trigger_click') },
                { value: 'dbClick', label: t('calendar.settings.trigger_double') },
              ]}
              size="sm"
            />
          </SettingRow>
        </Section>

        <Section title={t('calendar.settings.sidebar')}>
          <SettingRow title={t('calendar.settings.show_mini')}>
            <Switch
              label={t('calendar.settings.show_mini')}
              checked={draft.showMiniCalendar}
              onChange={(value) => patch({ showMiniCalendar: value })}
            />
          </SettingRow>
          <SettingRow title={t('calendar.settings.show_event_dots')}>
            <Switch
              label={t('calendar.settings.show_event_dots')}
              checked={draft.showEventDots}
              onChange={(value) => patch({ showEventDots: value })}
            />
          </SettingRow>
        </Section>

        {onOpenConnections && (
          <Section title={t('calendar.connections.title')}>
            <SettingRow title={t('calendar.connections.existing')} description={t('calendar.connections.description')}>
              <Button variant="secondary" onClick={onOpenConnections}>{t('calendar.connections.add')}</Button>
            </SettingRow>
          </Section>
        )}

        {error && (
          <p role="alert" className="flex items-start gap-1.5 pt-3 text-[length:var(--text-12)] leading-relaxed text-[var(--danger)]">
            <AlertTriangle size={13} className="mt-[2px] shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
      </div>
    </Modal>
  )
}
