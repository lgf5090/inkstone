/**
 * The tool manager: every built-in tool the assistant knows, with a global on/off switch and an
 * approval mode. This is the account's ceiling; an Agent can only narrow it further.
 */
import { useMemo, useState } from 'react'
import { ASSISTANT_TOOL_CATEGORIES, ASSISTANT_TOOL_MODES, ASSISTANT_TOOL_SPECS, toolCategoryOf, type AssistantToolCategory, type AssistantToolMode } from '@shared/assistant'
import { t, type MessageKey } from '../../lib/i18n'
import { Checkbox, Input, Select, SettingRow } from '../../components/form'
import { useAssistant } from './assistant-store'

type ModeChoice = 'inherit' | AssistantToolMode

const MODE_LABELS: Record<ModeChoice, MessageKey> = {
  inherit: 'assistant.tools.mode_inherit',
  off: 'assistant.tools.mode_off',
  ask: 'assistant.tools.mode_ask',
  auto: 'assistant.tools.mode_auto',
}

export function ToolManagerSection() {
  const settings = useAssistant((state) => state.settings)
  const saveSettings = useAssistant((state) => state.saveSettings)
  const [query, setQuery] = useState('')
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return ASSISTANT_TOOL_SPECS.filter((spec) =>
      !needle || spec.name.toLocaleLowerCase().includes(needle) || t(spec.labelKey).toLocaleLowerCase().includes(needle))
  }, [query])
  if (!settings) return null
  const enabledCount = ASSISTANT_TOOL_SPECS.filter((spec) => settings.toolSettings[spec.name]?.enabled !== false).length
  const tokenEstimate = Math.round(ASSISTANT_TOOL_SPECS.reduce((total, spec) => total + spec.name.length + t(spec.labelKey).length * 2, 0) / 4)
  const entryFor = (name: string) => settings.toolSettings[name] ?? { enabled: true }
  const patch = (name: string, next: { enabled?: boolean, mode?: ModeChoice }) => {
    const current = entryFor(name)
    const enabled = next.enabled ?? current.enabled
    const mode = next.mode
    const merged = mode === 'inherit'
      ? { enabled }
      : { enabled, ...(mode ? { mode } : current.mode ? { mode: current.mode } : {}) }
    void saveSettings({ toolSettings: { ...settings.toolSettings, [name]: merged } })
  }
  const modeValue = (name: string): ModeChoice => entryFor(name).mode ?? 'inherit'
  const groups = useMemo(() => {
    const buckets = new Map<AssistantToolCategory, typeof rows>()
    for (const spec of rows) {
      const category = toolCategoryOf(spec.name, spec.category)
      buckets.set(category, [...(buckets.get(category) ?? []), spec])
    }
    return ASSISTANT_TOOL_CATEGORIES
      .filter((category) => buckets.has(category))
      .map((category) => ({ category, rows: buckets.get(category)! }))
  }, [rows])
  return (
    <div className="space-y-2">
      <SettingRow title={t('assistant.tools.disclosure')} description={t('assistant.tools.disclosure_hint')} controlId="assistant-tool-disclosure">
        <Select
          id="assistant-tool-disclosure"
          value={settings.toolDisclosure}
          aria-label={t('assistant.tools.disclosure')}
          onChange={(event) => { void saveSettings({ toolDisclosure: event.target.value === 'on_demand' ? 'on_demand' : 'all' }) }}
          className="h-7 w-44 text-[length:var(--text-11)]"
        >
          <option value="all">{t('assistant.tools.disclosure_all')}</option>
          <option value="on_demand">{t('assistant.tools.disclosure_on_demand')}</option>
        </Select>
      </SettingRow>
      <SettingRow title={t('assistant.tools.search')} description={t('assistant.tools.hint')}>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('assistant.tools.search')}
          aria-label={t('assistant.tools.search')}
          className="h-8 w-52 text-[length:var(--text-12)]"
        />
      </SettingRow>
      <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
        {t('assistant.tools.summary', { enabled: enabledCount, total: ASSISTANT_TOOL_SPECS.length, tokens: tokenEstimate })}
      </p>
      <div className="max-h-72 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)]">
        {groups.map((group) => (
          <div key={group.category}>
            <p className="sticky top-0 z-[var(--z-sticky)] border-b border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 py-1 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
              {t(`assistant.tools.category.${group.category}` as 'assistant.tools.category.notes')}
            </p>
            {group.rows.map((spec) => (
              <div key={spec.name} className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-2.5 py-1.5 last:border-b-0">
                <Checkbox
                  checked={entryFor(spec.name).enabled}
                  onChange={(enabled) => patch(spec.name, { enabled })}
                  label={t(spec.labelKey)}
                  className="min-w-0 flex-1 min-h-8 text-[length:var(--text-12)]"
                />
                <Select
                  aria-label={t('assistant.tools.mode_for', { name: t(spec.labelKey) })}
                  value={modeValue(spec.name)}
                  onChange={(event) => patch(spec.name, { mode: event.target.value as ModeChoice })}
                  className="h-7 w-32 text-[length:var(--text-11)]"
                >
                  {(['inherit', ...ASSISTANT_TOOL_MODES] as ModeChoice[]).map((mode) => (
                    <option key={mode} value={mode}>{t(MODE_LABELS[mode])}</option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
        ))}
        {!rows.length && <p className="px-2.5 py-3 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('assistant.tools.none')}</p>}
      </div>
    </div>
  )
}
