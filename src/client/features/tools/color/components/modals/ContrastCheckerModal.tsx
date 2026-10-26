import { useState } from 'react'
import { ArrowLeftRight, CheckCircle2, XCircle } from 'lucide-react'
import { evaluateWcagContrast } from '@shared/tools/color/a11y'
import { Modal } from '../../../../../components/overlay'
import { Button } from '../../../../../components/primitives'
import { t } from '../../../../../lib/i18n'
import { useColorStudioStore } from '../../store'

export function ContrastCheckerModal() {
  const isOpen = useColorStudioStore((s) => s.isContrastModalOpen)
  const onClose = useColorStudioStore((s) => s.closeContrastModal)
  const currentHex = useColorStudioStore((s) => s.currentHex)

  const [fgColor, setFgColor] = useState<string>('#ffffff')
  const [bgColor, setBgColor] = useState<string>(currentHex || '#627486')

  const result = evaluateWcagContrast(fgColor, bgColor)

  const handleSwap = () => {
    const temp = fgColor
    setFgColor(bgColor)
    setBgColor(temp)
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={t('tools.color.contrast.title')}
      width={640}
      footer={
        <div className="flex w-full items-center justify-end">
          <Button size="sm" variant="primary" onClick={onClose}>
            {t('tools.color.common.done')}
          </Button>
        </div>
      }
    >
      <div className="space-y-6">
        {/* Color Selectors & Swap */}
        <div className="grid grid-cols-1 sm:grid-cols-11 gap-3 items-center">
          {/* Foreground */}
          <div className="sm:col-span-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
            <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {t('tools.color.contrast.foreground')}
            </span>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="color"
                value={fgColor}
                onChange={(e) => setFgColor(e.target.value)}
                className="h-8 w-8 cursor-pointer rounded-[var(--radius-xs)] border-0 bg-transparent"
              />
              <input
                type="text"
                value={fgColor}
                onChange={(e) => setFgColor(e.target.value)}
                className="flex-1 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1 font-mono text-[length:var(--text-13)] uppercase text-[var(--text-primary)]"
              />
            </div>
            <div className="mt-2 flex gap-1.5">
              <button
                type="button"
                onClick={() => setFgColor('#ffffff')}
                className="text-[length:var(--text-11)] px-2 py-0.5 rounded-sm bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)]"
              >
                {t('tools.color.common.white')}
              </button>
              <button
                type="button"
                onClick={() => setFgColor('#000000')}
                className="text-[length:var(--text-11)] px-2 py-0.5 rounded-sm bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)]"
              >
                {t('tools.color.common.black')}
              </button>
              <button
                type="button"
                onClick={() => setFgColor(currentHex)}
                className="text-[length:var(--text-11)] px-2 py-0.5 rounded-sm bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)]"
              >
                {t('tools.color.common.current_hex')}
              </button>
            </div>
          </div>

          {/* Swap Button */}
          <div className="sm:col-span-1 flex justify-center">
            <button
              type="button"
              onClick={handleSwap}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors"
              title={t('tools.color.contrast.swap_tooltip')}
              aria-label={t('tools.color.contrast.swap_aria')}
            >
              <ArrowLeftRight size={14} />
            </button>
          </div>

          {/* Background */}
          <div className="sm:col-span-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
            <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {t('tools.color.contrast.background')}
            </span>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="color"
                value={bgColor}
                onChange={(e) => setBgColor(e.target.value)}
                className="h-8 w-8 cursor-pointer rounded-[var(--radius-xs)] border-0 bg-transparent"
              />
              <input
                type="text"
                value={bgColor}
                onChange={(e) => setBgColor(e.target.value)}
                className="flex-1 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1 font-mono text-[length:var(--text-13)] uppercase text-[var(--text-primary)]"
              />
            </div>
            <div className="mt-2 flex gap-1.5">
              <button
                type="button"
                onClick={() => setBgColor('#ffffff')}
                className="text-[length:var(--text-11)] px-2 py-0.5 rounded-sm bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)]"
              >
                {t('tools.color.common.white')}
              </button>
              <button
                type="button"
                onClick={() => setBgColor('#18181b')}
                className="text-[length:var(--text-11)] px-2 py-0.5 rounded-sm bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)]"
              >
                {t('tools.color.common.dark')}
              </button>
              <button
                type="button"
                onClick={() => setBgColor(currentHex)}
                className="text-[length:var(--text-11)] px-2 py-0.5 rounded-sm bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)]"
              >
                {t('tools.color.common.current_hex')}
              </button>
            </div>
          </div>
        </div>

        {/* Contrast Score Hero */}
        <div className="flex items-center justify-between rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 shadow-xs">
          <div>
            <span className="text-[length:var(--text-12)] text-[var(--text-secondary)] uppercase font-semibold">
              {t('tools.color.contrast.ratio')}
            </span>
            <p className="font-mono text-[length:var(--text-30)] font-bold text-[var(--text-primary)]">
              {result.ratio} {': 1'}
            </p>
          </div>
          <div
            className={`flex items-center px-4 py-2 rounded-full font-bold text-[length:var(--text-16)] ${
              result.score === 'AAA'
                ? 'bg-[var(--bg-surface)] text-[var(--success)] border border-[var(--border-subtle)]'
                : result.score === 'AA'
                  ? 'bg-[var(--bg-surface)] text-[var(--warning)] border border-[var(--border-subtle)]'
                  : 'bg-[var(--danger-soft)] text-[var(--danger)] border border-[var(--danger-soft)]'
            }`}
          >
            {result.score === 'Fail' ? 'Fail' : `WCAG ${result.score}`}
          </div>
        </div>

        {/* Badges Matrix */}
        <div className="grid grid-cols-3 gap-2.5">
          {/* Normal Text */}
          <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
            <span className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
              {t('tools.color.contrast.normal_text')}
            </span>
            <div className="mt-2 space-y-1 text-[length:var(--text-11)]">
              <div className="flex items-center justify-between">
                <span>{'AA (≥ 4.5:1)'}</span>
                {result.normalAa ? (
                  <CheckCircle2 size={14} className="text-[var(--success)]" />
                ) : (
                  <XCircle size={14} className="text-[var(--danger)]" />
                )}
              </div>
              <div className="flex items-center justify-between">
                <span>{'AAA (≥ 7.0:1)'}</span>
                {result.normalAaa ? (
                  <CheckCircle2 size={14} className="text-[var(--success)]" />
                ) : (
                  <XCircle size={14} className="text-[var(--danger)]" />
                )}
              </div>
            </div>
          </div>

          {/* Large Text */}
          <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
            <span className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
              {t('tools.color.contrast.large_text')}
            </span>
            <div className="mt-2 space-y-1 text-[length:var(--text-11)]">
              <div className="flex items-center justify-between">
                <span>{'AA (≥ 3.0:1)'}</span>
                {result.largeAa ? (
                  <CheckCircle2 size={14} className="text-[var(--success)]" />
                ) : (
                  <XCircle size={14} className="text-[var(--danger)]" />
                )}
              </div>
              <div className="flex items-center justify-between">
                <span>{'AAA (≥ 4.5:1)'}</span>
                {result.largeAaa ? (
                  <CheckCircle2 size={14} className="text-[var(--success)]" />
                ) : (
                  <XCircle size={14} className="text-[var(--danger)]" />
                )}
              </div>
            </div>
          </div>

          {/* UI Components */}
          <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
            <span className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
              {t('tools.color.contrast.ui_components')}
            </span>
            <div className="mt-2 space-y-1 text-[length:var(--text-11)]">
              <div className="flex items-center justify-between">
                <span>{'AA (≥ 3.0:1)'}</span>
                {result.uiComponents ? (
                  <CheckCircle2 size={14} className="text-[var(--success)]" />
                ) : (
                  <XCircle size={14} className="text-[var(--danger)]" />
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Live Preview Card */}
        <div
          className="rounded-[var(--radius-lg)] p-5 border border-black/10 transition-colors shadow-inner"
          style={{ backgroundColor: bgColor, color: fgColor }}
        >
          <h4 className="text-[length:var(--text-18)] font-bold">
            {t('tools.color.contrast.heading_preview')}
          </h4>
          <p className="mt-2 text-[length:var(--text-14)] leading-relaxed opacity-95">
            {t('tools.color.contrast.body_preview')}
          </p>
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              className="rounded-md px-3.5 py-1.5 text-[length:var(--text-13)] font-semibold border"
              style={{
                borderColor: fgColor,
                backgroundColor: 'transparent',
                color: fgColor,
              }}
            >
              {t('tools.color.contrast.button_preview')}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
