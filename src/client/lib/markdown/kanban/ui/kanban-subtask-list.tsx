import { useId, useRef, useState } from 'react'
import { AlignLeft, CheckSquare, MoreHorizontal, Plus, Smile, Square } from 'lucide-react'
import { t } from '../../../i18n'
import { createKanbanId } from '../id'
import type { KanbanSubtask } from '../types'
import { KanbanIconBadge } from './kanban-icon-badge'
import { KanbanIconPicker } from './kanban-icon-picker'
import { KanbanSubtaskMenu } from './kanban-subtask-menu'

interface KanbanSubtaskListProps {
  subtasks: KanbanSubtask[]
  onUpdateSubtasks: (nextSubtasks: KanbanSubtask[]) => void
  onConvertToItem?: (subtask: KanbanSubtask) => void
}

function SubtaskDescInput({
  description,
  onChange,
}: {
  description: string
  onChange: (desc: string) => void
}) {
  return (
    <div className='mt-[var(--sp-1)] pl-[var(--sp-12)] pr-[var(--sp-1)]'>
      <input
        type='text'
        value={description}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('preview.kanban_card_description_placeholder')}
        className='w-full rounded-[var(--r-xs)] border-none bg-[var(--bg-inset)] px-[var(--sp-2)] py-[var(--sp-0-5)] text-[length:var(--text-11)] text-[var(--text-secondary)] placeholder:text-[var(--text-quaternary)] outline-none focus:ring-1 focus:ring-[var(--accent)]'
      />
    </div>
  )
}

function SubtaskTrailingActions({
  hasDescription,
  subtask,
  onToggleDesc,
  onDuplicate,
  onConvertToItem,
  onDelete,
}: {
  hasDescription: boolean
  subtask: KanbanSubtask
  onToggleDesc: () => void
  onDuplicate: () => void
  onConvertToItem?: () => void
  onDelete: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  return (
    <div className='flex items-center gap-[var(--sp-0-5)]'>
      <button
        type='button'
        onClick={onToggleDesc}
        title={t('preview.kanban_card_description')}
        className={`opacity-0 transition-opacity p-[var(--sp-0-5)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] group-hover/sub:opacity-100 focus-visible:opacity-100 pointer-coarse:!opacity-100 ${
          hasDescription ? '!opacity-100 text-[var(--accent)]' : ''
        }`}
      >
        <AlignLeft size={13} />
      </button>

      <div className='relative'>
        <button
          ref={menuBtnRef}
          type='button'
          onClick={() => setMenuOpen((o) => !o)}
          className='opacity-0 transition-opacity p-[var(--sp-0-5)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] group-hover/sub:opacity-100 focus-visible:opacity-100 pointer-coarse:!opacity-100'
          aria-label={t('common.more_actions')}
          aria-haspopup='menu'
          aria-expanded={menuOpen}
          {...(menuOpen ? { 'aria-controls': panelId } : {})}
        >
          <MoreHorizontal size={13} />
        </button>
        <KanbanSubtaskMenu
          open={menuOpen}
          panelId={panelId}
          subtask={subtask}
          anchorRef={menuBtnRef}
          onClose={() => setMenuOpen(false)}
          onDuplicate={onDuplicate}
          onConvertToItem={onConvertToItem}
          onDelete={onDelete}
        />
      </div>
    </div>
  )
}

function SubtaskIconSelect({
  icon,
  onSelectIcon,
}: {
  icon?: string
  onSelectIcon: (icon?: string) => void
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  return (
    <>
      <button
        ref={btnRef}
        type='button'
        onClick={() => setOpen((o) => !o)}
        className='flex size-5 shrink-0 items-center justify-center rounded-[var(--r-xs)] hover:bg-[var(--bg-raised)]'
        title={t('preview.kanban_icon_picker')}
        aria-haspopup='dialog'
        aria-expanded={open}
        {...(open ? { 'aria-controls': panelId } : {})}
      >
        {icon ? (
          <KanbanIconBadge icon={icon} size={14} />
        ) : (
          <Smile size={13} className='text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]' />
        )}
      </button>
      <KanbanIconPicker
        open={open}
        panelId={panelId}
        anchorRef={btnRef}
        onClose={() => setOpen(false)}
        onSelectIcon={(newIcon) => onSelectIcon(newIcon || undefined)}
        currentIcon={icon}
      />
    </>
  )
}

function SubtaskMainRow({
  subtask,
  onToggle,
  onUpdateTitle,
  onUpdateSubtask,
  onToggleDesc,
  onDuplicate,
  onConvertToItem,
  onDelete,
}: {
  subtask: KanbanSubtask
  onToggle: () => void
  onUpdateTitle: (title: string) => void
  onUpdateSubtask: (updated: KanbanSubtask) => void
  onToggleDesc: () => void
  onDuplicate: () => void
  onConvertToItem?: () => void
  onDelete: () => void
}) {
  return (
    <div className='flex items-center gap-[var(--sp-1-5)]'>
      <button
        type='button'
        onClick={onToggle}
        className='shrink-0 text-[var(--text-tertiary)] hover:text-[var(--accent)]'
        aria-label={t(
          subtask.completed ? 'preview.kanban_mark_incomplete_named' : 'preview.kanban_mark_complete_named',
          { name: subtask.title },
        )}
      >
        {subtask.completed ? <CheckSquare size={13} className='text-[var(--accent)]' /> : <Square size={13} />}
      </button>

      <SubtaskIconSelect
        icon={subtask.icon}
        onSelectIcon={(icon) => onUpdateSubtask({ ...subtask, icon })}
      />

      <input
        type='text'
        defaultValue={subtask.title}
        aria-label={t('preview.kanban_subtask_title')}
        onBlur={(e) => {
          if (e.target.value !== subtask.title) {
            onUpdateTitle(e.target.value)
          }
        }}
        className={`flex-1 border-none bg-transparent p-0 text-[length:var(--text-12)] outline-none ${
          subtask.completed ? 'text-[var(--text-tertiary)] line-through' : 'text-[var(--text-secondary)]'
        }`}
      />

      <SubtaskTrailingActions
        hasDescription={Boolean(subtask.description)}
        subtask={subtask}
        onToggleDesc={onToggleDesc}
        onDuplicate={onDuplicate}
        onConvertToItem={onConvertToItem}
        onDelete={onDelete}
      />
    </div>
  )
}

function SubtaskRow({
  subtask,
  onToggle,
  onUpdateTitle,
  onUpdateSubtask,
  onDuplicate,
  onConvertToItem,
  onDelete,
}: {
  subtask: KanbanSubtask
  onToggle: () => void
  onUpdateTitle: (title: string) => void
  onUpdateSubtask: (updated: KanbanSubtask) => void
  onDuplicate: () => void
  onConvertToItem?: () => void
  onDelete: () => void
}) {
  const [showDesc, setShowDesc] = useState(Boolean(subtask.description))

  return (
    <div className='group/sub flex flex-col rounded-[var(--r-xs)] px-[var(--sp-1-5)] py-[var(--sp-1)] text-[length:var(--text-12)] hover:bg-[var(--bg-hover)]'>
      <SubtaskMainRow
        subtask={subtask}
        onToggle={onToggle}
        onUpdateTitle={onUpdateTitle}
        onUpdateSubtask={onUpdateSubtask}
        onToggleDesc={() => setShowDesc((prev) => !prev)}
        onDuplicate={onDuplicate}
        onConvertToItem={onConvertToItem}
        onDelete={onDelete}
      />

      {(showDesc || subtask.description) && (
        <SubtaskDescInput
          description={subtask.description || ''}
          onChange={(desc) => onUpdateSubtask({ ...subtask, description: desc })}
        />
      )}
    </div>
  )
}

function AddSubtaskForm({ onAdd }: { onAdd: (title: string) => void }) {
  const [newTitle, setNewTitle] = useState('')

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = newTitle.trim()
    if (!trimmed) return
    onAdd(trimmed)
    setNewTitle('')
  }

  return (
    <form onSubmit={handleAdd} className='mt-[var(--sp-0-5)] flex items-center gap-[var(--sp-1-5)] px-[var(--sp-1-5)] py-[var(--sp-0-5)]'>
      <Plus size={12} className='shrink-0 text-[var(--text-tertiary)]' />
      <input
        type='text'
        value={newTitle}
        onChange={(e) => setNewTitle(e.target.value)}
        placeholder={t('preview.kanban_add_subtask')}
        className='w-full border-none bg-transparent p-0 text-[length:var(--text-11)] text-[var(--text-tertiary)] placeholder:text-[var(--text-quaternary)] outline-none focus:text-[var(--text-primary)]'
      />
    </form>
  )
}

export function KanbanSubtaskList({
  subtasks,
  onUpdateSubtasks,
  onConvertToItem,
}: KanbanSubtaskListProps) {
  const handleToggle = (id: string) => {
    onUpdateSubtasks(subtasks.map((s) => (s.id === id ? { ...s, completed: !s.completed } : s)))
  }

  const handleUpdateTitle = (id: string, title: string) => {
    onUpdateSubtasks(subtasks.map((s) => (s.id === id ? { ...s, title } : s)))
  }

  const handleUpdateSubtask = (updated: KanbanSubtask) => {
    onUpdateSubtasks(subtasks.map((s) => (s.id === updated.id ? updated : s)))
  }

  const handleDuplicate = (st: KanbanSubtask) => {
    onUpdateSubtasks([...subtasks, { ...st, id: `sub_${createKanbanId()}` }])
  }

  const handleDelete = (id: string) => {
    onUpdateSubtasks(subtasks.filter((s) => s.id !== id))
  }

  return (
    <div className='flex flex-col gap-[var(--sp-0-5)] pt-[var(--sp-1)]'>
      {subtasks.map((st) => (
        <SubtaskRow
          key={st.id}
          subtask={st}
          onToggle={() => handleToggle(st.id)}
          onUpdateTitle={(title) => handleUpdateTitle(st.id, title)}
          onUpdateSubtask={handleUpdateSubtask}
          onDuplicate={() => handleDuplicate(st)}
          onConvertToItem={onConvertToItem ? () => onConvertToItem(st) : undefined}
          onDelete={() => handleDelete(st.id)}
        />
      ))}

      <AddSubtaskForm
        onAdd={(title) =>
          onUpdateSubtasks([...subtasks, { id: `sub_${createKanbanId()}`, title, completed: false }])
        }
      />
    </div>
  )
}
