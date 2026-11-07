import { Modal } from '../../components/overlay'
import { Button } from '../../components/primitives'
import { Field, Segmented, Slider } from '../../components/form'
import { t } from '../../lib/i18n'
import type { MessageKey } from '@shared/locales/en-US'
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  type TerminalSettings,
  type TerminalThemeId,
} from './prefs'

const THEME_OPTIONS: readonly { value: TerminalThemeId; labelKey: MessageKey }[] = [
  { value: 'follow', labelKey: 'webssh.settings.theme_follow' },
  { value: 'dark', labelKey: 'webssh.settings.theme_dark' },
  { value: 'light', labelKey: 'webssh.settings.theme_light' },
]

export function TerminalSettingsDialog({
  open,
  onClose,
  settings,
  onChange,
}: {
  open: boolean
  onClose: () => void
  settings: TerminalSettings
  onChange: (next: TerminalSettings) => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('webssh.settings.title')}
      width={440}
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="space-y-5">
        <Field label={t('webssh.settings.theme')}>
          <Segmented
            value={settings.theme}
            options={THEME_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
            onChange={(theme) => onChange({ ...settings, theme })}
            label={t('webssh.settings.theme')}
          />
        </Field>
        <Field label={t('webssh.settings.font_size')} hint={t('webssh.settings.font_size_hint')}>
          <Slider
            value={settings.fontSize}
            min={TERMINAL_FONT_SIZE_MIN}
            max={TERMINAL_FONT_SIZE_MAX}
            onChange={(fontSize) => onChange({ ...settings, fontSize })}
            label={t('webssh.settings.font_size')}
            suffix="px"
            immediate
          />
        </Field>
      </div>
    </Modal>
  )
}
