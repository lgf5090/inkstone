/**
 * The calendar sidebar: app-native React beside DayFlow rather than the library's sidebar plugin.
 *
 * It reads the live DayFlow registry for order, visibility and colours, and the API metadata for
 * grouping and revisions. Visibility and reordering go through `app.updateCalendar` /
 * `app.reorderCalendars`; the surface's callbacks persist them, which keeps one write per gesture.
 */
import { useEffect, useReducer, useState, type ReactNode } from 'react'
import { ChevronDown, Lock, MoreHorizontal, Plus, RefreshCw, Rss, Search, Settings, Star, Trash2 } from 'lucide-react'
import type { CalendarType, ICalendarApp } from '@dayflow/react'
import type {
  CalendarDto,
  CalendarGroupDto,
  CalendarMetaDto,
  CalendarPreferences,
  CalendarSubscriptionDto,
} from '@shared/calendar/model'
import { cn } from '../../lib/cn'
import { t, useLocaleRepaint } from '../../lib/i18n'
import { useThemeDark } from '../../lib/hooks'
import { useUi } from '../../store/ui'
import { Button, IconButton, SectionLabel } from '../../components/primitives'
import { Menu, Tooltip, confirm, type MenuItem, submenuFor } from '../../components/overlay'
import { Checkbox } from '../../components/form'
import { MiniMonth } from './MiniMonth'
import {
  CalendarFormDialog,
  DeleteCalendarDialog,
  GroupDialog,
  ImportIcsDialog,
  SubscribeDialog,
} from './CalendarDialogs'
import * as api from './api'

type DialogState =
  | { kind: 'create-calendar'; groupId: string | null }
  | { kind: 'edit-calendar'; calendar: CalendarDto }
  | { kind: 'delete-calendar'; calendar: CalendarDto }
  | { kind: 'create-group' }
  | { kind: 'rename-group'; group: CalendarGroupDto }
  | null

interface CalendarSidebarProps {
  app: ICalendarApp
  meta: CalendarMetaDto
  preferences: CalendarPreferences
  variant: 'inline' | 'drawer'
  collapsed: boolean
  onToggleCollapsed: () => void
  onClose: () => void
  onOpenSettings: () => void
  onOpenFilteredSearch: () => void
  /** Refresh meta and the DayFlow registry; `reloadEvents` also refetches the visible range. */
  onRefresh: (reloadEvents: boolean) => Promise<void>
  onSelectDate: (date: Date) => void
  onRequestRange?: (from: number, to: number) => void
}

function toastFailure(title: string, error: unknown): void {
  useUi.getState().toast({
    title,
    description: error instanceof Error && error.message ? error.message : undefined,
    tone: 'danger',
  })
}

function feedHost(raw: string | null): string | null {
  if (!raw) return null
  try {
    return new URL(raw).hostname
  } catch {
    return null
  }
}

function safeFileName(name: string): string {
  const cleaned = name.replaceAll(/[\\/?%*:|"<>\u0000-\u001f]/g, '_').trim().slice(0, 120)
  return cleaned || 'calendar'
}

function downloadIcs(name: string, content: string): void {
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${safeFileName(name)}.ics`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function AddMenu({ onPick, compact }: { onPick: (kind: 'calendar' | 'group' | 'import' | 'subscribe') => void; compact?: boolean }) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null)
  const items: MenuItem[] = [
    { id: 'new-calendar', label: t('calendar.sidebar.new_calendar'), onSelect: () => onPick('calendar') },
    { id: 'new-group', label: t('calendar.sidebar.new_group'), onSelect: () => onPick('group') },
    { id: 'import', label: t('calendar.sidebar.import'), separatorBefore: true, onSelect: () => onPick('import') },
    { id: 'subscribe', label: t('calendar.sidebar.subscribe'), onSelect: () => onPick('subscribe') },
  ]
  return (
    <>
      <Tooltip label={t('calendar.sidebar.add')} side={compact ? 'right' : 'bottom'}>
        <IconButton
          size="sm"
          label={t('calendar.sidebar.add')}
          aria-haspopup="menu"
          aria-expanded={point !== null}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setPoint({ x: rect.left, y: rect.bottom + 4 })
          }}
        >
          <Plus size={15} />
        </IconButton>
      </Tooltip>
      <Menu
        open={point !== null}
        anchor={point ?? { x: 0, y: 0 }}
        onClose={() => setPoint(null)}
        items={items}
        label={t('calendar.sidebar.add')}
      />
    </>
  )
}

function groupItems(canUp: boolean, canDown: boolean, onAction: (action: 'rename' | 'new' | 'up' | 'down' | 'delete') => void): MenuItem[] {
  return [
    { id: 'rename', label: t('calendar.group.rename'), onSelect: () => onAction('rename') },
    { id: 'new', label: t('calendar.sidebar.new_calendar'), onSelect: () => onAction('new') },
    { id: 'up', label: t('calendar.sidebar.move_up'), disabled: !canUp, separatorBefore: true, onSelect: () => onAction('up') },
    { id: 'down', label: t('calendar.sidebar.move_down'), disabled: !canDown, onSelect: () => onAction('down') },
    { id: 'delete', label: t('calendar.group.delete'), tone: 'danger', separatorBefore: true, onSelect: () => onAction('delete') },
  ]
}

export function CalendarSidebar({
  app,
  meta,
  preferences,
  variant,
  collapsed,
  onToggleCollapsed,
  onClose,
  onOpenSettings,
  onOpenFilteredSearch,
  onRefresh,
  onSelectDate,
  onRequestRange,
}: CalendarSidebarProps) {
  useLocaleRepaint()
  const dark = useThemeDark()
  const [version, bumpVersion] = useReducer((value: number) => value + 1, 0)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [subscribeOpen, setSubscribeOpen] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropId, setDropId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [groupMenu, setGroupMenu] = useState<{ id: string; x: number; y: number } | null>(null)

  useEffect(() => app.subscribe(() => bumpVersion()), [app])

  const calendars = app.getCalendars()
  const currentDate = app.getCurrentDate()
  const groups = [...meta.groups].sort((left, right) => left.position - right.position)
  const metaById = new Map(meta.calendars.map(calendar => [calendar.id, calendar]))
  const groupOf = (calendar: CalendarType): string | null => metaById.get(calendar.id)?.groupId ?? null
  const calendarColor = (calendar: CalendarType): string =>
    app.getCalendarRegistry().resolveColors(calendar.id, dark ? 'dark' : 'light').eventColor

  const openAddMenu = (kind: 'calendar' | 'group' | 'import' | 'subscribe'): void => {
    if (kind === 'calendar') setDialog({ kind: 'create-calendar', groupId: null })
    else if (kind === 'group') setDialog({ kind: 'create-group' })
    else if (kind === 'import') setImportOpen(true)
    else setSubscribeOpen(true)
  }

  const changeGroupOrder = async (group: CalendarGroupDto, delta: -1 | 1): Promise<void> => {
    const ids = groups.map(item => item.id)
    const from = ids.indexOf(group.id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= ids.length) return
    const next = [...ids]
    const [moved] = next.splice(from, 1)
    if (!moved) return
    next.splice(to, 0, moved)
    try {
      await api.reorderGroups(next)
      await onRefresh(false)
    } catch (error) {
      toastFailure(t('calendar.group.failed'), error)
    }
  }

  const deleteGroup = async (group: CalendarGroupDto): Promise<void> => {
    const confirmed = await confirm({
      title: t('calendar.group.delete'),
      description: t('calendar.group.delete_confirm', { name: group.name }),
      tone: 'danger',
    })
    if (!confirmed) return
    try {
      await api.deleteGroup(group.id)
      useUi.getState().toast({ title: t('calendar.group.deleted'), tone: 'success' })
      await onRefresh(false)
    } catch (error) {
      toastFailure(t('calendar.group.failed'), error)
    }
  }

  const moveCalendar = (calendarId: string, delta: -1 | 1): void => {
    const calendar = app.getCalendars().find(item => item.id === calendarId)
    if (!calendar) return
    const family = app.getCalendars().filter(item => groupOf(item) === groupOf(calendar))
    const local = family.findIndex(item => item.id === calendarId)
    const neighbour = family[local + delta]
    if (!neighbour) return
    const ids = app.getCalendars().map(item => item.id)
    app.reorderCalendars(ids.indexOf(calendarId), ids.indexOf(neighbour.id))
  }

  const dropCalendar = (targetId: string): void => {
    const sourceId = dragId
    setDragId(null)
    setDropId(null)
    if (!sourceId || sourceId === targetId) return
    const source = app.getCalendars().find(item => item.id === sourceId)
    const target = app.getCalendars().find(item => item.id === targetId)
    // Dragging across a group boundary would reorder a calendar that stays in the other group; the
    // "Move to group" menu is the explicit way to change membership.
    if (!source || !target || groupOf(source) !== groupOf(target)) return
    const ids = app.getCalendars().map(item => item.id)
    const from = ids.indexOf(sourceId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    app.reorderCalendars(from, to)
  }

  const makeDefault = async (calendar: CalendarDto): Promise<void> => {
    try {
      await api.updateCalendar(calendar.id, { isDefault: true }, calendar.rev)
      useUi.getState().toast({ title: t('calendar.calendar.default_updated'), tone: 'success' })
      await onRefresh(false)
    } catch (error) {
      toastFailure(t('calendar.calendar.action_failed'), error)
    }
  }

  const moveToGroup = async (calendar: CalendarDto, groupId: string | null): Promise<void> => {
    try {
      await api.updateCalendar(calendar.id, { groupId }, calendar.rev)
      await onRefresh(false)
    } catch (error) {
      toastFailure(t('calendar.calendar.action_failed'), error)
    }
  }

  const exportCalendar = async (calendar: CalendarType): Promise<void> => {
    try {
      const content = await api.exportIcs(calendar.id)
      downloadIcs(calendar.name, content)
      useUi.getState().toast({ title: t('calendar.calendar.exported', { name: calendar.name }), tone: 'success' })
    } catch (error) {
      toastFailure(t('calendar.calendar.export_failed'), error)
    }
  }

  const refreshSubscription = async (subscription: CalendarSubscriptionDto): Promise<void> => {
    try {
      await api.refreshSubscription(subscription.id)
      useUi.getState().toast({ title: t('calendar.subscription.refreshed'), tone: 'success' })
      await onRefresh(true)
    } catch (error) {
      toastFailure(t('calendar.subscription.refresh_failed'), error)
    }
  }

  const setSubscriptionEnabled = async (subscription: CalendarSubscriptionDto, enabled: boolean): Promise<void> => {
    try {
      await api.setSubscriptionEnabled(subscription.id, enabled)
      useUi.getState().toast({
        title: t(enabled ? 'calendar.subscription.enabled_done' : 'calendar.subscription.disabled'),
        tone: 'success',
      })
      await onRefresh(false)
    } catch (error) {
      toastFailure(t('calendar.subscription.toggle_failed'), error)
    }
  }

  const removeSubscription = async (subscription: CalendarSubscriptionDto): Promise<void> => {
    const calendar = metaById.get(subscription.calendarId)
    const confirmed = await confirm({
      title: t('calendar.subscription.remove_title'),
      description: t('calendar.subscription.remove_body', { name: calendar?.name ?? feedHost(subscription.url) ?? subscription.kind }),
      confirmLabel: t('calendar.subscription.remove'),
      tone: 'danger',
    })
    if (!confirmed) return
    try {
      await api.deleteSubscription(subscription.id)
      useUi.getState().toast({ title: t('calendar.subscription.removed'), tone: 'success' })
      await onRefresh(true)
    } catch (error) {
      toastFailure(t('calendar.subscription.remove_failed'), error)
    }
  }

  const calendarMenu = (calendar: CalendarType): MenuItem[] => {
    const dto = metaById.get(calendar.id)
    const items: MenuItem[] = [
      {
        id: 'default',
        label: t('calendar.calendar.make_default'),
        disabled: calendar.isDefault || !dto,
        onSelect: () => { if (dto) void makeDefault(dto) },
      },
      {
        id: 'rename',
        label: t('calendar.calendar.rename'),
        disabled: !dto,
        separatorBefore: true,
        onSelect: () => { if (dto) setDialog({ kind: 'edit-calendar', calendar: dto }) },
      },
      {
        id: 'color',
        label: t('calendar.calendar.change_color'),
        disabled: !dto,
        onSelect: () => { if (dto) setDialog({ kind: 'edit-calendar', calendar: dto }) },
      },
      {
        id: 'group',
        label: t('calendar.calendar.move_to_group'),
        disabled: !dto,
        submenu: submenuFor([
          { id: 'none', label: t('calendar.calendar.no_group'), checked: dto?.groupId == null, onSelect: () => { if (dto) void moveToGroup(dto, null) } },
          ...groups.map(group => ({
            id: group.id,
            label: group.name,
            checked: dto?.groupId === group.id,
            onSelect: () => { if (dto) void moveToGroup(dto, group.id) },
          })),
        ]),
        subItems: [
          { id: 'none', label: t('calendar.calendar.no_group'), onSelect: () => { if (dto) void moveToGroup(dto, null) } },
          ...groups.map(group => ({ id: group.id, label: group.name, onSelect: () => { if (dto) void moveToGroup(dto, group.id) } })),
        ],
      },
      {
        id: 'move-up',
        label: t('calendar.sidebar.move_up'),
        disabled: !dto || (() => {
          const family = app.getCalendars().filter(item => groupOf(item) === groupOf(calendar))
          return family.findIndex(item => item.id === calendar.id) <= 0
        })(),
        onSelect: () => moveCalendar(calendar.id, -1),
      },
      {
        id: 'move-down',
        label: t('calendar.sidebar.move_down'),
        disabled: !dto || (() => {
          const family = app.getCalendars().filter(item => groupOf(item) === groupOf(calendar))
          const index = family.findIndex(item => item.id === calendar.id)
          return index < 0 || index >= family.length - 1
        })(),
        onSelect: () => moveCalendar(calendar.id, 1),
      },
      {
        id: 'merge',
        label: t('calendar.calendar.merge'),
        disabled: !dto || meta.calendars.length < 2,
        separatorBefore: true,
        onSelect: () => { if (dto) setDialog({ kind: 'delete-calendar', calendar: dto }) },
      },
      { id: 'export', label: t('calendar.calendar.export'), onSelect: () => { void exportCalendar(calendar) } },
      {
        id: 'delete',
        label: t('calendar.calendar.delete'),
        tone: 'danger',
        disabled: !dto,
        separatorBefore: true,
        onSelect: () => { if (dto) setDialog({ kind: 'delete-calendar', calendar: dto }) },
      },
    ]
    return items
  }

  if (collapsed && variant === 'inline') {
    return (
      <aside
        aria-label={t('calendar.sidebar.title')}
        className="flex h-full min-h-0 w-12 shrink-0 flex-col items-center gap-1 border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] py-2"
      >
        <Tooltip label={t('calendar.sidebar.expand')} side="right">
          <IconButton label={t('calendar.sidebar.expand')} size="sm" aria-expanded={false} onClick={onToggleCollapsed}>
            <ChevronDown size={15} className="rotate-[-90deg]" aria-hidden="true" />
          </IconButton>
        </Tooltip>
        <AddMenu compact onPick={openAddMenu} />
        <Tooltip label={t('calendar.filtered_search.open')} side="right">
          <IconButton label={t('calendar.filtered_search.open')} size="sm" onClick={onOpenFilteredSearch}>
            <Search size={15} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('calendar.sidebar.settings')} side="right">
          <IconButton label={t('calendar.sidebar.settings')} size="sm" onClick={onOpenSettings}>
            <Settings size={15} />
          </IconButton>
        </Tooltip>
      </aside>
    )
  }

  return (
    <aside
      aria-label={t('calendar.sidebar.title')}
      className={cn(
        'flex h-full min-h-0 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]',
        variant === 'drawer' ? 'w-full' : 'w-60',
      )}
    >
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-2">
        {variant === 'inline'
          ? (
              <Tooltip label={t('calendar.sidebar.collapse')} side="bottom">
                <IconButton
                  label={t('calendar.sidebar.collapse')}
                  size="sm"
                  aria-expanded
                  onClick={onToggleCollapsed}
                >
                  <ChevronDown size={15} className="rotate-90" aria-hidden="true" />
                </IconButton>
              </Tooltip>
            )
          : (
              <Tooltip label={t('calendar.sidebar.close')} side="bottom">
                <IconButton label={t('calendar.sidebar.close')} size="sm" onClick={onClose}>
                  <ChevronDown size={15} className="rotate-90" aria-hidden="true" />
                </IconButton>
              </Tooltip>
            )}
        <h2 className="min-w-0 flex-1 truncate px-1 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('calendar.sidebar.title')}
        </h2>
        <Tooltip label={t('calendar.filtered_search.open')} side="bottom">
          <IconButton label={t('calendar.filtered_search.open')} size="sm" onClick={onOpenFilteredSearch}>
            <Search size={15} />
          </IconButton>
        </Tooltip>
        <AddMenu onPick={openAddMenu} />
        <Tooltip label={t('calendar.sidebar.settings')} side="bottom">
          <IconButton label={t('calendar.sidebar.settings')} size="sm" onClick={onOpenSettings}>
            <Settings size={15} />
          </IconButton>
        </Tooltip>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {preferences.showMiniCalendar && (
          <MiniMonth
            app={app}
            currentDate={currentDate}
            weekStart={preferences.weekStart}
            timeZone={preferences.timeZone}
            showEventDots={preferences.showEventDots}
            version={version}
            onSelectDate={onSelectDate}
            onRequestRange={onRequestRange}
          />
        )}

        <div role="group" aria-label={t('calendar.a11y.calendar_list')} className="px-2">
          <SectionLabel>{t('calendar.sidebar.calendars')}</SectionLabel>

          {groups.map((group, groupIndex) => {
            const groupCalendars = calendars.filter(calendar => groupOf(calendar) === group.id)
            return (
              <section key={group.id} aria-label={group.name} className="mb-1">
                <div className="group flex items-center gap-0.5 rounded-[var(--r-sm)] px-1 hover:bg-[var(--bg-hover)]">
                  <span className="min-w-0 flex-1 truncate py-1 text-[length:var(--text-11)] font-semibold tracking-[0.03em] text-[var(--text-tertiary)]">
                    {group.name}
                  </span>
                  <IconButton
                    size="xs"
                    label={t('calendar.sidebar.more', { name: group.name })}
                    aria-haspopup="menu"
                    aria-expanded={groupMenu?.id === group.id}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect()
                      setGroupMenu({ id: group.id, x: rect.right, y: rect.bottom })
                    }}
                  >
                    <MoreHorizontal size={13} />
                  </IconButton>
                </div>
                <ul className="mt-0.5 space-y-0.5">
                  {groupCalendars.map(calendar => renderCalendar(calendar))}
                </ul>
                {groupMenu?.id === group.id && (
                  <Menu
                    open
                    anchor={{ x: groupMenu.x, y: groupMenu.y }}
                    onClose={() => setGroupMenu(null)}
                    label={t('calendar.sidebar.more', { name: group.name })}
                    items={groupItems(groupIndex > 0, groupIndex < groups.length - 1, action => {
                      setGroupMenu(null)
                      if (action === 'rename') setDialog({ kind: 'rename-group', group })
                      else if (action === 'new') setDialog({ kind: 'create-calendar', groupId: group.id })
                      else if (action === 'up') void changeGroupOrder(group, -1)
                      else if (action === 'down') void changeGroupOrder(group, 1)
                      else void deleteGroup(group)
                    })}
                  />
                )}
              </section>
            )
          })}

          {calendars.some(calendar => groupOf(calendar) === null) && (
            <section aria-label={t('calendar.sidebar.ungrouped')} className="mb-1">
              {groups.length > 0 && <SectionLabel>{t('calendar.sidebar.ungrouped')}</SectionLabel>}
              <ul className="space-y-0.5">
                {calendars.filter(calendar => groupOf(calendar) === null).map(calendar => renderCalendar(calendar))}
              </ul>
            </section>
          )}

          {meta.subscriptions.length > 0 && (
            <>
              <SectionLabel>{t('calendar.sidebar.subscriptions')}</SectionLabel>
              <ul className="space-y-0.5 pb-1">
                {meta.subscriptions.map(subscription => {
                  const calendar = metaById.get(subscription.calendarId)
                  return (
                    <li key={subscription.id} className="flex items-center gap-1.5 px-1 py-1 text-[length:var(--text-12)] text-[var(--text-secondary)]">
                      <Checkbox
                        checked={subscription.enabled}
                        onChange={enabled => void setSubscriptionEnabled(subscription, enabled)}
                        label={<span className="sr-only">{t('calendar.subscription.enabled')}</span>}
                      />
                      <Rss size={12} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{calendar?.name ?? feedHost(subscription.url) ?? subscription.kind}</span>
                      {subscription.kind === 'ics' && (
                        <>
                          <IconButton
                            size="sm"
                            label={t('calendar.subscription.refresh')}
                            disabled={!subscription.enabled}
                            onClick={() => void refreshSubscription(subscription)}
                          >
                            <RefreshCw size={12} />
                          </IconButton>
                          <IconButton
                            size="sm"
                            label={t('calendar.subscription.remove')}
                            onClick={() => void removeSubscription(subscription)}
                          >
                            <Trash2 size={12} />
                          </IconButton>
                        </>
                      )}
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>
      </div>

      <footer className="flex shrink-0 items-center gap-1 border-t border-[var(--border-subtle)] px-2 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          icon={<Settings size={14} aria-hidden="true" />}
          onClick={onOpenSettings}
          className="min-w-0"
        >
          <span className="truncate">{t('calendar.sidebar.settings')}</span>
        </Button>
      </footer>

      {dialog?.kind === 'create-calendar' && (
        <CalendarFormDialog
          open
          mode="create"
          groups={groups}
          defaultGroupId={dialog.groupId}
          onClose={() => setDialog(null)}
          onSaved={() => onRefresh(false)}
        />
      )}
      {dialog?.kind === 'edit-calendar' && (
        <CalendarFormDialog
          open
          mode="edit"
          calendar={dialog.calendar}
          groups={groups}
          onClose={() => setDialog(null)}
          onSaved={() => onRefresh(false)}
        />
      )}
      {dialog?.kind === 'delete-calendar' && (
        <DeleteCalendarDialog
          open
          calendar={dialog.calendar}
          calendars={meta.calendars}
          onClose={() => setDialog(null)}
          onSaved={() => onRefresh(true)}
        />
      )}
      {dialog?.kind === 'create-group' && (
        <GroupDialog
          open
          mode="create"
          onClose={() => setDialog(null)}
          onSaved={() => onRefresh(false)}
        />
      )}
      {dialog?.kind === 'rename-group' && (
        <GroupDialog
          open
          mode="rename"
          group={dialog.group}
          onClose={() => setDialog(null)}
          onSaved={() => onRefresh(false)}
        />
      )}
      {importOpen && (
        <ImportIcsDialog
          open
          calendars={meta.calendars}
          defaultTimeZone={preferences.timeZone}
          onClose={() => setImportOpen(false)}
          onSaved={() => onRefresh(true)}
        />
      )}
      {subscribeOpen && (
        <SubscribeDialog
          open
          onClose={() => setSubscribeOpen(false)}
          onSaved={() => onRefresh(true)}
        />
      )}
    </aside>
  )

  function renderCalendar(calendar: CalendarType): ReactNode {
    const visible = calendar.isVisible !== false
    const readOnly = calendar.readOnly === true
    const subscribed = subscriptionFor(calendar.id)
    const menuOpen = menu?.id === calendar.id
    return (
      <li
        key={calendar.id}
        onDragOver={(event) => {
          if (dragId && dragId !== calendar.id) {
            event.preventDefault()
            setDropId(calendar.id)
          }
        }}
        onDragLeave={() => setDropId(current => (current === calendar.id ? null : current))}
        onDrop={(event) => {
          event.preventDefault()
          dropCalendar(calendar.id)
        }}
        className={cn('rounded-[var(--r-sm)]', dropId === calendar.id && 'ring-1 ring-[var(--accent)]')}
      >
        <div className="group flex items-center gap-0.5 rounded-[var(--r-sm)] pr-0.5 hover:bg-[var(--bg-hover)]">
          <button
            type="button"
            draggable
            aria-label={t('calendar.sidebar.reorder_calendar', { name: calendar.name })}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', calendar.id)
              setDragId(calendar.id)
            }}
            onDragEnd={() => {
              setDragId(null)
              setDropId(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                moveCalendar(calendar.id, -1)
              } else if (event.key === 'ArrowDown') {
                event.preventDefault()
                moveCalendar(calendar.id, 1)
              }
            }}
            className="flex size-5 shrink-0 cursor-grab items-center justify-center rounded text-[var(--text-quaternary)] opacity-40 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)] active:cursor-grabbing"
          >
            <span aria-hidden="true" className="text-[length:var(--text-10)] leading-none">⠿</span>
          </button>
          <Checkbox
            checked={visible}
            onChange={(next) => app.updateCalendar(calendar.id, { isVisible: next })}
            className="min-w-0 flex-1"
            label={(
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: calendarColor(calendar) }}
                  aria-hidden="true"
                />
                <span className="max-w-[124px] truncate">{calendar.name}</span>
                <span className="sr-only">{t('calendar.sidebar.visibility')}</span>
                {readOnly && (
                  <Tooltip label={t('calendar.sidebar.read_only')}>
                    <span className="shrink-0 text-[var(--text-quaternary)]">
                      <Lock size={10} aria-hidden="true" />
                      <span className="sr-only">{t('calendar.sidebar.read_only')}</span>
                    </span>
                  </Tooltip>
                )}
                {subscribed && (
                  <Tooltip label={t('calendar.sidebar.subscribed')}>
                    <span className="shrink-0 text-[var(--text-quaternary)]">
                      <Rss size={10} aria-hidden="true" />
                      <span className="sr-only">{t('calendar.sidebar.subscribed')}</span>
                    </span>
                  </Tooltip>
                )}
                {calendar.isDefault && (
                  <Tooltip label={t('calendar.sidebar.default')}>
                    <span className="shrink-0 text-[var(--accent)]">
                      <Star size={10} aria-hidden="true" />
                      <span className="sr-only">{t('calendar.sidebar.default')}</span>
                    </span>
                  </Tooltip>
                )}
              </span>
            )}
          />
          <IconButton
            size="xs"
            label={t('calendar.sidebar.more', { name: calendar.name })}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setMenu({ id: calendar.id, x: rect.right, y: rect.bottom })
            }}
          >
            <MoreHorizontal size={13} />
          </IconButton>
        </div>
        {menuOpen && (
          <Menu
            open
            anchor={{ x: menu.x, y: menu.y }}
            onClose={() => setMenu(null)}
            label={t('calendar.sidebar.more', { name: calendar.name })}
            items={calendarMenu(calendar)}
          />
        )}
      </li>
    )
  }

  function subscriptionFor(calendarId: string) {
    return meta.subscriptions.find(subscription => subscription.calendarId === calendarId)
  }
}
