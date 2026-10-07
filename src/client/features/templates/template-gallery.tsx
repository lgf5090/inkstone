import { createPortal } from 'react-dom'
import { Menu } from '../../components/overlay'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { useGalleryController } from './gallery-controller'
import { GalleryHeader } from './gallery-header'
import { GalleryMain, GalleryModals, GalleryMobileChips, GallerySelectBar, GallerySidebar } from './gallery-jsx'

const MORE_MENU_WIDTH = 200

export function TemplateGallery({ onClose }: { onClose: () => void }) {
  const g = useGalleryController({ onClose })
  const { state } = g
  return createPortal(<div className='app-viewport-fixed fixed z-[240] flex items-end justify-center md:items-center md:p-6'>
    <div className='anim-fade absolute inset-0 bg-[var(--scrim)]' onClick={onClose} aria-hidden='true'/>
    <div ref={state.panelRef} role='dialog' aria-modal='true' aria-label={t('templates.template_library')} tabIndex={-1} data-surface='templates' onKeyDown={g.handleKeyDown} className='anim-pop relative flex h-[min(88dvh,var(--app-viewport-height,100dvh))] w-full max-w-235 flex-col overflow-hidden rounded-t-[var(--r-2xl)] border border-b-0 border-[var(--border-default)] bg-[var(--bg-overlay)] pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow-modal)] outline-none md:rounded-[var(--r-2xl)] md:border-b md:pb-0'>
      <GalleryHeader query={state.query} onQueryChange={state.setQuery} searchRef={state.searchRef} onSearchFocusChange={state.setSearchFocused} selectMode={state.selectMode} onToggleSelectMode={g.selectActions.toggleSelectMode} onOpenHelp={() => state.setIsHelpOpen(true)} onNewTemplate={() => state.setEditing('new')} moreButtonRef={state.moreButtonRef} onOpenMore={() => state.setIsMoreOpen(true)} onClose={onClose}/>

      <div className={cn('hidden shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-1.5 text-[10.5px] text-[var(--text-quaternary)] md:flex', state.searchFocused && 'opacity-60')}>
        <span>{t(state.searchFocused ? 'templates.kbd_hint_search' : 'templates.kbd_hint')}</span>
        {state.selectMode && <span className='text-[var(--accent)]'>{t('templates.select_hint')}</span>}
      </div>

      <GalleryMobileChips g={g}/>
      <div className='flex min-h-0 flex-1'>
        <GallerySidebar g={g}/>
        <GalleryMain g={g}/>
      </div>
      {state.selectMode && <GallerySelectBar g={g}/>}
    </div>
    <GalleryModals g={g}/>
    <Menu anchor={state.moreButtonRef} open={state.isMoreOpen} onClose={() => state.setIsMoreOpen(false)} items={g.moreItems} align='end' width={MORE_MENU_WIDTH}/>
  </div>, document.body)
}
