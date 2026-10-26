import {
  Award,
  Minus,
  Palette,
  Plus,
  Settings,
  Shirt,
  SlidersHorizontal,
} from 'lucide-react'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { useIdPhotoStore, type IdPhotoOptionsTab } from '../store'
import { SpecsTab } from './SpecsTab'
import { ColorTab } from './ColorTab'
import { RetouchTab } from './RetouchTab'
import { AttireTab } from './AttireTab'

const OPTIONS_TABS = [
  { id: 'spec', labelKey: 'tools.id_photo.options.tab_spec', icon: Award },
  { id: 'color', labelKey: 'tools.id_photo.options.tab_color', icon: Palette },
  { id: 'retouch', labelKey: 'tools.id_photo.options.tab_retouch', icon: SlidersHorizontal },
  { id: 'attire', labelKey: 'tools.id_photo.options.tab_attire', icon: Shirt },
] as const

export function IdPhotoOptionsPanel() {
  const isOpen = useIdPhotoStore((s) => s.optionsAccordionOpen)
  const toggleOpen = useIdPhotoStore((s) => s.toggleOptionsAccordion)
  const activeTab = useIdPhotoStore((s) => s.activeOptionsTab)
  const setActiveTab = useIdPhotoStore((s) => s.setActiveOptionsTab)

  return (
    <section
      aria-label={t('tools.id_photo.options.accordion_title')}
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
          isOpen && 'border-b border-[var(--border-subtle)]',
        )}
      >
        <div className="flex items-center gap-2.5">
          <Settings size={18} className="text-[var(--accent)]" />
          <h3 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
            {t('tools.id_photo.options.accordion_title')}
          </h3>
        </div>
        <div className="text-[var(--text-tertiary)]">
          {isOpen ? <Minus size={16} /> : <Plus size={16} />}
        </div>
      </button>

      {isOpen && (
        <div className="flex flex-col gap-4 p-3.5">
          <div
            role="tablist"
            className="flex items-center gap-1 border-b border-[var(--border-subtle)] pb-2 overflow-x-auto"
          >
            {OPTIONS_TABS.map((tab) => {
              const Icon = tab.icon
              const isSelected = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  onClick={() => setActiveTab(tab.id as IdPhotoOptionsTab)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-[var(--r-md)] px-3 py-1.5 text-[length:var(--text-13)] font-medium shrink-0',
                    'transition-[background-color,color] duration-[var(--dur-fast)]',
                    isSelected
                      ? 'border-b-2 border-[var(--accent)] text-[var(--accent)] font-semibold'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]',
                  )}
                >
                  <Icon size={14} />
                  <span>{t(tab.labelKey)}</span>
                </button>
              )
            })}
          </div>

          <div role="tabpanel" className="min-h-0">
            {activeTab === 'spec' && <SpecsTab />}
            {activeTab === 'color' && <ColorTab />}
            {activeTab === 'retouch' && <RetouchTab />}
            {activeTab === 'attire' && <AttireTab />}
          </div>
        </div>
      )}
    </section>
  )
}
