import { memo, useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, Smile } from 'lucide-react'
import { useClickOutside, useEscape } from '../../../../components/overlay'
import { t, useLocaleRepaint } from '../../../i18n'
import { getKanbanDotColor } from '../colors'
import { getKanbanDueDate } from '../date-fields'
import { formatKanbanOptionLabel, formatKanbanPropertyName } from '../i18n-helpers'
import { kanbanPriorityColumn, kanbanStatusColumn, kanbanTagsColumn } from '../view-ops'
import type { KanbanItem, KanbanOption, KanbanProperty } from '../types'
import { KanbanCardDialog, KanbanCardPeek } from './kanban-detail-shell'
import { KanbanIconBadge } from './kanban-icon-badge'
import { KanbanIconPicker } from './kanban-icon-picker'
import { DetailDependencies } from './kanban-dependency-editor'
import { DetailDescription } from './kanban-item-detail-description'
import { DetailComments } from './kanban-comments'
import {
  DetailAttachmentsAndSubtasks,
  DetailDatesGrid,
  DetailFooter,
  DetailPropertiesGrid,
  DetailTagsField,
  PriorityChips,
  StatusOptionList,
} from './kanban-item-detail-fields'

interface KanbanItemDetailProps {
  item: KanbanItem | null
  columns: KanbanProperty[]
  onClose: () => void
  onUpdate: (updated: KanbanItem) => void
  onDelete: (id: string) => void
  onConvertSubtask: (subtaskId: string) => void
  onAddColumnOption?: (columnId: string, option: KanbanOption) => void
  /** Who each member column may offer, keyed by column id. */
  people?: Record<string, string[]>
  /** How this host turns description markdown into HTML; absent means the description stays source-only. */
  renderDescription?: (source: string) => string
  /** Every card the board holds, as the dependency picker's roster (KU-23). */
  boardItems?: KanbanItem[]
  /** The dependency list's writer: the board's guarded one, so a cycle never reaches the note. */
  onChangeDependencies?: (itemId: string, deps: string[]) => void
  /**
   * How the card is opened. A note shows one modal at a time and the board behind it is a few
   * hundred pixels tall, so the centred dialog is right there; the full screen board has room for
   * the board *and* the card, and a reader working through a column keeps the columns in view — so
   * it opens the card as a right-hand peek instead (user decision, 2026-09-23).
   */
  variant?: 'dialog' | 'peek'
}

function DetailStatusDropdown({
  statusCol,
  statusVal,
  onChangeStatus,
}: {
  statusCol?: KanbanProperty
  statusVal?: unknown
  onChangeStatus: (val: string) => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const options = statusCol?.options ?? []
  const opt = options.find((o) => o.id === statusVal || o.label === statusVal)
  const color = opt?.color ?? 'gray'

  const handleClose = () => setOpen(false)

  useClickOutside([containerRef], open, handleClose)
  useEscape(open, handleClose)

  return (
    <div ref={containerRef} className='relative inline-block'>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        className='flex items-center gap-[var(--sp-2)] rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-[var(--sp-2-5)] py-[var(--sp-1)] text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)] transition-colors hover:border-[var(--border-default)] hover:text-[var(--text-primary)]'
        aria-haspopup='listbox'
        aria-expanded={open}
        {...(open ? { 'aria-controls': panelId } : {})}
      >
        <span
          className='size-2.5 rounded-full shrink-0'
          style={{ backgroundColor: getKanbanDotColor(color) }}
        />
        <span>{opt ? formatKanbanOptionLabel(opt, 'status') : t('preview.kanban_not_set')}</span>
        <ChevronDown size={13} className='text-[var(--text-tertiary)]' />
      </button>

      {open && (
        <StatusOptionList
          id={panelId}
          label={statusCol ? formatKanbanPropertyName(statusCol) : t('preview.kanban_prop_status')}
          options={options}
          current={statusVal}
          onSelect={(id) => {
            onChangeStatus(id)
            setOpen(false)
          }}
        />
      )}
    </div>
  )
}

function DetailTitleDraft({
  itemId,
  title,
  onChangeTitle,
}: {
  itemId: string
  title: string
  onChangeTitle: (t: string) => void
}) {
  const [draft, setDraft] = useState(title)
  const lastTarget = useRef(itemId)
  const lastSent = useRef(title)
  // Set on the Escape path so the blur that follows does not commit what was just discarded.
  const discarding = useRef(false)
  if (lastTarget.current !== itemId) {
    lastTarget.current = itemId
    lastSent.current = title
    setDraft(title)
  }
  const commitDraft = () => {
    if (discarding.current) {
      discarding.current = false
      return
    }
    if (draft === lastSent.current) return
    lastSent.current = draft
    onChangeTitle(draft)
  }

  return (
    <input
      type='text'
      value={draft}
      data-owns-escape
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commitDraft}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commitDraft()
        if (e.key === 'Escape') {
          setDraft(lastSent.current)
          // The field claims Escape so cancelling a rename does not close the card. It has to give
          // the claim back afterwards, or a reader who tabs into the title can open a card and never
          // Escape out of it — the dialog's own handler is skipped for as long as focus stays here.
          discarding.current = true
          e.currentTarget.blur()
        }
      }}
      className='w-full rounded-[var(--r-xs)] border-0 bg-transparent text-[length:var(--text-18)] font-bold text-[var(--text-primary)] outline-none focus:bg-[var(--bg-inset)] px-[var(--sp-1)]'
      placeholder={t('preview.kanban_card_title')}
    />
  )
}

function DetailHeader({
  itemId,
  icon,
  title,
  statusCol,
  statusVal,
  onChangeIcon,
  onChangeTitle,
  onChangeStatus,
}: {
  itemId: string
  icon?: string
  title: string
  statusCol?: KanbanProperty
  statusVal?: unknown
  onChangeIcon: (icon: string | null) => void
  onChangeTitle: (t: string) => void
  onChangeStatus: (val: string) => void
}) {
  const [iconPickerOpen, setIconPickerOpen] = useState(false)
  const iconBtnRef = useRef<HTMLButtonElement>(null)
  const iconPanelId = useId()

  return (
    <div className='flex flex-col gap-[var(--sp-2-5)]'>
      <DetailStatusDropdown
        statusCol={statusCol}
        statusVal={statusVal}
        onChangeStatus={onChangeStatus}
      />

      <div className='flex items-center gap-[var(--sp-2)]'>
        <button
          ref={iconBtnRef}
          type='button'
          onClick={() => setIconPickerOpen((o) => !o)}
          className='flex size-9 shrink-0 items-center justify-center rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] hover:bg-[var(--bg-hover)]'
          title={t('preview.kanban_icon_picker')}
          aria-haspopup='dialog'
          aria-expanded={iconPickerOpen}
          {...(iconPickerOpen ? { 'aria-controls': iconPanelId } : {})}
        >
          {icon ? <KanbanIconBadge icon={icon} size={20} /> : <Smile size={18} className='text-[var(--text-tertiary)]' />}
        </button>
        <KanbanIconPicker
          open={iconPickerOpen}
          panelId={iconPanelId}
          anchorRef={iconBtnRef}
          onClose={() => setIconPickerOpen(false)}
          onSelectIcon={onChangeIcon}
          currentIcon={icon}
        />
        <DetailTitleDraft itemId={itemId} title={title} onChangeTitle={onChangeTitle} />
      </div>
    </div>
  )
}

interface DetailModalContentProps {
  item: KanbanItem
  columns: KanbanProperty[]
  tagVals: string[]
  priorityCol?: KanbanProperty
  tagsCol?: KanbanProperty
  startDateVal: unknown
  dueDateVal: unknown
  localTagOptions: KanbanOption[]
  onPropertyChange: (propertyId: string, value: unknown) => void
  onAddTagOption: (option: KanbanOption) => void
  onUpdate: (updated: KanbanItem) => void
  onConvertSubtask: (subtaskId: string) => void
  people?: Record<string, string[]>
  renderDescription?: (source: string) => string
  boardItems?: KanbanItem[]
  onChangeDependencies?: (itemId: string, deps: string[]) => void
}

/** The card's lower half: what it carries and what has been said about it. */
function DetailCarrySections({
  item,
  onUpdate,
  onConvertSubtask,
  people,
  boardItems,
  onChangeDependencies,
}: {
  item: KanbanItem
  onUpdate: (updated: KanbanItem) => void
  onConvertSubtask: (subtaskId: string) => void
  people?: Record<string, string[]>
  boardItems?: KanbanItem[]
  onChangeDependencies?: (itemId: string, deps: string[]) => void
}) {
  return (
    <>
      {onChangeDependencies && boardItems && (
        <DetailDependencies
          key={`dependencies-${item.id}`}
          item={item}
          board={boardItems}
          onChange={(deps) => onChangeDependencies(item.id, deps)}
        />
      )}

      <DetailAttachmentsAndSubtasks item={item} onUpdate={onUpdate} onConvertSubtask={onConvertSubtask} />

      <DetailComments key={`comments-${item.id}`} item={item} people={people} onUpdate={onUpdate} />
    </>
  )
}

/** The card's property half: tags, priority, dates, and the columns it carries. */
function DetailPropertySections({
  item,
  tagVals,
  columns,
  priorityCol,
  tagsCol,
  startDateVal,
  dueDateVal,
  localTagOptions,
  onPropertyChange,
  onAddTagOption,
  people,
}: {
  item: KanbanItem
  tagVals: string[]
  columns: KanbanProperty[]
  priorityCol?: KanbanProperty
  tagsCol?: KanbanProperty
  startDateVal: unknown
  dueDateVal: unknown
  localTagOptions: KanbanOption[]
  onPropertyChange: (propertyId: string, value: unknown) => void
  onAddTagOption: (option: KanbanOption) => void
  people?: Record<string, string[]>
}) {
  return (
    <>
      <DetailTagsField
        tagVals={tagVals}
        options={localTagOptions}
        onChangeTags={(nextTags, newOption) => {
          onPropertyChange(tagsCol?.id ?? 'tags', nextTags)
          if (newOption) onAddTagOption(newOption)
        }}
      />

      <PriorityChips
        priorityCol={priorityCol}
        currentPriority={priorityCol ? item.properties[priorityCol.id] : item.properties.priority}
        onChangePriority={(val) => priorityCol && onPropertyChange(priorityCol.id, val)}
      />

      <DetailDatesGrid
        startDateVal={startDateVal}
        dueDateVal={dueDateVal}
        onPropertyChange={onPropertyChange}
      />

      <DetailPropertiesGrid
        columns={columns}
        properties={item.properties}
        people={people}
        onChangeProperty={onPropertyChange}
      />
    </>
  )
}

function DetailModalContent({
  item,
  columns,
  tagVals,
  priorityCol,
  tagsCol,
  startDateVal,
  dueDateVal,
  localTagOptions,
  onPropertyChange,
  onAddTagOption,
  onUpdate,
  onConvertSubtask,
  people,
  renderDescription,
  boardItems,
  onChangeDependencies,
}: DetailModalContentProps) {
  return (
    <div className='flex flex-col gap-[var(--sp-5)] py-[var(--sp-2)]'>
      <DetailPropertySections
        item={item}
        columns={columns}
        tagVals={tagVals}
        priorityCol={priorityCol}
        tagsCol={tagsCol}
        startDateVal={startDateVal}
        dueDateVal={dueDateVal}
        localTagOptions={localTagOptions}
        onPropertyChange={onPropertyChange}
        onAddTagOption={onAddTagOption}
        people={people}
      />

      {/* A box that holds an uncommitted draft is keyed by the card it belongs to, so switching cards
      gives a fresh one. The section name is part of the key because two such boxes sit side by side
      here, and React reads a repeated key as two children being the same child. */}
      <DetailDescription
        key={`description-${item.id}`}
        content={item.content || item.description}
        renderDescription={renderDescription}
        onChange={(desc) => onUpdate({ ...item, content: desc, description: desc })}
      />

      <DetailCarrySections
        item={item}
        onUpdate={onUpdate}
        onConvertSubtask={onConvertSubtask}
        people={people}
        boardItems={boardItems}
        onChangeDependencies={onChangeDependencies}
      />
    </div>
  )
}

function useKanbanDetailState(
  item: KanbanItem | null,
  columns: KanbanProperty[],
  onUpdate: (updated: KanbanItem) => void,
  onAddColumnOption?: (columnId: string, option: KanbanOption) => void,
) {
  const handlePropertyChange = (propertyId: string, value: unknown) => {
    if (!item) return
    onUpdate({ ...item, properties: { ...item.properties, [propertyId]: value } })
  }

  const statusCol = kanbanStatusColumn(columns)
  const priorityCol = kanbanPriorityColumn(columns)
  const tagsCol = kanbanTagsColumn(columns)
  const [localTagOptions, setLocalTagOptions] = useState<KanbanOption[]>(() => tagsCol?.options ?? [])

  useEffect(() => {
    if (tagsCol?.options) {
      setLocalTagOptions(tagsCol.options)
    }
  }, [tagsCol?.options])

  const handleAddTagOption = (newOpt: KanbanOption) => {
    setLocalTagOptions((prev) => {
      if (prev.some((o) => o.id === newOpt.id || o.label === newOpt.label)) return prev
      return [...prev, newOpt]
    })
    if (tagsCol) onAddColumnOption?.(tagsCol.id, newOpt)
  }

  return { statusCol, priorityCol, tagsCol, localTagOptions, handlePropertyChange, handleAddTagOption }
}

function KanbanItemDetailBody({
  item,
  columns,
  onClose,
  onUpdate,
  onDelete,
  onConvertSubtask,
  onAddColumnOption,
  people,
  renderDescription,
  boardItems,
  onChangeDependencies,
  variant = 'dialog',
}: KanbanItemDetailProps & { item: KanbanItem }) {
  const { statusCol, priorityCol, tagsCol, localTagOptions, handlePropertyChange, handleAddTagOption } =
    useKanbanDetailState(item, columns, onUpdate, onAddColumnOption)

  const tagVals = tagsCol && Array.isArray(item.properties[tagsCol.id]) ? (item.properties[tagsCol.id] as string[]) : []
  const startDateVal = item.properties.startDate || ''
  const dueDateVal = getKanbanDueDate(item)

  const header = (
    <DetailHeader
      itemId={item.id}
      icon={item.icon}
      title={item.title}
      statusCol={statusCol}
      statusVal={item.properties.status}
      onChangeIcon={(icon) => onUpdate({ ...item, icon: icon ?? undefined })}
      onChangeTitle={(title) => onUpdate({ ...item, title })}
      onChangeStatus={(val) => handlePropertyChange('status', val)}
    />
  )
  const footer = <DetailFooter onDelete={() => { onDelete(item.id); onClose() }} onClose={onClose} />
  const content = (
    <DetailModalContent
      item={item}
      columns={columns}
      tagVals={tagVals}
      priorityCol={priorityCol}
      tagsCol={tagsCol}
      startDateVal={startDateVal}
      dueDateVal={dueDateVal}
      localTagOptions={localTagOptions}
      onPropertyChange={handlePropertyChange}
      onAddTagOption={handleAddTagOption}
      onUpdate={onUpdate}
      onConvertSubtask={onConvertSubtask}
      people={people}
      renderDescription={renderDescription}
      boardItems={boardItems}
      onChangeDependencies={onChangeDependencies}
    />
  )

  const shell = { onClose, header, content, footer }
  return variant === 'peek' ? <KanbanCardPeek {...shell} /> : <KanbanCardDialog {...shell} />
}

export const KanbanItemDetail = memo(function KanbanItemDetail(props: KanbanItemDetailProps) {
  useLocaleRepaint()
  if (!props.item) return null
  return <KanbanItemDetailBody {...props} item={props.item} />
})
