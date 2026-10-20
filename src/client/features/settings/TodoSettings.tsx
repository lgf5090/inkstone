/**
 * The to-do settings page: the zone its days are read in, and the reminder a new task starts with.
 *
 * The worker answers `dayEnd` and every due-date comparison from a single stored zone, because "today" is
 * a span in the reader's own day rather than something a browser can compute once it is a thousand
 * kilometres from where the reader wrote the task. That value is the account's scheduling zone — the same
 * one the assistant's automations re-schedule against — and until now it was only reachable from the
 * chat's own settings tab, which left a reader who never opens the assistant looking at a "today" that
 * begins eight hours away from their own.
 *
 * It stays one stored value rather than becoming a second, todo-shaped one: two zones for one account is
 * two answers to "what is today", and the app would have to pick which lie to show.
 *
 * The default reminder is the other value here and it is stored with the note settings, not with the
 * assistant's: it is a rule for tasks the to-do app creates, and the worker reads it when a task arrives
 * without a reminder of its own.
 */
import { useEffect, useId, useMemo, useState } from 'react'
import type { AssistantSettings } from '@shared/assistant'
import { isValidTimeZone } from '@shared/assistant-schedule'
import { REMIND_OFFSETS, type RemindOffset } from '@shared/todos/model'
import { t, translateApiError } from '../../lib/i18n'
import { api, ApiError } from '../../lib/api'
import { Button } from '../../components/primitives'
import { Select, SettingRow } from '../../components/form'
import { LoadingBlock } from '../../components/feedback'
import { useSession } from '../../store/session'

/** What a failed read or write says to the reader: the code the server named when it has one. */
function describeError(cause: unknown): string {
  if (cause instanceof ApiError) return translateApiError(cause.code, cause.message)
  return cause instanceof Error ? cause.message : String(cause)
}

export function TodoSettings() {
  const [settings, setSettings] = useState<AssistantSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const zoneId = useId()
  const remindId = useId()
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const defaultRemind = useSession((state) => state.settings.todo.defaultRemind)
  const updateSettings = useSession((state) => state.updateSettings)

  useEffect(() => {
    let wanted = true
    void api.assistant.settings()
      .then((answer) => { if (wanted) { setSettings(answer.settings); setError(null) } })
      .catch((cause: unknown) => { if (wanted) setError(describeError(cause)) })
    return () => { wanted = false }
  }, [])

  const zones = useMemo(() => {
    if (!settings) return [browserZone]
    const list = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [browserZone]
    // A stored zone the shipped data set does not name still has to be selectable, or saving anything
    // else would silently move the reader's day.
    return list.includes(settings.timezone) ? list : [settings.timezone, ...list]
  }, [browserZone, settings])

  async function save(timezone: string) {
    setSaving(true)
    try {
      const answer = await api.assistant.saveSettings({ timezone })
      setSettings(answer.settings)
      setError(null)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setSaving(false)
    }
  }

  function saveDefaultRemind(offset: RemindOffset): void {
    updateSettings({ todo: { defaultRemind: offset === 'none' ? null : offset } })
  }

  if (!settings && !error) return <LoadingBlock />

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="flex items-center justify-between gap-3 rounded-[var(--r-md)] border border-[var(--danger-border)] px-3 py-2">
          <p className="min-w-0 text-[length:var(--text-12-5)] text-[var(--danger)]">{error}</p>
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => void save(settings?.timezone ?? browserZone)}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {!error && !settings ? null : (
        <SettingRow
          title={t('assistant.settings.timezone')}
          description={settings && settings.timezone !== browserZone
            ? t('assistant.settings.timezone_use_device', { zone: browserZone })
            : t('assistant.settings.timezone_hint')}
          controlId={zoneId}
        >
          <div className="flex items-center gap-2">
            {settings && settings.timezone !== browserZone && isValidTimeZone(browserZone) && (
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => void save(browserZone)}>
                {t('assistant.settings.timezone_detect')}
              </Button>
            )}
            <Select
              id={zoneId}
              value={settings?.timezone ?? browserZone}
              disabled={saving}
              onChange={(event) => void save(event.target.value)}
              className="max-w-[240px]"
            >
              {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
            </Select>
          </div>
        </SettingRow>
      )}
      <SettingRow
        title={t('settings.todo_default_remind')}
        description={t('settings.todo_default_remind_hint')}
        controlId={remindId}
      >
        <Select
          id={remindId}
          value={defaultRemind ?? 'none'}
          onChange={(event) => saveDefaultRemind(event.target.value as RemindOffset)}
          className="max-w-[240px]"
        >
          {REMIND_OFFSETS.map((offset) => (
            <option key={offset} value={offset}>
              {offset === 'none' ? t('settings.todo_default_remind_none') : t(`todo.remind.${offset}`)}
            </option>
          ))}
        </Select>
      </SettingRow>
    </div>
  )
}
