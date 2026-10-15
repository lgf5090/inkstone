/**
 * The budget tab: the ceilings one request may spend, and what a turn is allowed to cost.
 */
import { useEffect, useMemo, useState } from 'react'
import { type AssistantLimits, type AssistantSettings } from '@shared/assistant'
import { LIMIT_RANGES } from '@shared/assistant'
import { t, type MessageKey } from '../../lib/i18n'
import { api } from '../../lib/api'
import { Button, Spinner } from '../../components/primitives'
import { Input, SettingRow, Slider } from '../../components/form'
import { useAssistant } from './assistant-store'
import { Group } from './assistant-settings-shared'

// The three ceilings a model may leave unset, in the order the model editor draws them, then the ones
// that shape a turn. Each of the three answers for a model that has not set its own, which is what makes
// "Not set" a real choice beside a model rather than a number that silently became a default.
const LIMIT_FIELDS: { key: keyof AssistantLimits, label: MessageKey, hint: MessageKey }[] = [
  { key: 'maxContextTokens', label: 'assistant.settings.limit.context', hint: 'assistant.settings.limit.context_hint' },
  { key: 'maxInputTokens', label: 'assistant.settings.limit.input', hint: 'assistant.settings.limit.input_hint' },
  { key: 'maxOutputTokens', label: 'assistant.settings.limit.output', hint: 'assistant.settings.limit.output_hint' },
  { key: 'maxToolCalls', label: 'assistant.settings.limit.tools', hint: 'assistant.settings.limit.tools_hint' },
  { key: 'maxAgentSteps', label: 'assistant.settings.limit.steps', hint: 'assistant.settings.limit.steps_hint' },
  { key: 'maxRequestsPerDay', label: 'assistant.settings.limit.requests', hint: 'assistant.settings.limit.requests_hint' },
  { key: 'maxScheduledRunsPerDay', label: 'assistant.settings.limit.scheduled', hint: 'assistant.settings.limit.scheduled_hint' },
]

export function BudgetTab({ settings }: { settings: AssistantSettings }) {
  const saveSettings = useAssistant((state) => state.saveSettings)
  const [limits, setLimits] = useState<AssistantLimits>(settings.limits)
  const [temperature, setTemperature] = useState(settings.temperature)
  const [usage, setUsage] = useState<{ today: Record<string, number>, last7Days: Record<string, number> } | null>(null)
  const dirty = useMemo(
    () => JSON.stringify(limits) !== JSON.stringify(settings.limits) || temperature !== settings.temperature,
    [limits, settings.limits, temperature],
  )

  useEffect(() => {
    void api.assistant.usage().then((result) => {
      setUsage({ today: result.today as unknown as Record<string, number>, last7Days: result.last7Days as unknown as Record<string, number> })
    }).catch(() => setUsage(null))
  }, [])

  return (
    <>
      <Group title={t('assistant.settings.usage')}>
        {!usage ? (
          <div className="flex justify-center py-4"><Spinner /></div>
        ) : (
          <div className="grid grid-cols-2 gap-2 py-3 md:grid-cols-4">
            {[
              [t('assistant.settings.usage_requests'), `${usage.today.requests} / ${settings.limits.maxRequestsPerDay}`],
              [t('assistant.settings.usage_tokens'), ((usage.today.inputTokens ?? 0) + (usage.today.outputTokens ?? 0)).toLocaleString()],
              [t('assistant.settings.usage_tools'), String(usage.today.toolCalls ?? 0)],
              [t('assistant.settings.usage_scheduled'), `${usage.today.scheduledRuns ?? 0} / ${settings.limits.maxScheduledRunsPerDay}`],
            ].map(([label, value]) => (
              <div key={label} className="rounded-[var(--r-md)] bg-[var(--bg-inset)] px-2.5 py-2">
                <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{label}</p>
                <p className="mt-0.5 text-[length:var(--text-15)] font-semibold tabular text-[var(--text-primary)]">{value}</p>
              </div>
            ))}
            <p className="col-span-2 text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)] md:col-span-4">
              {t('assistant.settings.usage_note', { week: usage.last7Days.requests ?? 0, errors: usage.last7Days.errors ?? 0 })}
            </p>
          </div>
        )}
      </Group>

      <Group title={t('assistant.settings.limits')}>
        <SettingRow title={t('assistant.settings.temperature')} description={t('assistant.settings.temperature_hint')}>
          <Slider
            value={temperature}
            min={0}
            max={1.5}
            step={0.1}
            onChange={setTemperature}
            label={t('assistant.settings.temperature')}

          />
        </SettingRow>
        {LIMIT_FIELDS.map((entry) => {
          const [min, max] = LIMIT_RANGES[entry.key]
          return (
            <SettingRow key={entry.key} title={t(entry.label)} description={t(entry.hint)}>
              <Input
                type="number"
                min={min}
                max={max}
                value={limits[entry.key]}
                onChange={(event) => setLimits({ ...limits, [entry.key]: Number(event.target.value) })}
                className="h-8 w-28 text-[length:var(--text-12-5)]"
              />
            </SettingRow>
          )
        })}
        <div className="flex justify-end gap-2 py-3">
          <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => { setLimits(settings.limits); setTemperature(settings.temperature) }}>
            {t('assistant.settings.revert')}
          </Button>
          <Button size="sm" variant="primary" disabled={!dirty} onClick={() => void saveSettings({ limits, temperature })}>
            {t('common.save')}
          </Button>
        </div>
      </Group>
    </>
  )
}
