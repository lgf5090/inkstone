/**
 * The behaviour tab: what the assistant calls itself, and how it answers.
 */
import { useEffect, useMemo, useState } from 'react'
import { type AssistantSettings } from '@shared/assistant'
import { isValidTimeZone } from '@shared/assistant-schedule'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Input, Segmented, Select, SettingRow, Switch } from '../../components/form'
import { useAssistant } from './assistant-store'
import { Group } from './assistant-settings-shared'

export function BehaviourTab({ settings }: { settings: AssistantSettings }) {
  const saveSettings = useAssistant((state) => state.saveSettings)
  const [name, setName] = useState(settings.agentName)
  useEffect(() => setName(settings.agentName), [settings.agentName])
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const zones = useMemo(() => {
    const list = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [browserZone]
    return list.includes(settings.timezone) ? list : [settings.timezone, ...list]
  }, [browserZone, settings.timezone])

  return (
    <>
      <Group title={t('assistant.settings.identity')}>
        <SettingRow title={t('assistant.settings.agent_name')} description={t('assistant.settings.agent_name_hint')}>
          <form
            className="flex gap-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              if (name.trim() && name !== settings.agentName) void saveSettings({ agentName: name.trim() })
            }}
          >
            <Input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} className="h-8 w-44 text-[length:var(--text-12-5)]" />
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
        >
          <div className="flex items-center gap-2">
            {settings.timezone !== browserZone && isValidTimeZone(browserZone) && (
              <Button size="sm" variant="ghost" onClick={() => void saveSettings({ timezone: browserZone })}>
                {t('assistant.settings.timezone_detect')}
              </Button>
            )}
            <Select value={settings.timezone} onChange={(event) => void saveSettings({ timezone: event.target.value })} className="max-w-[220px]">
              {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
            </Select>
          </div>
        </SettingRow>
      </Group>

      <Group title={t('assistant.settings.behaviour')}>
        <SettingRow title={t('assistant.settings.send_enter')} description={t('assistant.settings.send_enter_hint')}>
          <Switch checked={settings.sendOnEnter} onChange={(value) => void saveSettings({ sendOnEnter: value })} label={t('assistant.settings.send_enter')} />
        </SettingRow>
        <SettingRow title={t('assistant.settings.start_view')} description={t('assistant.settings.start_view_hint')}>
          <Select value={settings.startView} onChange={(event) => void saveSettings({ startView: event.target.value })}>
            <option value="chat">{t('assistant.view.chat')}</option>
            <option value="memory">{t('assistant.view.memory')}</option>
            <option value="tasks">{t('assistant.view.tasks')}</option>
            <option value="automations">{t('assistant.view.automations')}</option>
            <option value="settings">{t('assistant.view.settings')}</option>
          </Select>
        </SettingRow>
      </Group>
    </>
  )
}
