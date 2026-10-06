import type { NoteTemplateCategory } from '@shared/types'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { cn } from '../../lib/cn'
import { IconButton } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import { t } from '../../lib/i18n'

export function FilterChip({ label, count, active, onClick, dropTarget, onDragOver, onDragLeave, onDrop }: {
  label: string
  count: number | null
  active: boolean
  onClick: () => void
  dropTarget?: boolean
  onDragOver?: (event: React.DragEvent) => void
  onDragLeave?: () => void
  onDrop?: (event: React.DragEvent) => void
}) {
  return (<button type='button' aria-pressed={active} onClick={onClick} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} className={cn('flex h-7 shrink-0 items-center gap-[var(--sp-1-5)] rounded-full border px-[var(--sp-2-5)] text-[11.5px] transition-colors', active ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]' : 'border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]', dropTarget && 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]')}>
    {count === null && <Plus size={11}/>}
    <span className='whitespace-nowrap'>{label}</span>
    {count !== null && <span className='text-[10.5px] tabular opacity-70'>{count}</span>}
  </button>)
}

export function SidebarButton({ icon, label, count, active, onClick }: {
  icon: React.ReactNode
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (<button type='button' aria-pressed={active} onClick={onClick} className={cn('flex h-9 w-full items-center gap-[var(--sp-2-5)] rounded-[var(--r-md)] px-[var(--sp-2)] text-left text-[12.5px] transition-colors', active ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
    <span className={cn('shrink-0', active ? 'text-[var(--accent)]' : 'text-[var(--text-quaternary)]')}>{icon}</span>
    <span className='min-w-0 flex-1 truncate'>{label}</span>
    <span className='shrink-0 text-[11px] tabular text-[var(--text-quaternary)]'>{count}</span>
  </button>)
}

export function CategoryRow({ category, count, active, dropTarget, onSelect, onRename, onDelete, onDragOver, onDragLeave, onDrop }: {
  category: NoteTemplateCategory
  count: number
  active: boolean
  dropTarget?: boolean
  onSelect: () => void
  onRename: () => void
  onDelete: () => void
  onDragOver?: (event: React.DragEvent) => void
  onDragLeave?: () => void
  onDrop?: (event: React.DragEvent) => void
}) {
  return (<div onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} className={cn('group flex h-9 items-center rounded-[var(--r-md)] transition-colors', active || dropTarget ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]')}>
    <button type='button' aria-pressed={active} onClick={onSelect} className={cn('flex h-full min-w-0 flex-1 items-center gap-[var(--sp-2-5)] rounded-[var(--r-md)] px-[var(--sp-2)] text-left text-[12.5px] transition-colors', active ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]')}>
      <span className={cn('text-[13px] leading-none', active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]')}>◈</span>
      <span className='min-w-0 flex-1 truncate'>{category.name}</span>
      <span className='shrink-0 text-[11px] tabular text-[var(--text-quaternary)]'>{count}</span>
    </button>
    {!category.builtin && (<div className='flex shrink-0 items-center pr-[var(--sp-1)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100'>
      <Tooltip label={t('templates.rename_category')} side='top'>
        <IconButton label={t('templates.rename_category')} size='sm' onClick={onRename} className='size-6! text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]'>
          <Pencil size={11}/>
        </IconButton>
      </Tooltip>
      <Tooltip label={t('templates.delete_category')} side='top'>
        <IconButton label={t('templates.delete_category')} size='sm' onClick={onDelete} className='size-6! text-[var(--text-quaternary)] hover:text-[var(--danger)]'>
          <Trash2 size={11}/>
        </IconButton>
      </Tooltip>
    </div>)}
  </div>)
}
