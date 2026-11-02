import { useEffect, useState } from 'react'
import type { AssistantSettings } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Input, Select, SettingRow, Slider, Switch } from '../../components/form'
import { useAssistant } from './assistant-store'
import { CursorCommandsSection } from './CursorCommandsSection'
import { Group } from './assistant-settings-shared'

export function WritingTab({ settings }: { settings: AssistantSettings }) {
  const saveSettings = useAssistant((state) => state.saveSettings)
  const models = useAssistant((state) => state.models)
  const chatModels = models.filter((model) => model.enabled && model.purpose === 'chat')
  const [completionConstraint, setCompletionConstraint] = useState(settings.tabCompletionConstraint)
  useEffect(() => setCompletionConstraint(settings.tabCompletionConstraint), [settings.tabCompletionConstraint])
  const [quickAskTrigger, setQuickAskTrigger] = useState(settings.quickAskTrigger)
  useEffect(() => setQuickAskTrigger(settings.quickAskTrigger), [settings.quickAskTrigger])

  return (
    <>
      <Group title={t('assistant.settings.writing_assist')}>
        <SettingRow title={t('assistant.settings.tab_completion')} description={t('assistant.settings.tab_completion_hint')}>
          <Switch
            checked={settings.tabCompletionEnabled}
            label={t('assistant.settings.tab_completion')}
            onChange={(tabCompletionEnabled) => void saveSettings({ tabCompletionEnabled })}
          />
        </SettingRow>
        <SettingRow title={t('assistant.settings.completion_model')} description={t('assistant.settings.completion_model_hint')}>
          <Select
            aria-label={t('assistant.settings.completion_model')}
            value={settings.tabCompletionModelId ?? ''}
            onChange={(event) => void saveSettings({ tabCompletionModelId: event.target.value || null })}
          >
            <option value="">{t('assistant.settings.naming_model_follow')}</option>
            {chatModels.map((model) => <option key={model.id} value={model.id}>{model.label || model.model}</option>)}
          </Select>
        </SettingRow>
        <SettingRow title={t('assistant.settings.completion_constraint')} description={t('assistant.settings.completion_constraint_hint')}>
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              void saveSettings({ tabCompletionConstraint: completionConstraint })
            }}
          >
            <Input
              aria-label={t('assistant.settings.completion_constraint')}
              value={completionConstraint}
              maxLength={1000}
              onChange={(event) => setCompletionConstraint(event.target.value)}
              className="h-8 w-56 text-[length:var(--text-12)]"
            />
            <Button type="submit" size="sm" variant="secondary" disabled={completionConstraint === settings.tabCompletionConstraint}>
              {t('common.save')}
            </Button>
          </form>
        </SettingRow>
      </Group>

      <Group title={t('assistant.settings.quick_ask')}>
        <SettingRow title={t('assistant.settings.quick_ask')} description={t('assistant.settings.quick_ask_hint')}>
          <Switch
            checked={settings.quickAskEnabled}
            label={t('assistant.settings.quick_ask')}
            onChange={(quickAskEnabled) => void saveSettings({ quickAskEnabled })}
          />
        </SettingRow>
        {settings.quickAskEnabled && (
          <SettingRow title={t('assistant.settings.quick_ask_trigger')} description={t('assistant.settings.quick_ask_trigger_hint')}>
            <form
              className="flex items-center gap-1.5"
              onSubmit={(event) => {
                event.preventDefault()
                const trigger = quickAskTrigger.trim()
                if (trigger && trigger.length <= 3) void saveSettings({ quickAskTrigger: trigger })
              }}
            >
              <Input
                aria-label={t('assistant.settings.quick_ask_trigger')}
                value={quickAskTrigger}
                maxLength={3}
                onChange={(event) => setQuickAskTrigger(event.target.value)}
                className="h-8 w-16 text-center font-mono text-[length:var(--text-12)]"
              />
              <Button type="submit" size="sm" variant="secondary" disabled={!quickAskTrigger.trim() || quickAskTrigger.trim().length > 3 || quickAskTrigger === settings.quickAskTrigger}>
                {t('common.save')}
              </Button>
            </form>
          </SettingRow>
        )}
      </Group>

      <Group title={t('assistant.settings.image_compress')}>
        <SettingRow title={t('assistant.settings.keep_quoted_highlight')} description={t('assistant.settings.keep_quoted_highlight_hint')}>
          <Switch
            checked={settings.keepQuotedHighlight}
            label={t('assistant.settings.keep_quoted_highlight')}
            onChange={(keepQuotedHighlight) => void saveSettings({ keepQuotedHighlight })}
          />
        </SettingRow>
        <SettingRow title={t('assistant.settings.image_compress')} description={t('assistant.settings.image_compress_hint')}>
          <Switch
            checked={settings.imageCompressEnabled}
            label={t('assistant.settings.image_compress')}
            onChange={(imageCompressEnabled) => void saveSettings({ imageCompressEnabled })}
          />
        </SettingRow>
        {settings.imageCompressEnabled && (
          <SettingRow title={t('assistant.settings.image_quality')} description={t('assistant.settings.image_quality_hint')}>
            <Slider
              label={t('assistant.settings.image_quality')}
              value={settings.imageCompressQuality}
              min={30}
              max={100}
              step={5}
              onChange={(imageCompressQuality) => void saveSettings({ imageCompressQuality })}
            />
          </SettingRow>
        )}
      </Group>

      <Group title={t('assistant.cursor_commands.title')}>
        <CursorCommandsSection />
      </Group>
    </>
  )
}
