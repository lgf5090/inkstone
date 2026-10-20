/**
 * The task settings section.
 *
 * Three things live here: the characters a checkbox may hold, the dates a move stamps, and the word
 * that decides which lines are tasks at all. Everything about how a date is *spelled* stays with the
 * query module's completion settings, because that is where it has always been and moving it would
 * silently reset it for every reader who set it.
 *
 * The status table is validated as it is typed, and an invalid row is named rather than dropped
 * quietly: a symbol that is two characters, or a next-status that points nowhere, would otherwise
 * decide what a click does in a way the reader cannot see.
 */
import { Plus, Trash2 } from 'lucide-react'
import type { TaskStatusSetting } from '@shared/types'
import { TASK_HIDEABLE_FIELDS } from '@shared/constants'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Field, Input, Select, SettingRow, Slider, Switch } from '../../components/form'
import { t } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { validateStatusConfigurations } from '../../lib/tasks/line'
import type { MessageKey } from '@shared/locales/en-US'

const STATUS_TYPES = ['TODO', 'DONE', 'IN_PROGRESS', 'ON_HOLD', 'CANCELLED', 'NON_TASK'] as const

const TYPE_KEYS: Record<string, MessageKey> = {
  TODO: 'settings.tasks_status_type_todo',
  DONE: 'settings.tasks_status_type_done',
  IN_PROGRESS: 'settings.tasks_status_type_in_progress',
  ON_HOLD: 'settings.tasks_status_type_on_hold',
  CANCELLED: 'settings.tasks_status_type_cancelled',
  NON_TASK: 'settings.tasks_status_type_non_task',
}

const FAILURE_KEYS: Record<string, MessageKey> = {
  'duplicate-symbol': 'settings.tasks_status_error_duplicate',
  'bad-symbol': 'settings.tasks_status_error_bad_symbol',
  'empty-name': 'settings.tasks_status_error_empty_name',
  'missing-next': 'settings.tasks_status_error_missing_next',
}

export function TasksSettings() {
  const tasks = useSession((state) => state.settings.tasks)
  const update = useSession((state) => state.updateSettings)
  const patch = (change: Partial<typeof tasks>): void => update({ tasks: { ...tasks, ...change } })
  const failures = validateStatusConfigurations(tasks.statuses)

  const setStatus = (index: number, change: Partial<TaskStatusSetting>): void => {
    const next = tasks.statuses.map((row, at) => (at === index ? { ...row, ...change } : row))
    patch({ statuses: next })
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('settings.tasks_heading_filter')}
        </h3>
        <SettingRow
          title={t('settings.tasks_global_filter')}
          description={t('settings.tasks_global_filter_desc')}
        >
          <Input
            value={tasks.globalFilter}
            placeholder={t('settings.tasks_global_filter_placeholder')}
            onChange={(event) => patch({ globalFilter: event.target.value.slice(0, 40) })}
          />
        </SettingRow>
      </section>

      <section className="space-y-3">
        <h3
          data-setting-title={t('settings.tasks_statuses')}
          className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]"
        >
          {t('settings.tasks_statuses')}
        </h3>
        {tasks.statuses.length === 0 && (
          <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('settings.tasks_statuses_empty')}
          </p>
        )}
        {tasks.statuses.map((row, index) => (
          <div key={`${row.symbol}-${index}`} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3 space-y-2">
            <div className="flex items-end gap-2">
              <Field label={t('settings.tasks_status_symbol')}>
                <Input
                  className="w-16 text-center"
                  value={row.symbol}
                  maxLength={1}
                  onChange={(event) => setStatus(index, { symbol: event.target.value.slice(0, 1) })}
                />
              </Field>
              <Field label={t('settings.tasks_status_name')} className="min-w-0 flex-1">
                <Input
                  value={row.name}
                  onChange={(event) => setStatus(index, { name: event.target.value })}
                />
              </Field>
              <Field label={t('settings.tasks_status_next')}>
                <Input
                  className="w-16 text-center"
                  value={row.nextStatusSymbol}
                  maxLength={1}
                  onChange={(event) => setStatus(index, { nextStatusSymbol: event.target.value.slice(0, 1) })}
                />
              </Field>
              <IconButton
                label={t('settings.tasks_status_delete')}
                size="sm"
                onClick={() => patch({ statuses: tasks.statuses.filter((_, at) => at !== index) })}
              >
                <Trash2 size={14} />
              </IconButton>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Field label={t('settings.tasks_status_type')}>
                <Select
                  value={row.type}
                  onChange={(event) => setStatus(index, { type: event.target.value as TaskStatusSetting['type'] })}
                >
                  {STATUS_TYPES.map((type) => (
                    <option key={type} value={type}>{t(TYPE_KEYS[type])}</option>
                  ))}
                </Select>
              </Field>
              <Checkbox
                checked={row.availableAsCommand}
                onChange={(checked) => setStatus(index, { availableAsCommand: checked })}
                label={t('settings.tasks_status_as_command')}
              />
            </div>
          </div>
        ))}
        {failures.length > 0 && (
          <ul className="space-y-1 text-[length:var(--text-12)] text-[var(--danger)]" role="status">
            {failures.map((failure, index) => (
              <li key={`${failure.symbol}-${index}`}>
                {`[${failure.symbol || '?'}] ${t(FAILURE_KEYS[failure.reason] ?? 'settings.tasks_status_error_bad_symbol')}`}
              </li>
            ))}
          </ul>
        )}
        <Button
          variant="ghost"
          onClick={() => patch({
            statuses: [...tasks.statuses, {
              symbol: '?',
              name: '',
              nextStatusSymbol: ' ',
              type: 'TODO',
              availableAsCommand: false,
            }],
          })}
        >
          <Plus size={14} />
          {t('settings.tasks_status_add')}
        </Button>
      </section>

      <section className="space-y-3">
        <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('settings.tasks_heading_dates')}
        </h3>
        <SettingRow title={t('settings.tasks_set_cancelled_date')} description={t('settings.tasks_set_cancelled_date_desc')}>
          <Switch checked={tasks.setCancelledDate} onChange={(checked) => patch({ setCancelledDate: checked })} />
        </SettingRow>
        <SettingRow title={t('settings.tasks_set_created_date')} description={t('settings.tasks_set_created_date_desc')}>
          <Switch checked={tasks.setCreatedDate} onChange={(checked) => patch({ setCreatedDate: checked })} />
        </SettingRow>
        <SettingRow title={t('settings.tasks_recurrence_on_next_line')} description={t('settings.tasks_recurrence_on_next_line_desc')}>
          <Switch checked={tasks.recurrenceOnNextLine} onChange={(checked) => patch({ recurrenceOnNextLine: checked })} />
        </SettingRow>
        <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('settings.tasks_dates_note')}
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('settings.tasks_heading_lists')}
        </h3>
        <SettingRow
          title={t('settings.tasks_default_hidden')}
          description={t('settings.tasks_default_hidden_desc')}
          className="md:flex-col md:items-stretch"
        >
          <div className="flex w-full flex-wrap gap-x-4 gap-y-2">
            {TASK_HIDEABLE_FIELDS.map((field) => (
              <Checkbox
                key={field}
                checked={tasks.defaultHiddenFields.includes(field)}
                onChange={(checked) => patch({
                  defaultHiddenFields: checked
                    ? [...tasks.defaultHiddenFields, field]
                    : tasks.defaultHiddenFields.filter((item) => item !== field),
                })}
                label={t(FIELD_KEYS[field] ?? 'settings.tasks_field_other')}
              />
            ))}
          </div>
        </SettingRow>
      </section>

      <section className="space-y-3">
        <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('settings.tasks_heading_suggest')}
        </h3>
        <SettingRow title={t('settings.tasks_suggest_min_match')} description={t('settings.tasks_suggest_min_match_desc')}>
          <Slider
            value={tasks.autoSuggestMinMatch}
            min={0}
            max={5}
            onChange={(value) => patch({ autoSuggestMinMatch: value })}
          />
        </SettingRow>
        <SettingRow title={t('settings.tasks_suggest_max_items')} description={t('settings.tasks_suggest_max_items_desc')}>
          <Slider
            value={tasks.autoSuggestMaxItems}
            min={2}
            max={12}
            onChange={(value) => patch({ autoSuggestMaxItems: value })}
          />
        </SettingRow>
      </section>
    </div>
  )
}

const FIELD_KEYS: Record<string, MessageKey> = {
  id: 'settings.tasks_field_id',
  'depends on': 'settings.tasks_field_depends_on',
  priority: 'settings.tasks_field_priority',
  'recurrence rule': 'settings.tasks_field_recurrence',
  'on completion': 'settings.tasks_field_on_completion',
  'created date': 'settings.tasks_field_created',
  'start date': 'settings.tasks_field_start',
  'scheduled date': 'settings.tasks_field_scheduled',
  'due date': 'settings.tasks_field_due',
  'cancelled date': 'settings.tasks_field_cancelled',
  'done date': 'settings.tasks_field_done',
  tags: 'settings.tasks_field_tags',
}
