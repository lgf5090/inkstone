/**
 * The behaviour tab: what the assistant calls itself, and how it answers.
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { type AssistantSettings } from '@shared/assistant'
import { ASSISTANT_TOOL_MODES, ASSISTANT_TOOL_PERMISSIONS, MAX_CUSTOM_INSTRUCTIONS_CHARS, MAX_SEARCH_ENDPOINT_CHARS, searchEndpointValue } from '@shared/assistant'
import { isValidTimeZone } from '@shared/assistant-schedule'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Input, Segmented, Select, SettingRow, Switch, Textarea } from '../../components/form'
import { useAssistant } from './assistant-store'
import { Group } from './assistant-settings-shared'

export function BehaviourTab({ settings }: { settings: AssistantSettings }) {
  const saveSettings = useAssistant((state) => state.saveSettings)
  const [name, setName] = useState(settings.agentName)
  useEffect(() => setName(settings.agentName), [settings.agentName])
  const [instructions, setInstructions] = useState(settings.customInstructions)
  useEffect(() => setInstructions(settings.customInstructions), [settings.customInstructions])
  const [endpoint, setEndpoint] = useState(settings.webSearchEndpoint)
  useEffect(() => setEndpoint(settings.webSearchEndpoint), [settings.webSearchEndpoint])
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const zones = useMemo(() => {
    const list = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [browserZone]
    return list.includes(settings.timezone) ? list : [settings.timezone, ...list]
  }, [browserZone, settings.timezone])
  // The three controls whose only words are the row's title: each id is what turns that title into the
  // control's accessible name rather than a line of text beside it.
  const agentNameId = useId()
  const timezoneId = useId()
  const startViewId = useId()
  const endpointId = useId()
  // Blank is a real answer here — it is how the built-in search tool is switched off — so only a value the
  // route would drop is worth refusing before the request goes out. `searchEndpointValue` is that route's
  // own rule, asked here so an address the worker will not relay to is answered beside this box instead of
  // through a toast over a field that still holds the rejected words.
  const wantedEndpoint = endpoint.trim()
  const endpointUnusable = wantedEndpoint !== '' && searchEndpointValue(wantedEndpoint, '') !== wantedEndpoint
  const endpointProblem = endpointUnusable ? t('assistant.settings.web_search_invalid') : null
  const endpointSaved = wantedEndpoint === settings.webSearchEndpoint

  return (
    <>
      <Group title={t('assistant.settings.identity')}>
        <SettingRow title={t('assistant.settings.agent_name')} description={t('assistant.settings.agent_name_hint')} controlId={agentNameId}>
          <form
            className="flex gap-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              if (name.trim() && name !== settings.agentName) void saveSettings({ agentName: name.trim() })
            }}
          >
            <Input id={agentNameId} value={name} maxLength={60} onChange={(event) => setName(event.target.value)} className="h-8 w-44 text-[length:var(--text-12-5)]" />
            <Button type="submit" size="sm" variant="secondary" disabled={!name.trim() || name === settings.agentName}>
              {t('common.save')}
            </Button>
          </form>
        </SettingRow>
        <SettingRow title={t('assistant.settings.language')} description={t('assistant.settings.language_hint')}>
          <Segmented
            size="sm"
            label={t('assistant.settings.language')}
            value={settings.language}
            onChange={(value) => void saveSettings({ language: value })}
            options={[
              { value: 'en-US', label: t('settings.english') },
              { value: 'zh-CN', label: t('settings.simplified_chinese') },
            ]}
          />
        </SettingRow>
        <SettingRow
          title={t('assistant.settings.timezone')}
          description={settings.timezone !== browserZone
            ? t('assistant.settings.timezone_use_device', { zone: browserZone })
            : t('assistant.settings.timezone_hint')}
          controlId={timezoneId}
        >
          <div className="flex items-center gap-2">
            {settings.timezone !== browserZone && isValidTimeZone(browserZone) && (
              <Button size="sm" variant="ghost" onClick={() => void saveSettings({ timezone: browserZone })}>
                {t('assistant.settings.timezone_detect')}
              </Button>
            )}
            <Select id={timezoneId} value={settings.timezone} onChange={(event) => void saveSettings({ timezone: event.target.value })} className="max-w-[220px]">
              {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
            </Select>
          </div>
        </SettingRow>
      </Group>

      <Group title={t('assistant.settings.behaviour')}>
        <SettingRow title={t('assistant.settings.send_enter')} description={t('assistant.settings.send_enter_hint')}>
          <Switch checked={settings.sendOnEnter} onChange={(value) => void saveSettings({ sendOnEnter: value })} label={t('assistant.settings.send_enter')} />
        </SettingRow>
        <SettingRow title={t('assistant.settings.auto_route')} description={t('assistant.settings.auto_route_hint')}>
          <Switch checked={settings.autoRoute} onChange={(value) => void saveSettings({ autoRoute: value })} label={t('assistant.settings.auto_route')} />
        </SettingRow>
        <SettingRow title={t('assistant.settings.start_view')} description={t('assistant.settings.start_view_hint')} controlId={startViewId}>
          <Select id={startViewId} value={settings.startView} onChange={(event) => void saveSettings({ startView: event.target.value })}>
            <option value="chat">{t('assistant.view.chat')}</option>
            <option value="memory">{t('assistant.view.memory')}</option>
            <option value="tasks">{t('assistant.view.tasks')}</option>
            <option value="automations">{t('assistant.view.automations')}</option>
            <option value="settings">{t('assistant.view.settings')}</option>
          </Select>
        </SettingRow>
      </Group>

      <Group title={t('assistant.settings.custom_instructions')}>
        <div className="flex flex-col gap-2 py-3">
          <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            {t('assistant.settings.custom_instructions_hint')}
          </p>
          <Textarea
            rows={4}
            maxLength={MAX_CUSTOM_INSTRUCTIONS_CHARS}
            aria-label={t('assistant.settings.custom_instructions')}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder={t('assistant.settings.custom_instructions_placeholder')}
          />
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">
              {instructions.length}/{MAX_CUSTOM_INSTRUCTIONS_CHARS}
            </span>
            <Button
              size="sm"
              variant="secondary"
              disabled={instructions.trim() === settings.customInstructions}
              onClick={() => void saveSettings({ customInstructions: instructions.trim() })}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      </Group>

      <Group title={t('assistant.settings.tool_access')}>
        {ASSISTANT_TOOL_PERMISSIONS.map((permission) => (
          <SettingRow
            key={permission}
            title={t(`assistant.settings.tool_access.${permission}` as 'assistant.settings.tool_access.read')}
            description={t(`assistant.settings.tool_access.${permission}_hint` as 'assistant.settings.tool_access.read_hint')}
          >
            <Segmented
              size="sm"
              label={t(`assistant.settings.tool_access.${permission}` as 'assistant.settings.tool_access.read')}
              value={settings.toolModes[permission]}
              onChange={(value) => void saveSettings({ toolModes: { ...settings.toolModes, [permission]: value } })}
              options={ASSISTANT_TOOL_MODES.map((mode) => ({
                value: mode,
                label: t(`assistant.approval.${mode}` as 'assistant.approval.ask'),
              }))}
            />
          </SettingRow>
        ))}
        <SettingRow
          title={t('assistant.settings.web_search')}
          description={t('assistant.settings.web_search_hint')}
          controlId={endpointId}
        >
          <form
            className="flex gap-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              // The rule the route applies, asked before the request: an address the worker will not relay
              // to is answered beside this box rather than as a toast over a field that still shows it.
              if (endpointUnusable || endpointSaved) return
              void saveSettings({ webSearchEndpoint: wantedEndpoint })
            }}
          >
            {/* A plain text box, not `type="url"`: the browser's own constraint validation would swallow
                the submit and answer with its bubble instead of this row's words. */}
            <Input
              id={endpointId}
              value={endpoint}
              inputMode="url"
              spellCheck={false}
              maxLength={MAX_SEARCH_ENDPOINT_CHARS}
              invalid={endpointProblem !== null}
              aria-describedby={endpointProblem !== null ? `${endpointId}-problem` : undefined}
              onChange={(event) => setEndpoint(event.target.value)}
              className="h-8 w-64 font-mono text-[length:var(--text-11)]"
            />
            <Button type="submit" size="sm" variant="secondary" disabled={endpointUnusable || endpointSaved}>
              {t('common.save')}
            </Button>
          </form>
          {endpointProblem !== null && (
            <p id={`${endpointId}-problem`} role="alert" className="mt-1 break-words text-[length:var(--text-11)] text-[var(--danger)]">
              {endpointProblem}
            </p>
          )}
        </SettingRow>
      </Group>
    </>
  )
}
