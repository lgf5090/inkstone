import { type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { HelpCircle, LayoutTemplate, MoreHorizontal, Plus, Search, SquareCheck, X } from 'lucide-react'
import { Button, IconButton, Kbd } from '../../components/primitives'
import { useFilterInput } from '../../components/FilterInput'
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
  /**
   * The gallery's own keys, asked for before the shared filter contract decides what to do with the
   * keystroke: ArrowDown is how the caret walks out of this box and into the grid below it.
   */
  onSearchKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void
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
  onSearchKeyDown,
  selectMode,
  onToggleSelectMode,
  onOpenHelp,
  onNewTemplate,
  moreButtonRef,
  onOpenMore,
  onClose,
}: GalleryHeaderProps) {
  const roomy = useGalleryHeaderRoom()
  // The app-wide filter contract for the keys, the gallery's own chrome for the box: Escape takes the
  // query back out and only an empty box lets the dialog close, which is what the `data-owns-escape`
  // mark below says to the overlay layers.
  const { field, clear } = useFilterInput({
    value: query,
    inputRef: searchRef,
    escapeWhenEmpty: 'release',
    onClear: () => onQueryChange(''),
    onKeyDown: onSearchKeyDown,
  })
  return (
    <header className='flex shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] px-[var(--sp-4)] py-2.5 sm:gap-2.5'>
      <LayoutTemplate size={16} className='shrink-0 text-[var(--text-quaternary)]'/>
      {roomy && <h2 className='shrink-0 text-[length:var(--text-14)] font-semibold tracking-[-0.012em] text-[var(--text-primary)]'>{t('templates.template_library')}</h2>}
      <div className='relative min-w-0 flex-1'>
        <Search size={13} aria-hidden='true' className='pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--text-quaternary)]'/>
        <input {...field} data-owns-escape={query ? '1' : undefined} type='search' aria-label={t('templates.search_templates')} value={query} onChange={(event) => onQueryChange(event.target.value)} onFocus={() => onSearchFocusChange(true)} onBlur={() => onSearchFocusChange(false)} placeholder={t('templates.search_templates')} className='h-10 w-full rounded-[var(--r-md)] border border-transparent bg-[var(--bg-inset)] pr-8 pl-8 text-[length:var(--text-13)] text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)] transition-[border-color,box-shadow] duration-[var(--dur-fast)] focus:border-[var(--accent)] focus:shadow-[var(--shadow-ring-focus)] focus:outline-none [&::-webkit-search-cancel-button]:hidden'/>
        {query && (<IconButton label={t('common.clear')} size='sm' onClick={clear} className='absolute top-1/2 right-1.5 -translate-y-1/2'>
          <X size={13}/>
        </IconButton>)}
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
