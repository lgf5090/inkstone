import { useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, ChevronRight, ListTodo, Plus } from 'lucide-react'
import { t } from '../../../i18n'
import { createKanbanId } from '../id'
import type { KanbanSubtask } from '../types'
import { KanbanIconBadge } from './kanban-icon-badge'

interface KanbanCardSubtasksProps {
  itemId: string
  subtasks: KanbanSubtask[]
  onUpdateSubtasks?: (itemId: string, nextSubtasks: KanbanSubtask[]) => void
}

function SubtaskItemRow({
  subtask,
  onToggle,
}: {
  subtask: KanbanSubtask
  onToggle: () => void
}) {
  return (
    <div
      className='group/st flex flex-col gap-[var(--sp-0-5)] text-[length:var(--text-12)]'
      onClick={(e) => e.stopPropagation()}
    >
      <div className='flex items-center gap-[var(--sp-2)]'>
        <button
          type='button'
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          data-completed={subtask.completed || undefined}
          className='flex size-3.5 shrink-0 items-center justify-center rounded-[var(--r-xs)] border border-[var(--border-default)] bg-transparent transition-colors data-[completed]:border-[var(--accent)] data-[completed]:bg-[var(--accent)]'
          aria-label={subtask.title}
        >
          {subtask.completed && <Check size={10} className='text-[var(--accent-contrast)]' />}
        </button>
        {subtask.icon && <KanbanIconBadge icon={subtask.icon} size={13} />}
        <span
          className={`min-w-0 flex-1 truncate ${
            subtask.completed ? 'line-through text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'
          }`}
        >
          {subtask.title}
        </span>
      </div>
      {subtask.description && (
        <p className='pl-5.5 text-[length:var(--text-11)] text-[var(--text-tertiary)] line-clamp-1'>
          {subtask.description}
        </p>
      )}
    </div>
  )
}

function AddSubtaskInput({
  onAdd,
  onCancel,
}: {
  onAdd: (title: string) => void
  onCancel: () => void
}) {
  const [val, setVal] = useState('')

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (val.trim()) {
        onAdd(val.trim())
        setVal('')
      }
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      onCancel()
    }
  }

  return (
    <div className='pt-[var(--sp-1)]' onClick={(e) => e.stopPropagation()}>
      <input
        type='text'
        autoFocus
        value={val}
        placeholder={t('preview.kanban_add_subtask')}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={onCancel}
        className='w-full rounded-[var(--r-xs)] border border-[var(--accent)] bg-[var(--bg-surface)] px-[var(--sp-1-5)] py-[var(--sp-0-5)] text-[length:var(--text-11)] text-[var(--text-primary)] outline-none'
      />
    </div>
  )
}

function SubtaskListExpanded({
  subtasks,
  isAdding,
  onToggleSubtask,
  onAddSubtask,
  onStartAdding,
  onCancelAdding,
}: {
  subtasks: KanbanSubtask[]
  isAdding: boolean
  onToggleSubtask: (id: string) => void
  onAddSubtask: (title: string) => void
  onStartAdding: () => void
  onCancelAdding: () => void
}) {
  return (
    <div
      className='mt-[var(--sp-1-5)] flex flex-col gap-[var(--sp-1-5)] rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)]/50 p-[var(--sp-2)]'
      onClick={(e) => e.stopPropagation()}
    >
      {subtasks.map((st) => (
        <SubtaskItemRow key={st.id} subtask={st} onToggle={() => onToggleSubtask(st.id)} />
      ))}
      {isAdding ? (
        <AddSubtaskInput onAdd={onAddSubtask} onCancel={onCancelAdding} />
      ) : (
        <button
          type='button'
          onClick={(e) => {
            e.stopPropagation()
            onStartAdding()
          }}
          className='flex items-center gap-[var(--sp-1)] pt-[var(--sp-1)] text-[length:var(--text-11)] text-[var(--text-tertiary)] hover:text-[var(--accent)]'
        >
          <Plus size={12} />
          <span>{t('preview.kanban_add_subtask')}</span>
        </button>
      )}
    </div>
  )
}

function SubtaskSummaryBar({
  completedCount,
  totalCount,
  percent,
  isExpanded,
  onToggleExpand,
}: {
  completedCount: number
  totalCount: number
  percent: number
  isExpanded: boolean
  onToggleExpand: () => void
}) {
  return (
    <button
      type='button'
      aria-expanded={isExpanded}
      aria-label={t(isExpanded ? 'preview.kanban_collapse_subtasks' : 'preview.kanban_expand_subtasks')}
      onClick={(e) => {
        e.stopPropagation()
        onToggleExpand()
      }}
      className='flex w-full cursor-pointer items-center justify-between gap-[var(--sp-2)] py-[var(--sp-0-5)] text-left text-[length:var(--text-11)] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]'
    >
      <span className='flex items-center gap-[var(--sp-1-5)] font-medium'>
        <ListTodo size={12} className='text-[var(--accent)]' />
        <span>{`${completedCount}/${totalCount}`}</span>
      </span>
      <span className='flex items-center gap-[var(--sp-2)]'>
        <span className='block h-[var(--sp-1-5)] w-[var(--sp-16)] overflow-hidden rounded-full bg-[var(--border-subtle)]'>
          <span
            className='block h-full rounded-full bg-[var(--accent)] transition-[width] duration-200'
            style={{ width: `${percent}%` }}
          />
        </span>
        {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </span>
    </button>
  )
}

export function KanbanCardSubtasks({
  itemId,
  subtasks,
  onUpdateSubtasks,
}: KanbanCardSubtasksProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  const completedCount = subtasks.filter((s) => s.completed).length
  const totalCount = subtasks.length
  const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0

  if (totalCount === 0) return null

  const handleToggleSubtask = (stId: string) => {
    if (!onUpdateSubtasks) return
    const next = subtasks.map((s) => (s.id === stId ? { ...s, completed: !s.completed } : s))
    onUpdateSubtasks(itemId, next)
  }

  const handleAddSubtask = (title: string) => {
    if (!onUpdateSubtasks) return
    const newSt: KanbanSubtask = {
      id: `st-${createKanbanId()}`,
      title,
      completed: false,
    }
    onUpdateSubtasks(itemId, [...subtasks, newSt])
    setIsAdding(false)
  }

  return (
    <div className='flex flex-col'>
      <SubtaskSummaryBar
        completedCount={completedCount}
        totalCount={totalCount}
        percent={percent}
        isExpanded={isExpanded}
        onToggleExpand={() => setIsExpanded((prev) => !prev)}
      />
      {isExpanded && (
        <SubtaskListExpanded
          subtasks={subtasks}
          isAdding={isAdding}
          onToggleSubtask={handleToggleSubtask}
          onAddSubtask={handleAddSubtask}
          onStartAdding={() => setIsAdding(true)}
          onCancelAdding={() => setIsAdding(false)}
        />
      )}
    </div>
  )
}
