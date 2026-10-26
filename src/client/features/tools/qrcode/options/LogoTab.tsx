import { useRef } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { ONLINE_LOGOS } from '../../../../../shared/tools/qrcode/online-logos'
import type { QrLogoShape } from '../../../../../shared/tools/qrcode/types'
import { useQrCodeStore } from '../store'
import { Field, Segmented, Slider, Switch } from '../../../../components/form'
import { IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'

const LOGO_SHAPES = [
  { value: 'original' as QrLogoShape, labelKey: 'tools.qrcode.logo.shape_original' as const },
  { value: 'rounded' as QrLogoShape, labelKey: 'tools.qrcode.logo.shape_rounded' as const },
  { value: 'circle' as QrLogoShape, labelKey: 'tools.qrcode.logo.shape_circle' as const },
]

export function LogoTab() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const options = useQrCodeStore((s) => s.options)
  const setOptions = useQrCodeStore((s) => s.setOptions)

  const logoOptions = options.logoOptions || {}

  const handleSelectOnlineLogo = (logoId: string) => {
    setOptions({
      logoOptions: {
        ...logoOptions,
        logoId,
        src: undefined,
        dataUrl: undefined,
      },
    })
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      setOptions({
        logoOptions: {
          ...logoOptions,
          logoId: undefined,
          src: result,
          dataUrl: result,
        },
      })
    }
    reader.readAsDataURL(file)
  }

  const handleRemoveLogo = () => {
    setOptions({
      logoOptions: {
        ...logoOptions,
        logoId: undefined,
        src: undefined,
        dataUrl: undefined,
      },
    })
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const hasLogo = Boolean(logoOptions.logoId || logoOptions.src || logoOptions.dataUrl)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.qrcode.logo.online_logos')}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {ONLINE_LOGOS.map((item) => {
            const isSelected = logoOptions.logoId === item.id
            return (
              <button
                key={item.id}
                type="button"
                title={item.name}
                aria-label={item.name}
                data-testid={`logo-preset-${item.id}`}
                onClick={() => handleSelectOnlineLogo(item.id)}
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-[var(--r-md)] border p-1 transition-all',
                  'hover:border-[var(--accent)] hover:bg-[var(--bg-hover)]',
                  isSelected
                    ? 'border-[var(--accent)] ring-1 ring-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-inset)]'
                )}
              >
                <img src={item.dataUrl} alt={item.name} className="h-6 w-6 object-contain" />
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('tools.qrcode.logo.upload_logo')}
          </label>
          {hasLogo && (
            <Tooltip label={t('tools.qrcode.logo.remove_logo')}>
              <IconButton
                size="sm"
                label={t('tools.qrcode.logo.remove_logo')}
                onClick={handleRemoveLogo}
              >
                <Trash2 size={13} className="text-[var(--danger)]" />
              </IconButton>
            </Tooltip>
          )}
        </div>

        <div className="flex items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            className="hidden"
            onChange={handleFileUpload}
          />
          <button
            type="button"
            aria-label={t('tools.qrcode.logo.upload_logo')}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              'flex h-14 w-14 items-center justify-center rounded-[var(--r-md)] border-2 border-dashed border-[var(--border-default)]',
              'transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-hover)]',
              logoOptions.src && 'border-solid border-[var(--accent)] p-1'
            )}
          >
            {logoOptions.src ? (
              <img src={logoOptions.src} alt={t('tools.qrcode.logo.uploaded_alt')} className="h-full w-full object-contain rounded" />
            ) : (
              <Plus size={20} className="text-[var(--text-tertiary)]" />
            )}
          </button>
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('tools.qrcode.logo.upload_tip')}
          </span>
        </div>
      </div>

      <Field label={t('tools.qrcode.logo.shape_label')}>
        <Segmented<QrLogoShape>
          value={logoOptions.shape || 'original'}
          onChange={(shape) => setOptions({ logoOptions: { ...logoOptions, shape } })}
          options={LOGO_SHAPES.map((s) => ({ value: s.value, label: t(s.labelKey) }))}
        />
      </Field>

      <div className="flex items-center justify-between py-1">
        <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.qrcode.logo.shadow_label')}
        </label>
        <Switch
          checked={Boolean(logoOptions.shadow)}
          onChange={(checked) => setOptions({ logoOptions: { ...logoOptions, shadow: checked } })}
        />
      </div>

      <Field label={`${t('tools.qrcode.logo.size_label')}: ${Math.round((logoOptions.size || 0.2) * 100)}%`}>
        <Slider
          value={Math.round((logoOptions.size || 0.2) * 100)}
          min={15}
          max={35}
          onChange={(val) => setOptions({ logoOptions: { ...logoOptions, size: val / 100 } })}
        />
      </Field>
    </div>
  )
}
