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
import { Tabs } from '../../../../components/tabs'
import { t } from '../../../../lib/i18n'
import { useIdPhotoStore } from '../store'
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
          <Tabs
            label={t('tools.id_photo.options.accordion_title')}
            value={activeTab}
            onChange={setActiveTab}
            panelId="id-photo-options-panel"
            className="border-b border-[var(--border-subtle)] pb-2"
            items={OPTIONS_TABS.map((tab) => ({
              id: tab.id,
              label: (
                <>
                  <tab.icon size={14} />
                  <span>{t(tab.labelKey)}</span>
                </>
              ),
            }))}
          />

          <div id="id-photo-options-panel" role="tabpanel" tabIndex={0} className="min-h-0">
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
