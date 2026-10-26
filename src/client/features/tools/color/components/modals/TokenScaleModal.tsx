import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import {
  formatAsCssVariables,
  formatAsTailwindConfig,
  generateTokenScale,
} from '@shared/tools/color/token-scale'
import { Modal } from '../../../../../components/overlay'
import { Button } from '../../../../../components/primitives'
import { t } from '../../../../../lib/i18n'
import { useUi } from '../../../../../store/ui'
import { useColorStudioStore } from '../../store'

export function TokenScaleModal() {
  const isOpen = useColorStudioStore((s) => s.isTokenScaleModalOpen)
  const onClose = useColorStudioStore((s) => s.closeTokenScaleModal)
  const currentHex = useColorStudioStore((s) => s.currentHex)
  const copyColor = useColorStudioStore((s) => s.copyColor)

  const [copiedType, setCopiedType] = useState<'tailwind' | 'css' | null>(null)

  const scaleItems = generateTokenScale(currentHex)

  const handleCopyTailwind = async () => {
    const code = formatAsTailwindConfig('primary', scaleItems)
    try {
      await navigator.clipboard.writeText(code)
      setCopiedType('tailwind')
      useUi.getState().toast({
        title: t('tools.color.toast.copied', {
          label: 'Tailwind Config',
          value: 'primary: { 50..950 }',
        }),
        tone: 'success',
      })
      setTimeout(() => setCopiedType(null), 2000)
    } catch {
      useUi.getState().toast({
        title: t('tools.color.toast.copy_failed'),
        tone: 'danger',
      })
    }
  }

  const handleCopyCssVars = async () => {
    const code = formatAsCssVariables('primary', scaleItems)
    try {
      await navigator.clipboard.writeText(code)
      setCopiedType('css')
      useUi.getState().toast({
        title: t('tools.color.toast.copied', {
          label: 'CSS Variables',
          value: '--color-primary-50..950',
        }),
        tone: 'success',
      })
      setTimeout(() => setCopiedType(null), 2000)
    } catch {
      useUi.getState().toast({
        title: t('tools.color.toast.copy_failed'),
        tone: 'danger',
      })
    }
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={t('tools.color.token.title')}
      width={720}
      footer={
        <div className="flex w-full items-center justify-between">
          <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)] font-mono">
            {t('tools.color.token.seed_color', { hex: currentHex })}
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={handleCopyTailwind}>
              {copiedType === 'tailwind' ? (
                <Check size={14} className="mr-1 text-[var(--success)]" />
              ) : (
                <Copy size={14} className="mr-1" />
              )}
              {t('tools.color.token.copy_tailwind')}
            </Button>
            <Button size="sm" variant="secondary" onClick={handleCopyCssVars}>
              {copiedType === 'css' ? (
                <Check size={14} className="mr-1 text-[var(--success)]" />
              ) : (
                <Copy size={14} className="mr-1" />
              )}
              {t('tools.color.token.copy_css_vars')}
            </Button>
            <Button size="sm" variant="primary" onClick={onClose}>
              {t('tools.color.common.done')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-[length:var(--text-13)] text-[var(--text-secondary)]">
          {t('tools.color.token.subtitle')}
        </p>

        {/* 11-step scale grid */}
        <div className="grid grid-cols-11 gap-1.5 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] p-2 bg-[var(--bg-sunken)]">
          {scaleItems.map((item) => (
            <button
              key={item.step}
              type="button"
              onClick={() => copyColor(item.hex, `Step ${item.step}`)}
              className="group flex flex-col items-center overflow-hidden rounded-[var(--radius-md)] p-1 text-center transition-transform hover:scale-105 focus:outline-none"
              title={`Click to copy: ${item.hex}`}
            >
              <div
                className="h-16 w-full rounded-[var(--radius-sm)] shadow-xs flex items-center justify-center font-mono text-[length:var(--text-10)] font-bold transition-opacity"
                style={{
                  backgroundColor: item.hex,
                  color: item.textRecommended,
                }}
              >
                <span className="opacity-0 group-hover:opacity-100">{item.step}</span>
              </div>
              <span className="mt-1 font-mono text-[length:var(--text-10)] font-bold text-[var(--text-primary)]">
                {item.step}
              </span>
              <span className="font-mono text-[length:var(--text-9)] text-[var(--text-secondary)] uppercase">
                {item.hex}
              </span>
            </button>
          ))}
        </div>

        {/* Step details table */}
        <div className="max-h-60 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
          <table className="w-full text-left text-[length:var(--text-12)]">
            <thead className="bg-[var(--bg-sunken)] text-[var(--text-tertiary)] uppercase font-semibold text-[length:var(--text-11)] sticky top-0">
              <tr>
                <th className="px-3 py-2">{t('tools.color.common.step')}</th>
                <th className="px-3 py-2">{t('tools.color.common.swatch')}</th>
                <th className="px-3 py-2">{t('tools.color.common.hex')}</th>
                <th className="px-3 py-2">{t('tools.color.common.rgb')}</th>
                <th className="px-3 py-2">{t('tools.color.common.contrast_white')}</th>
                <th className="px-3 py-2">{t('tools.color.common.contrast_black')}</th>
                <th className="px-3 py-2 text-right">{t('tools.color.common.action')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono">
              {scaleItems.map((item) => (
                <tr key={item.step} className="hover:bg-[var(--bg-raised)] transition-colors">
                  <td className="px-3 py-1.5 font-bold text-[var(--text-primary)]">{item.step}</td>
                  <td className="px-3 py-1.5">
                    <div
                      className="h-5 w-8 rounded-[var(--radius-xs)] border border-black/10"
                      style={{ backgroundColor: item.hex }}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-[var(--text-primary)] uppercase">{item.hex}</td>
                  <td className="px-3 py-1.5 text-[var(--text-secondary)]">
                    {item.rgb.r}, {item.rgb.g}, {item.rgb.b}
                  </td>
                  <td className="px-3 py-1.5 text-[var(--text-secondary)]">
                    {item.contrastWhite}{':1'}
                  </td>
                  <td className="px-3 py-1.5 text-[var(--text-secondary)]">
                    {item.contrastBlack}{':1'}
                  </td>
                  <td className="px-3 py-1.5 text-right font-sans">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => copyColor(item.hex, `Step ${item.step}`)}
                    >
                      {t('tools.color.common.copy')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  )
}
