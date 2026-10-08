/**
 * The choice library as a list the author can actually run and rearrange.
 *
 * Rows are the tree the store keeps, flattened in `position` order; a collapsed group hides its
 * children without touching the data. Ordering is `place(id, parentId, index)`, so a drop into a group
 * and a nudge down the list go through the one function that refuses cycles, self-parenting and too
 * deep a nest — the editor never invents a second rule about what a legal tree is.
 */
import { useCallback, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { QUICKADD_LIMITS, type QuickAddChoice, type QuickAddChoiceType } from '@shared/quickadd'
import { Button, IconButton } from '../../components/primitives'
import { Switch } from '../../components/form'
import { confirm } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { useQuickAdd } from '../../store/quickadd'
import { choiceSummary, QuickAddChoiceEditor } from './choice-editor'

const BLANK_NAMES: Record<QuickAddChoiceType, () => string> = {
  template: () => t('quickadd.new_template_choice'),
  capture: () => t('quickadd.new_capture_choice'),
  macro: () => t('quickadd.new_macro_choice'),
  group: () => t('quickadd.new_group_choice'),
}

interface FlatRow {
  choice: QuickAddChoice
  depth: number
}

function flatten(choices: QuickAddChoice[]): FlatRow[] {
  const ordered = [...choices].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
  const byId = new Map(choices.map((choice) => [choice.id, choice]))
  const out: FlatRow[] = []
  const visit = (parentId: string | null, depth: number): void => {
    for (const choice of ordered) {
      if ((choice.parentId ?? null) !== parentId) continue
      out.push({ choice, depth })
      if (choice.type === 'group' && !choice.collapsed) visit(choice.id, depth + 1)
    }
  }
  visit(null, 0)
  // A child whose group no longer exists would vanish from every view while still taking up a slot in
  // the library, so an orphan is listed at the bottom where it can be moved or deleted. Hidden by a
  // collapsed ancestor is not the same thing: those rows are the group's own, and listing them here
  // would make the collapse control do nothing at all.
  const shown = new Set(out.map((row) => row.choice.id))
  const hiddenByCollapse = (choice: QuickAddChoice): boolean => {
    const seen = new Set<string>()
    let at = choice.parentId ?? null
    while (at && !seen.has(at)) {
      seen.add(at)
      const parent = byId.get(at)
      if (!parent) return false
      if (parent.type === 'group' && parent.collapsed) return true
      at = parent.parentId ?? null
    }
    return true
  }
  for (const choice of ordered) {
    if (!shown.has(choice.id) && !hiddenByCollapse(choice)) out.push({ choice, depth: 0 })
  }
  return out
}

export function QuickAddChoiceList() {
  const choices = useQuickAdd((state) => state.choices)
  const create = useQuickAdd((state) => state.createChoice)
  const update = useQuickAdd((state) => state.updateChoice)
  const remove = useQuickAdd((state) => state.removeChoices)
  const duplicate = useQuickAdd((state) => state.duplicateChoice)
  const place = useQuickAdd((state) => state.place)
  const toggleGroup = useQuickAdd((state) => state.toggleGroupCollapsed)
  const toast = useUi((state) => state.toast)
  const [editing, setEditing] = useState<string | null>(null)

  const rows = useMemo(() => flatten(choices), [choices])
  const editingChoice = useMemo(() => choices.find((choice) => choice.id === editing) ?? null, [choices, editing])

  const run = useCallback((choice: QuickAddChoice) => {
    void import('../../lib/quickadd/runner')
      .then(({ runQuickAddChoice }) => runQuickAddChoice(choice.id))
      .catch((error: unknown) => {
        toast({
          title: t('quickadd.failed_hint', { value0: choice.name }),
          description: error instanceof Error ? error.message : String(error),
          tone: 'danger',
        })
      })
  }, [toast])

  const add = useCallback((type: QuickAddChoiceType) => {
    const created = create(type, BLANK_NAMES[type]())
    if (created) setEditing(created.id)
  }, [create])

  const move = useCallback((choice: QuickAddChoice, delta: number) => {
    const siblings = rows.filter((row) => (row.choice.parentId ?? null) === (choice.parentId ?? null))
    const index = siblings.findIndex((row) => row.choice.id === choice.id)
    const target = index + delta
    if (target < 0 || target >= siblings.length) return
    const swapped = [...siblings]
    const held = swapped[index]
    swapped[index] = swapped[target]
    swapped[target] = held
    place(choice.id, choice.parentId ?? null, swapped.findIndex((row) => row.choice.id === choice.id))
  }, [place, rows])

  const erase = useCallback(async (choice: QuickAddChoice) => {
    const children = choices.filter((entry) => (entry.parentId ?? null) === choice.id)
    const ok = await confirm({
      title: t('quickadd.delete_choice', { value0: choice.name }),
      description: children.length > 0
        ? t('quickadd.delete_choice_with_children', { value0: String(children.length + 1) })
        : t('quickadd.delete_choice_confirm'),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    if (editing === choice.id) setEditing(null)
    remove([choice.id, ...children.map((entry) => entry.id)])
  }, [choices, editing, remove])

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[12px] text-[var(--text-tertiary)]">{t('quickadd.choice_count', { value0: String(choices.length) })}</span>
        <span className="flex-1"/>
        <Button size="sm" onClick={() => add('template')} disabled={choices.length >= QUICKADD_LIMITS.maxChoices}>
          <Plus size={13}/>{t('quickadd.new_template_choice')}
        </Button>
        <Button size="sm" onClick={() => add('capture')} disabled={choices.length >= QUICKADD_LIMITS.maxChoices}>
          {t('quickadd.new_capture_choice')}
        </Button>
        <Button size="sm" onClick={() => add('macro')} disabled={choices.length >= QUICKADD_LIMITS.maxChoices}>
          {t('quickadd.new_macro_choice')}
        </Button>
        <Button size="sm" onClick={() => add('group')} disabled={choices.length >= QUICKADD_LIMITS.maxChoices}>
          {t('quickadd.new_group_choice')}
        </Button>
      </div>

      {rows.length === 0 && <p className="text-[12px] text-[var(--text-quaternary)]">{t('quickadd.no_choices')}</p>}

      <ul className="space-y-1">
        {rows.map((row) => (
          <ChoiceRow
            key={row.choice.id}
            row={row}
            allChoices={choices}
            rows={rows}
            onRun={() => run(row.choice)}
            onEdit={() => setEditing(row.choice.id)}
            onDuplicate={() => {
              if (choices.length >= QUICKADD_LIMITS.maxChoices) return
              duplicate(row.choice.id)
            }}
            onDelete={() => void erase(row.choice)}
            onMove={(delta) => move(row.choice, delta)}
            onToggle={() => toggleGroup(row.choice.id)}
            onEnabled={(enabled) => update(row.choice.id, { enabled })}
          />
        ))}
      </ul>

      {editingChoice && <QuickAddChoiceEditor choice={editingChoice} onClose={() => setEditing(null)}/>}
    </div>
  )
}

function ChoiceRow({ row, rows, allChoices, onRun, onEdit, onDuplicate, onDelete, onMove, onToggle, onEnabled }: {
  row: FlatRow
  allChoices: QuickAddChoice[]
  rows: FlatRow[]
  onRun: () => void
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
  onMove: (delta: number) => void
  onToggle: () => void
  onEnabled: (next: boolean) => void
}) {
  const { choice, depth } = row
  const siblings = rows.filter((entry) => (entry.choice.parentId ?? null) === (choice.parentId ?? null))
  const index = siblings.findIndex((entry) => entry.choice.id === choice.id)
  return (
    <li
      className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2 py-1.5"
      style={{ marginLeft: depth * 14 }}
    >
      {choice.type === 'group' ? (
        <button
          type="button"
          aria-label={choice.collapsed ? t('quickadd.expand_group') : t('quickadd.collapse_group')}
          aria-expanded={!choice.collapsed}
          onClick={onToggle}
          className="shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
        >
          {choice.collapsed ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}
        </button>
      ) : <span aria-hidden="true" className="size-[14px] shrink-0"/>}
      {choice.icon
        ? <span className="shrink-0 text-[13px] leading-none" style={{ color: choice.color ?? undefined }}>{choice.icon}</span>
        : <span aria-hidden="true" className="size-[13px] shrink-0 rounded-full" style={{ backgroundColor: choice.color ?? 'var(--border-default)' }}/>}
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[12.5px] ${choice.enabled ? 'text-[var(--text-primary)]' : 'text-[var(--text-quaternary)] line-through'}`}>
          {choice.name}
        </span>
        <span className="block truncate text-[11px] text-[var(--text-quaternary)]">{choiceSummary(choice, allChoices)}</span>
      </span>
        <Switch checked={choice.enabled} onChange={onEnabled} label={t('quickadd.field_enabled')}/>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton label={t('quickadd.move_up')} size="sm" onClick={() => onMove(-1)} disabled={index <= 0}>
            <ArrowUp size={13}/>
          </IconButton>
          <IconButton label={t('quickadd.move_down')} size="sm" onClick={() => onMove(1)} disabled={index >= siblings.length - 1}>
            <ArrowDown size={13}/>
          </IconButton>
          {choice.type !== 'group' && (
            <IconButton label={t('quickadd.run_now')} size="sm" onClick={onRun}>
              <Play size={13}/>
            </IconButton>
          )}
          <IconButton label={t('quickadd.duplicate')} size="sm" onClick={onDuplicate}>
            <Copy size={13}/>
          </IconButton>
          <IconButton label={t('common.edit')} size="sm" onClick={onEdit}>
            <Pencil size={13}/>
          </IconButton>
          <IconButton label={t('common.delete')} size="sm" variant="danger" onClick={onDelete}>
            <Trash2 size={13}/>
          </IconButton>
        </div>
      </li>
    )
  }
