import {
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
import { useQrCodeStore, type BeautifyTab } from '../store'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
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
          <div role="tablist" className="flex items-center gap-1 border-b border-[var(--border-subtle)] pb-2 overflow-x-auto">
            {BEAUTIFY_TABS.map((tab) => {
              const Icon = tab.icon
              const isSelected = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  onClick={() => setActiveTab(tab.id as BeautifyTab)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-[var(--r-md)] px-3 py-1.5 text-[length:var(--text-13)] font-medium shrink-0',
                    'transition-[background-color,color] duration-[var(--dur-fast)]',
                    isSelected
                      ? 'border-b-2 border-[var(--accent)] text-[var(--accent)] font-semibold'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                  )}
                >
                  <Icon size={14} />
                  <span>{t(tab.labelKey)}</span>
                </button>
              )
            })}
          </div>

          <div role="tabpanel" className="min-h-0">
            {activeTab === 'template' && <TemplatesTab />}
            {activeTab === 'shape' && <ShapeTab />}
            {activeTab === 'logo' && <LogoTab />}
            {activeTab === 'text' && <TextTab />}
            {activeTab === 'color' && <ColorTab />}
            {activeTab === 'ai' && <AiEffectsTab />}
          </div>
        </div>
      )}
    </section>
  )
}
