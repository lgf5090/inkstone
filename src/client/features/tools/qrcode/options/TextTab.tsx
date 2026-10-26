import { useQrCodeStore } from '../store'
import { Checkbox, Field, Select, Slider, Textarea } from '../../../../components/form'
import { ColorWheelTrigger } from '../../../../components/color-field'
import { t } from '../../../../lib/i18n'

const FONT_FAMILIES = [
  { value: "'PingFang SC', 'Microsoft YaHei', sans-serif", labelKey: 'tools.qrcode.text.font_heiti' },
  { value: "SimSun, 'Songti SC', serif", labelKey: 'tools.qrcode.text.font_songti' },
  { value: "KaiTi, 'Kaiti SC', serif", labelKey: 'tools.qrcode.text.font_kaiti' },
  { value: 'Inter, sans-serif', labelKey: 'tools.qrcode.text.font_inter' },
  { value: 'Arial, Helvetica, sans-serif', labelKey: 'tools.qrcode.text.font_arial' },
  { value: "'JetBrains Mono', monospace", labelKey: 'tools.qrcode.text.font_mono' },
] as const

export function TextTab() {
  const options = useQrCodeStore((s) => s.options)
  const setOptions = useQrCodeStore((s) => s.setOptions)

  const textOptions = options.textOptions || {
    enabled: false,
    content: '',
    fontSize: 35,
    fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
    bold: true,
    italic: false,
    underline: false,
    color: '#000000',
    position: 'bottom',
  }

  const handleTextChange = (content: string) => {
    setOptions({
      textOptions: {
        ...textOptions,
        enabled: Boolean(content.trim()),
        content,
      },
    })
  }

  return (
    <div className="flex flex-col gap-3.5">
      <Field label={t('tools.qrcode.text.add_text')}>
        <Textarea
          value={textOptions.content || ''}
          onChange={(e) => handleTextChange(e.target.value.slice(0, 200))}
          placeholder={t('tools.qrcode.text.placeholder')}
          rows={3}
          className="resize-none"
        />
        <div className="flex justify-end text-[length:var(--text-11)] text-[var(--text-tertiary)] mt-1">
          <span>{`${(textOptions.content || '').length} / 200`}</span>
        </div>
      </Field>

      <Field label={t('tools.qrcode.text.font_family')}>
        <Select
          value={textOptions.fontFamily || FONT_FAMILIES[0].value}
          onChange={(e) =>
            setOptions({
              textOptions: { ...textOptions, fontFamily: e.target.value },
            })
          }
        >
          {FONT_FAMILIES.map((f) => (
            <option key={f.value} value={f.value}>
              {t(f.labelKey)}
            </option>
          ))}
        </Select>
      </Field>

      <Field label={`${t('tools.qrcode.text.font_size')}: ${textOptions.fontSize || 35}px`}>
        <Slider
          value={textOptions.fontSize || 35}
          min={20}
          max={60}
          onChange={(val) =>
            setOptions({
              textOptions: { ...textOptions, fontSize: val },
            })
          }
        />
      </Field>

      <div className="flex flex-col gap-1.5">
        <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.qrcode.text.styles_label')}
        </label>
        <div className="flex items-center gap-4">
          <Checkbox
            checked={Boolean(textOptions.bold)}
            onChange={(checked) =>
              setOptions({
                textOptions: { ...textOptions, bold: checked },
              })
            }
            label={t('tools.qrcode.text.style_bold')}
          />
          <Checkbox
            checked={Boolean(textOptions.italic)}
            onChange={(checked) =>
              setOptions({
                textOptions: { ...textOptions, italic: checked },
              })
            }
            label={t('tools.qrcode.text.style_italic')}
          />
          <Checkbox
            checked={Boolean(textOptions.underline)}
            onChange={(checked) =>
              setOptions({
                textOptions: { ...textOptions, underline: checked },
              })
            }
            label={t('tools.qrcode.text.style_underline')}
          />
        </div>
      </div>

      <div className="flex items-center justify-between py-1">
        <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.qrcode.text.color_label')}
        </label>
        <ColorWheelTrigger
          value={textOptions.color || '#000000'}
          label={t('tools.qrcode.text.color_label')}
          onChange={(color) =>
            setOptions({
              textOptions: { ...textOptions, color },
            })
          }
          onCommit={(color) =>
            setOptions({
              textOptions: { ...textOptions, color },
            })
          }
        />
      </div>
    </div>
  )
}
