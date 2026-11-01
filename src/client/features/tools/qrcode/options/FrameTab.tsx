import { useQrCodeStore } from '../store'
import type { QrFrameOptions, QrFrameType } from '../../../../../shared/tools/qrcode/types'
import { ColorWellField } from '../../../../components/color-field'
import { Field, Input, Select } from '../../../../components/form'
import { t, type MessageKey } from '../../../../lib/i18n'

/** Matches the length the API accepts for a frame caption. */
const FRAME_LABEL_MAX = 60

const FRAME_TYPES: ReadonlyArray<{ value: QrFrameType; labelKey: MessageKey }> = [
  { value: 'none', labelKey: 'tools.qrcode.frame.type_none' },
  { value: 'dark-green', labelKey: 'tools.qrcode.frame.type_dark_green' },
  { value: 'red-blue', labelKey: 'tools.qrcode.frame.type_red_blue' },
  { value: 'three-color', labelKey: 'tools.qrcode.frame.type_three_color' },
  { value: 'heart', labelKey: 'tools.qrcode.frame.type_heart' },
  { value: 'liquid-stamp', labelKey: 'tools.qrcode.frame.type_liquid_stamp' },
  { value: 'pacman', labelKey: 'tools.qrcode.frame.type_pacman' },
  { value: 'meme-bubble', labelKey: 'tools.qrcode.frame.type_meme_bubble' },
  { value: 'mushroom', labelKey: 'tools.qrcode.frame.type_mushroom' },
]

export function FrameTab() {
  const options = useQrCodeStore((s) => s.options)
  const setOptions = useQrCodeStore((s) => s.setOptions)
  const frame = options.frameOptions ?? { type: 'none' as QrFrameType }
  const patch = (next: Partial<QrFrameOptions>) => setOptions({ frameOptions: { ...frame, ...next } })

  return (
    <div className="flex flex-col gap-4">
      <Field label={t('tools.qrcode.frame.type_label')}>
        <Select
          value={frame.type ?? 'none'}
          onChange={(e) => patch({ type: e.target.value as QrFrameType })}
        >
          {FRAME_TYPES.map((item) => (
            <option key={item.value} value={item.value}>
              {t(item.labelKey)}
            </option>
          ))}
        </Select>
      </Field>

      {frame.type && frame.type !== 'none' && (
        <>
          <Field label={t('tools.qrcode.frame.label')} hint={t('tools.qrcode.frame.label_hint')}>
            <Input
              value={frame.label ?? frame.text ?? ''}
              onChange={(e) => patch({ label: e.target.value.slice(0, FRAME_LABEL_MAX) })}
              placeholder={t('tools.qrcode.frame.label_placeholder')}
            />
          </Field>

          <div className="flex items-center justify-between py-1">
            <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {t('tools.qrcode.frame.color_main')}
            </span>
            <ColorWellField
              value={frame.color || '#1b4332'}
              label={t('tools.qrcode.frame.color_main')}
              onChange={(color) => patch({ color })}
            />
          </div>

          <div className="flex items-center justify-between py-1">
            <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {t('tools.qrcode.frame.color_secondary')}
            </span>
            <ColorWellField
              value={frame.secondaryColor || '#d4af37'}
              label={t('tools.qrcode.frame.color_secondary')}
              onChange={(secondaryColor) => patch({ secondaryColor })}
            />
          </div>
        </>
      )}
    </div>
  )
}
