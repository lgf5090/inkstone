import {
  Frame,
  Image as ImageIcon,
  Minus,
  Palette,
  Plus,
  Settings,
  Shapes,
  Sparkles,
  Type,
  Wand2,
} from 'lucide-react'
import { useQrCodeStore } from '../store'
import { cn } from '../../../../lib/cn'
import { Tabs } from '../../../../components/tabs'
import { t } from '../../../../lib/i18n'
import { FrameTab } from './FrameTab'
import { TemplatesTab } from './TemplatesTab'
import { ShapeTab } from './ShapeTab'
import { LogoTab } from './LogoTab'
import { TextTab } from './TextTab'
import { ColorTab } from './ColorTab'
import { AiEffectsTab } from './AiEffectsTab'

const BEAUTIFY_TABS = [
  { id: 'template', labelKey: 'tools.qrcode.beautify.tab_template', icon: Sparkles },
  { id: 'shape', labelKey: 'tools.qrcode.beautify.tab_shape', icon: Shapes },
  { id: 'logo', labelKey: 'tools.qrcode.beautify.tab_logo', icon: ImageIcon },
  { id: 'frame', labelKey: 'tools.qrcode.beautify.tab_frame', icon: Frame },
  { id: 'text', labelKey: 'tools.qrcode.beautify.tab_text', icon: Type },
  { id: 'color', labelKey: 'tools.qrcode.beautify.tab_color', icon: Palette },
  { id: 'ai', labelKey: 'tools.qrcode.beautify.tab_ai', icon: Wand2 },
] as const

export function QrBeautifyPanel() {
  const isOpen = useQrCodeStore((s) => s.beautifyAccordionOpen)
  const toggleOpen = useQrCodeStore((s) => s.toggleBeautifyAccordion)
  const activeTab = useQrCodeStore((s) => s.activeBeautifyTab)
  const setActiveTab = useQrCodeStore((s) => s.setActiveBeautifyTab)

  return (
    <section
      aria-label={t('tools.qrcode.beautify.accordion_title')}
      className="flex flex-col rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] shadow-sm"
    >
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={toggleOpen}
        className={cn(
          'flex h-12 w-full items-center justify-between px-3.5 select-none text-left',
          'transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
          'hover:bg-[var(--bg-hover)]',
          isOpen && 'border-b border-[var(--border-subtle)]'
        )}
      >
        <div className="flex items-center gap-2.5">
          <Settings size={18} className="text-[var(--accent)]" />
          <h3 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
            {t('tools.qrcode.beautify.accordion_title')}
          </h3>
        </div>
        <div className="text-[var(--text-tertiary)]">
          {isOpen ? <Minus size={16} /> : <Plus size={16} />}
        </div>
      </button>

      {isOpen && (
        <div className="flex flex-col gap-4 p-3.5">
          <Tabs
            panelId="qr-beautify-panel"
            label={t('tools.qrcode.beautify.accordion_title')}
            value={activeTab}
            onChange={(next) => setActiveTab(next)}
            items={BEAUTIFY_TABS.map((tab) => {
              const Icon = tab.icon
              return {
                id: tab.id,
                label: (
                  <>
                    <Icon size={14} />
                    <span>{t(tab.labelKey)}</span>
                  </>
                ),
              }
            })}
          />

          <div
            id="qr-beautify-panel"
            role="tabpanel"
            aria-labelledby={`qr-beautify-panel-tab-${activeTab}`}
            tabIndex={0}
            className="min-h-0"
          >
            {activeTab === 'template' && <TemplatesTab />}
            {activeTab === 'shape' && <ShapeTab />}
            {activeTab === 'logo' && <LogoTab />}
            {activeTab === 'frame' && <FrameTab />}
            {activeTab === 'text' && <TextTab />}
            {activeTab === 'color' && <ColorTab />}
            {activeTab === 'ai' && <AiEffectsTab />}
          </div>
        </div>
      )}
    </section>
  )
}
