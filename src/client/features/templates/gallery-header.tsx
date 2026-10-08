import { type RefObject } from 'react'
import { HelpCircle, LayoutTemplate, MoreHorizontal, Plus, Search, SquareCheck, X } from 'lucide-react'
import { Button, IconButton, Kbd } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import { useMediaQuery } from '../../lib/hooks'
import { t } from '../../lib/i18n'

/**
 * Below this width the header row cannot hold the title, the two meta buttons and a search box
 * that still reads as one, so those controls move into the overflow menu. The menu is built from
 * the same query: a control hidden by CSS with no menu twin is simply gone.
 */
export const GALLERY_HEADER_ROOM_QUERY = '(min-width: 640px)'

export function useGalleryHeaderRoom(): boolean {
  return useMediaQuery(GALLERY_HEADER_ROOM_QUERY)
}

interface GalleryHeaderProps {
  query: string
  onQueryChange: (value: string) => void
  searchRef: RefObject<HTMLInputElement | null>
  onSearchFocusChange: (focused: boolean) => void
  selectMode: boolean
  onToggleSelectMode: () => void
  onOpenHelp: () => void
  onNewTemplate: () => void
  moreButtonRef: RefObject<HTMLButtonElement | null>
  onOpenMore: () => void
  onClose: () => void
}

export function GalleryHeader({
  query,
  onQueryChange,
  searchRef,
  onSearchFocusChange,
  selectMode,
  onToggleSelectMode,
  onOpenHelp,
  onNewTemplate,
  moreButtonRef,
  onOpenMore,
  onClose,
}: GalleryHeaderProps) {
  const roomy = useGalleryHeaderRoom()
  return (
    <header className='flex shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] px-[var(--sp-4)] py-2.5 sm:gap-2.5'>
      <LayoutTemplate size={16} className='shrink-0 text-[var(--text-quaternary)]'/>
      {roomy && <h2 className='shrink-0 text-[14px] font-semibold tracking-[-0.012em] text-[var(--text-primary)]'>{t('templates.template_library')}</h2>}
      <div className='relative min-w-0 flex-1'>
        <Search size={13} aria-hidden='true' className='pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--text-quaternary)]'/>
        <input ref={searchRef} data-owns-escape={query ? '1' : undefined} aria-label={t('templates.search_templates')} value={query} onChange={(event) => onQueryChange(event.target.value)} onFocus={() => onSearchFocusChange(true)} onBlur={() => onSearchFocusChange(false)} placeholder={t('templates.search_templates')} className='h-10 w-full rounded-[var(--r-md)] border border-transparent bg-[var(--bg-inset)] pr-8 pl-8 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)] transition-[border-color,box-shadow] focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-ring)] focus:outline-none'/>
        {query && (<button type='button' aria-label={t('common.clear')} onClick={() => onQueryChange('')} className='absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]'>
          <X size={13}/>
        </button>)}
      </div>
      {roomy && (<Tooltip label={t('templates.select_mode')}>
        <IconButton label={t('templates.select_mode')} size='sm' active={selectMode} onClick={onToggleSelectMode} className='shrink-0'>
          <SquareCheck size={15}/>
        </IconButton>
      </Tooltip>)}
      {roomy && (<Tooltip label={t('templates.keyboard_shortcuts')}>
        <IconButton label={t('templates.keyboard_shortcuts')} size='sm' onClick={onOpenHelp} className='shrink-0'>
          <HelpCircle size={15}/>
        </IconButton>
      </Tooltip>)}
      <Tooltip label={t('templates.new_template')}>
        <Button size='sm' variant='primary' icon={<Plus size={14}/>} aria-label={t('templates.new_template')} onClick={onNewTemplate} className={roomy ? 'shrink-0' : 'w-9 shrink-0 px-0'}>
          {roomy ? t('templates.new_template') : null}
        </Button>
      </Tooltip>
      <span className='hidden md:inline-flex'><Kbd keys={['Esc']}/></span>
      <Tooltip label={t('common.more_actions')} side='left'>
        <IconButton ref={moreButtonRef} label={t('common.more_actions')} size='sm' onClick={onOpenMore}>
          <MoreHorizontal size={15}/>
        </IconButton>
      </Tooltip>
      <Tooltip label={t('common.close')} side='left'>
        <IconButton label={t('common.close')} size='sm' onClick={onClose}>
          <X size={15}/>
        </IconButton>
      </Tooltip>
    </header>
  )
}
