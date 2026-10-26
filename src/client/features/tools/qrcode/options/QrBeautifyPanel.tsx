import {
  Image as ImageIcon,
  Minus,
  Palette,
  Plus,
  Settings,
  Shapes,
  Sparkles,
  Type,
} from 'lucide-react'
import { useQrCodeStore, type BeautifyTab } from '../store'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { TemplatesTab } from './TemplatesTab'
import { ShapeTab } from './ShapeTab'
import { LogoTab } from './LogoTab'
import { TextTab } from './TextTab'
import { ColorTab } from './ColorTab'

const BEAUTIFY_TABS = [
  { id: 'template', labelKey: 'tools.qrcode.beautify.tab_template', icon: Sparkles },
  { id: 'shape', labelKey: 'tools.qrcode.beautify.tab_shape', icon: Shapes },
  { id: 'logo', labelKey: 'tools.qrcode.beautify.tab_logo', icon: ImageIcon },
  { id: 'text', labelKey: 'tools.qrcode.beautify.tab_text', icon: Type },
  { id: 'color', labelKey: 'tools.qrcode.beautify.tab_color', icon: Palette },
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
      <header
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        onClick={toggleOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggleOpen()
          }
        }}
        className={cn(
          'flex h-12 cursor-pointer items-center justify-between px-3.5 select-none',
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
      </header>

      {isOpen && (
        <div className="flex flex-col gap-4 p-3.5">
          <div className="flex items-center gap-1 border-b border-[var(--border-subtle)] pb-2 overflow-x-auto">
            {BEAUTIFY_TABS.map((tab) => {
              const Icon = tab.icon
              const isSelected = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
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

          <div className="min-h-0">
            {activeTab === 'template' && <TemplatesTab />}
            {activeTab === 'shape' && <ShapeTab />}
            {activeTab === 'logo' && <LogoTab />}
            {activeTab === 'text' && <TextTab />}
            {activeTab === 'color' && <ColorTab />}
          </div>
        </div>
      )}
    </section>
  )
}
