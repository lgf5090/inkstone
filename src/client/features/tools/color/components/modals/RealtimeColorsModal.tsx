import { useState } from 'react'
import { CheckCircle2, Layout, Moon, Sparkles, Sun } from 'lucide-react'
import { getContrastRatio } from '@shared/tools/color/a11y'
import { Modal } from '../../../../../components/overlay'
import { Button } from '../../../../../components/primitives'
import { t } from '../../../../../lib/i18n'
import { useColorStudioStore } from '../../store'

export function RealtimeColorsModal() {
  const isOpen = useColorStudioStore((s) => s.isRealtimeColorsModalOpen)
  const onClose = useColorStudioStore((s) => s.closeRealtimeColorsModal)
  const currentHex = useColorStudioStore((s) => s.currentHex)

  const [isDarkMode, setIsDarkMode] = useState(false)

  // Determine text color on brand button
  const contrastWithWhite = getContrastRatio(currentHex, '#ffffff')
  const brandButtonTextColor = contrastWithWhite >= 4.5 ? '#ffffff' : '#000000'

  const bgCanvas = isDarkMode ? '#121214' : '#f8fafc'
  const cardBg = isDarkMode ? '#1e1e24' : '#ffffff'
  const textColor = isDarkMode ? '#f1f5f9' : '#0f172a'
  const textMuted = isDarkMode ? '#94a3b8' : '#64748b'
  const borderColor = isDarkMode ? '#2d2d38' : '#e2e8f0'

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={t('tools.color.realtime.title')}
      width={720}
      footer={
        <div className="flex w-full items-center justify-between">
          <button
            type="button"
            onClick={() => setIsDarkMode((d) => !d)}
            className="flex items-center gap-1.5 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            {isDarkMode ? <Sun size={14} /> : <Moon size={14} />}
            {t('tools.color.realtime.toggle_canvas')}
          </button>
          <Button size="sm" variant="primary" onClick={onClose}>
            {t('tools.color.common.done')}
          </Button>
        </div>
      }
    >
      <div
        className="rounded-[var(--radius-xl)] border p-6 transition-colors shadow-inner space-y-6"
        style={{
          backgroundColor: bgCanvas,
          color: textColor,
          borderColor,
        }}
      >
        {/* Mock Navigation Bar */}
        <div
          className="flex items-center justify-between rounded-[var(--radius-lg)] border px-4 py-3 shadow-xs"
          style={{ backgroundColor: cardBg, borderColor }}
        >
          <div className="flex items-center gap-2">
            <div
              className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] shadow-xs"
              style={{ backgroundColor: currentHex }}
            >
              <Layout size={16} style={{ color: brandButtonTextColor }} />
            </div>
            <span className="font-bold text-[length:var(--text-14)]">
              {t('tools.color.realtime.brand_title')}
            </span>
          </div>

          <div className="hidden sm:flex items-center gap-4 text-[length:var(--text-12)] font-medium" style={{ color: textMuted }}>
            <span>{t('tools.color.realtime.nav_products')}</span>
            <span>{t('tools.color.realtime.nav_solutions')}</span>
            <span>{t('tools.color.realtime.nav_docs')}</span>
          </div>

          <button
            type="button"
            className="rounded-[var(--radius-sm)] px-3 py-1.5 text-[length:var(--text-12)] font-semibold shadow-xs transition-opacity hover:opacity-90"
            style={{
              backgroundColor: currentHex,
              color: brandButtonTextColor,
            }}
          >
            {t('tools.color.realtime.cta_primary')}
          </button>
        </div>

        {/* Hero Section */}
        <div className="py-6 text-center space-y-3">
          <div
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[length:var(--text-11)] font-semibold border"
            style={{
              borderColor: currentHex,
              backgroundColor: `${currentHex}15`,
              color: currentHex,
            }}
          >
            <Sparkles size={12} />
            <span>{t('tools.color.realtime.badge')}</span>
          </div>

          <h3 className="text-[length:var(--text-26)] font-extrabold tracking-tight">
            {t('tools.color.realtime.hero_title')}
          </h3>
          <p className="max-w-md mx-auto text-[length:var(--text-13)]" style={{ color: textMuted }}>
            {t('tools.color.realtime.hero_desc')}
          </p>

          <div className="pt-2 flex items-center justify-center gap-3">
            <button
              type="button"
              className="rounded-[var(--radius-md)] px-4 py-2 text-[length:var(--text-13)] font-semibold shadow-md transition-opacity hover:opacity-90"
              style={{
                backgroundColor: currentHex,
                color: brandButtonTextColor,
              }}
            >
              {t('tools.color.realtime.hero_action')}
            </button>
            <button
              type="button"
              className="rounded-[var(--radius-md)] border px-4 py-2 text-[length:var(--text-13)] font-semibold transition-colors"
              style={{
                borderColor,
                backgroundColor: cardBg,
                color: textColor,
              }}
            >
              {t('tools.color.realtime.hero_learn_more')}
            </button>
          </div>
        </div>

        {/* Feature Cards Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
          {[
            { title: t('tools.color.studio.harmonies'), desc: t('tools.color.algorithm.subtitle') },
            { title: t('tools.color.contrast.title'), desc: t('tools.color.contrast.body_preview') },
            { title: t('tools.color.gradient.title'), desc: t('tools.color.gradient.subtitle') },
          ].map((item, idx) => (
            <div
              key={idx}
              className="rounded-[var(--radius-lg)] border p-4 shadow-xs space-y-2"
              style={{ backgroundColor: cardBg, borderColor }}
            >
              <div
                className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)]"
                style={{
                  backgroundColor: `${currentHex}20`,
                  color: currentHex,
                }}
              >
                <CheckCircle2 size={16} />
              </div>
              <h5 className="font-bold text-[length:var(--text-13)]">{item.title}</h5>
              <p className="text-[length:var(--text-11)] line-clamp-2" style={{ color: textMuted }}>
                {item.desc}
              </p>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}
