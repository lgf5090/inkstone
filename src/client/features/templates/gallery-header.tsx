import { type RefObject } from 'react'
import { HelpCircle, LayoutTemplate, MoreHorizontal, Plus, Search, SquareCheck, X } from 'lucide-react'
import { Button, IconButton, Kbd } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import { t } from '../../lib/i18n'

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
  return (
    <header className='flex shrink-0 items-center gap-2.5 border-b border-[var(--border-subtle)] px-[var(--sp-4)] py-2.5'>
      <LayoutTemplate size={16} className='shrink-0 text-[var(--text-quaternary)]'/>
      <h2 className='shrink-0 text-[14px] font-semibold tracking-[-0.012em] text-[var(--text-primary)]'>{t('templates.template_library')}</h2>
      <div className='relative min-w-0 flex-1'>
        <Search size={13} aria-hidden='true' className='pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--text-quaternary)]'/>
        <input ref={searchRef} aria-label={t('templates.search_templates')} value={query} onChange={(event) => onQueryChange(event.target.value)} onFocus={() => onSearchFocusChange(true)} onBlur={() => onSearchFocusChange(false)} placeholder={t('templates.search_templates')} className='h-10 w-full rounded-[var(--r-md)] border border-transparent bg-[var(--bg-inset)] pr-8 pl-8 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)] transition-[border-color,box-shadow] focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-ring)] focus:outline-none'/>
        {query && (<button type='button' aria-label={t('common.clear')} onClick={() => onQueryChange('')} className='absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]'>
          <X size={13}/>
        </button>)}
      </div>
      <Tooltip label={t('templates.select_mode')}>
        <IconButton label={t('templates.select_mode')} size='sm' active={selectMode} onClick={onToggleSelectMode} className='shrink-0'>
          <SquareCheck size={15}/>
        </IconButton>
      </Tooltip>
      <Tooltip label={t('templates.keyboard_shortcuts')}>
        <IconButton label={t('templates.keyboard_shortcuts')} size='sm' onClick={onOpenHelp} className='shrink-0'>
          <HelpCircle size={15}/>
        </IconButton>
      </Tooltip>
      <Tooltip label={t('templates.new_template')}>
        <Button size='sm' variant='primary' icon={<Plus size={14}/>} onClick={onNewTemplate} className='shrink-0'>
          {t('templates.new_template')}
        </Button>
      </Tooltip>
      <span className='hidden md:inline-flex'><Kbd keys={['Esc']}/></span>
      <Tooltip label={t('templates.export_library')} side='left'>
        <IconButton ref={moreButtonRef} label={t('templates.export_library')} size='sm' onClick={onOpenMore}>
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
