import { useId } from 'react'
import type { AssistantSettings } from '@shared/assistant'
import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Segmented, Select, SettingRow, Slider, Switch } from '../../components/form'
import { useAssistant } from './assistant-store'
import { Group } from './assistant-settings-shared'

/** The switches that change how the interface behaves rather than how the model answers. */
export function OtherTab({ settings }: { settings: AssistantSettings }) {
  const saveSettings = useAssistant((state) => state.saveSettings)
  const startViewId = useId()

  return (
    <>
      <Group title={t('assistant.settings.interaction')}>
        <SettingRow title={t('assistant.settings.send_enter')} description={t('assistant.settings.send_enter_hint')}>
          <Switch checked={settings.sendOnEnter} onChange={(value) => void saveSettings({ sendOnEnter: value })} label={t('assistant.settings.send_enter')} />
        </SettingRow>
        <SettingRow title={t('assistant.settings.mention_mode')} description={t('assistant.settings.mention_mode_hint')}>
          <Segmented
            size="sm"
            label={t('assistant.settings.mention_mode')}
            value={settings.mentionMode}
            onChange={(mentionMode) => void saveSettings({ mentionMode })}
            options={[
              { value: 'full', label: t('assistant.settings.mention_mode.full') },
              { value: 'light', label: t('assistant.settings.mention_mode.light') },
            ]}
          />
        </SettingRow>
        <SettingRow title={t('assistant.settings.chat_scale')} description={t('assistant.settings.chat_scale_hint')}>
          <Slider
            label={t('assistant.settings.chat_scale')}
            value={Math.round(settings.chatScale * 100)}
            min={70}
            max={150}
            step={5}
            suffix="%"
            onChange={(percent) => void saveSettings({ chatScale: percent / 100 })}
          />
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

      <Group title={t('assistant.settings.debug')}>
        <SettingRow title={t('assistant.settings.llm_debug')} description={t('assistant.settings.llm_debug_hint')}>
          <Switch checked={settings.llmDebug} onChange={(llmDebug) => void saveSettings({ llmDebug })} label={t('assistant.settings.llm_debug')} />
        </SettingRow>
        <SettingRow title={t('assistant.settings.reset_interface')} description={t('assistant.settings.reset_interface_hint')}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void saveSettings({
              agentName: DEFAULT_ASSISTANT_SETTINGS.agentName,
              sendOnEnter: DEFAULT_ASSISTANT_SETTINGS.sendOnEnter,
              mentionMode: DEFAULT_ASSISTANT_SETTINGS.mentionMode,
              chatScale: DEFAULT_ASSISTANT_SETTINGS.chatScale,
              autoRoute: DEFAULT_ASSISTANT_SETTINGS.autoRoute,
              startView: DEFAULT_ASSISTANT_SETTINGS.startView,
              notifyChannel: DEFAULT_ASSISTANT_SETTINGS.notifyChannel,
              notifyOnlyUnfocused: DEFAULT_ASSISTANT_SETTINGS.notifyOnlyUnfocused,
              notifyApproval: DEFAULT_ASSISTANT_SETTINGS.notifyApproval,
              notifyFinish: DEFAULT_ASSISTANT_SETTINGS.notifyFinish,
              llmDebug: DEFAULT_ASSISTANT_SETTINGS.llmDebug,
            })}
          >
            {t('assistant.settings.reset_interface')}
          </Button>
        </SettingRow>
      </Group>
    </>
  )
}
