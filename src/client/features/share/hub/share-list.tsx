import { useEffect, useRef, useState } from 'react'
import {
  CalendarClock,
  Check,
  Copy,
  ExternalLink,
  Eye,
  Globe,
  Hash,
  KeyRound,
  Link2,
  Pause,
  TriangleAlert,
} from 'lucide-react'
import type { ShareFolder, ShareTag } from '@shared/share-hub'
import type { ShareListItem } from '@shared/types'
import { Badge, Button, IconButton } from '../../../components/primitives'
import { Tooltip } from '../../../components/overlay'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { Checkbox } from '../../../components/form'
import { fullTime, relativeTime } from '../../../lib/time'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { COPY_RESET_MS } from '../../../lib/motion'
import { RowMenu } from './row-menu'
import type { ShareViewMode } from './use-share-hub'

/**
 * The hub's list of published links, as a table or as cards over the same rows.
 *
 * One component owns both because the two are the same data with a different emphasis, and a separate
 * grid would be a second place for "expired", "paused" and "locked" to be spelled — the three states
 * an owner reads most often and the three that must mean the same thing in either layout.
 */

export interface ShareListProps {
  loading: boolean
  failed: boolean
  rows: ShareListItem[]
  view: ShareViewMode
  selected: ReadonlySet<string>
  folders: ShareFolder[]
  tags: ShareTag[]
  onToggle: (noteId: string) => void
  onToggleAll: () => void
  onEdit: (noteId: string) => void
  onAnalytics: (noteId: string) => void
  onVisits: (noteId: string) => void
  onQr: (row: ShareListItem) => void
  onAudit: (noteId: string) => void
  onToggleEnabled: (row: ShareListItem) => void
  onRevoke: (row: ShareListItem) => void
  onRetry: () => void
  /** The category the empty state describes; it decides which of three messages is the honest one. */
  emptyFor: string
}

export function ShareList(props: ShareListProps) {
  if (props.loading) return <LoadingBlock label={t('share.hub_loading')}/>
  if (props.failed) {
    return (
      <Empty
        art="notes"
        title={t('share.hub_load_failed')}
        description={t('share.hub_load_failed_desc')}
        action={<Button size="sm" variant="secondary" onClick={props.onRetry}>{t('common.retry')}</Button>}
      />
    )
  }
  if (!props.rows.length) {
    return (
      <Empty
        art="notes"
        title={t('share.hub_empty_title')}
        description={t('share.hub_empty_desc', { category: props.emptyFor })}
      />
    )
  }
  return props.view === 'grid'
    ? <ShareGrid {...props}/>
    : <ShareTable {...props}/>
}

/**
 * The table.
 *
 * A real `<table>` with a header cell per column and a row header per link: the hub's whole job is
 * comparing a set of links against each other, and a list of divs cannot be read across by a screen
 * reader or by a keyboard user who wants to know which column a number sits in.
 */
function ShareTable(props: ShareListProps) {
  const allSelected = props.rows.every((row) => props.selected.has(row.noteId))
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-separate border-spacing-0 text-[length:var(--text-12)]">
        <caption className="sr-only">{t('share.hub_table_caption')}</caption>
        <thead>
          <tr className="text-left text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            <th scope="col" className={CELL_HEAD}>
              <RowCheckbox
                checked={allSelected}
                label={t('share.hub_select_all')}
                onChange={props.onToggleAll}
              />
            </th>
            <th scope="col" className={CELL_HEAD}>{t('share.hub_col_note')}</th>
            <th scope="col" className={CELL_HEAD}>{t('share.hub_col_link')}</th>
            <th scope="col" className={CELL_HEAD}>{t('share.hub_col_filing')}</th>
            <th scope="col" className={cn(CELL_HEAD, 'text-right')}>{t('share.hub_col_views')}</th>
            <th scope="col" className={CELL_HEAD}>{t('share.hub_col_last_viewed')}</th>
            <th scope="col" className={CELL_HEAD}>{t('share.hub_col_expires')}</th>
            <th scope="col" className={cn(CELL_HEAD, 'w-10')}>
              <span className="sr-only">{t('share.hub_col_actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <ShareTableRow key={row.slug} row={row} {...props}/>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const CELL_HEAD = 'sticky top-0 z-[var(--z-sticky)] border-b border-[var(--border-subtle)] bg-[var(--bg-base)] px-2.5 py-2 font-medium'
const CELL = 'border-b border-[var(--border-subtle)] px-2.5 py-2 align-middle'

function ShareTableRow(props: ShareListProps & { row: ShareListItem }) {
  const { row } = props
  const selected = props.selected.has(row.noteId)
  return (
    <tr className={cn(selected && 'bg-[var(--accent-soft)]')}>
      <th scope="row" className={cn(CELL, 'w-9 font-normal')}>
        <RowCheckbox
          checked={selected}
          label={t('share.hub_select_row', { title: row.noteTitle || t('common.untitled_note') })}
          onChange={() => props.onToggle(row.noteId)}
        />
      </th>
      <td className={cn(CELL, 'max-w-[240px]')}>
        <span className="block truncate text-[var(--text-primary)]">
          {row.noteTitle || t('common.untitled_note')}
        </span>
        {row.deletedAt !== null && (
          <span className="mt-0.5 block text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
            {t('share.hub_note_in_trash')}
          </span>
        )}
      </td>
      <td className={CELL}><LinkState row={row}/></td>
      <td className={CELL}><Filing row={row} folders={props.folders} tags={props.tags}/></td>
      <td className={cn(CELL, 'text-right tabular-nums text-[var(--text-secondary)]')}>{row.views}</td>
      <td className={cn(CELL, 'text-[var(--text-tertiary)]')}>
        {row.lastViewedAt ? relativeTime(row.lastViewedAt) : t('share.hub_never_viewed')}
      </td>
      <td className={cn(CELL, 'text-[var(--text-tertiary)]')}><Expiry row={row}/></td>
      <td className={cn(CELL, 'group relative p-0')}>
        <RowMenu
          label={t('share.hub_row_menu_label', { title: row.noteTitle || t('common.untitled_note') })}
          items={rowActions(props, row)}
        />
      </td>
    </tr>
  )
}

/** The row actions, from the handlers alone: the table and the card select rows differently. */
type RowActions = Pick<ShareListProps,
  'onEdit' | 'onAnalytics' | 'onVisits' | 'onQr' | 'onAudit' | 'onToggleEnabled' | 'onRevoke'>

function rowActions(props: RowActions, row: ShareListItem) {
  return [
    { id: 'edit', label: t('share.hub_action_edit'), onSelect: () => props.onEdit(row.noteId) },
    { id: 'analytics', label: t('share.hub_action_analytics'), onSelect: () => props.onAnalytics(row.noteId) },
    { id: 'visits', label: t('share.hub_action_visits'), onSelect: () => props.onVisits(row.noteId) },
    { id: 'qr', label: t('share.hub_action_qr'), onSelect: () => props.onQr(row) },
    { id: 'copy', label: t('common.copy'), onSelect: () => void navigator.clipboard.writeText(row.url) },
    {
      id: 'pause',
      label: row.isEnabled ? t('share.hub_action_pause') : t('share.hub_action_resume'),
      onSelect: () => props.onToggleEnabled(row),
    },
    { id: 'audit', label: t('share.hub_action_history'), onSelect: () => props.onAudit(row.noteId) },
    { id: 'revoke', label: t('share.revoke_link'), tone: 'danger' as const, onSelect: () => props.onRevoke(row) },
  ]
}

/** The link's own state, in the order an owner scans for it: broken, then off, then locked, then live. */
function LinkState({ row }: { row: ShareListItem }) {
  const expired = row.expiresAt !== null && row.expiresAt <= Date.now()
  if (expired) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[var(--danger)]">
        <TriangleAlert size={12} aria-hidden/>{t('share.expired')}
      </span>
    )
  }
  if (!row.isEnabled) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[var(--text-quaternary)]">
        <Pause size={12} aria-hidden/>{t('share.hub_state_paused')}
      </span>
    )
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Tooltip label={row.url} side="top">
        <a
          href={row.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-w-0 items-center gap-1.5 text-[var(--accent)] hover:underline"
        >
          {row.hasPassword
            ? <KeyRound size={12} aria-hidden/>
            : <Globe size={12} aria-hidden/>}
          <span className="truncate font-mono text-[length:var(--text-11)]">{`/s/${row.slug}`}</span>
        </a>
      </Tooltip>
      <CopyButton url={row.url}/>
    </span>
  )
}

function CopyButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <IconButton
      label={copied ? t('common.copied') : t('common.copy')}
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(url)
        setCopied(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), COPY_RESET_MS)
      }}
    >
      {copied ? <Check size={12} className="text-[var(--success)]"/> : <Copy size={12}/>}
    </IconButton>
  )
}

/**
 * The filing, resolved against the organizer rows the hub already holds.
 *
 * A folder id with no row renders as unfiled rather than as the id: an id on screen is a number the
 * owner cannot read, and the case where it happens — a folder deleted from another device while this
 * panel stayed open — is exactly when a raw id would look like a bug in the data rather than a stale view.
 */
function Filing({ row, folders, tags }: {
  row: ShareListItem
  folders: ShareFolder[]
  tags: ShareTag[]
}) {
  const folder = row.folderId ? folders.find((entry) => entry.id === row.folderId) : null
  const knownTags = row.tags.filter((name) => tags.some((tag) => tag.name === name))
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {folder
        ? <span className="inline-flex items-center gap-1 text-[var(--text-tertiary)]"><Link2 size={11} aria-hidden/>{folder.name}</span>
        : null}
      {knownTags.map((name) => (
        <Badge key={name} tone="neutral">
          <Hash size={9} aria-hidden/>{name}
        </Badge>
      ))}
      {!folder && knownTags.length === 0 && (
        <span className="text-[var(--text-quaternary)]">{t('share.hub_unfiled')}</span>
      )}
    </span>
  )
}

function Expiry({ row }: { row: ShareListItem }) {
  if (row.expiresAt === null) return <>{t('share.never_expires')}</>
  const expired = row.expiresAt <= Date.now()
  return (
    <span className={cn('inline-flex items-center gap-1.5', expired && 'text-[var(--danger)]')}>
      <CalendarClock size={11} aria-hidden/>{fullTime(row.expiresAt)}
    </span>
  )
}

function ShareGrid(props: ShareListProps) {
  return (
    <ul className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
      {props.rows.map((row) => (
        <li key={row.slug}>
          <ShareCard {...props} row={row} selected={props.selected.has(row.noteId)}/>
        </li>
      ))}
    </ul>
  )
}

function ShareCard(props: Omit<ShareListProps, 'selected'> & {
  row: ShareListItem
  selected: boolean
  onToggle: (noteId: string) => void
}) {
  const { row } = props
  return (
    <article
      className={cn(
        'group flex items-start gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3',
        props.selected && 'border-[var(--accent)]',
      )}
    >
      <RowCheckbox
        checked={props.selected}
        label={t('share.hub_select_row', { title: row.noteTitle || t('common.untitled_note') })}
        onChange={() => props.onToggle(row.noteId)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
            {row.noteTitle || t('common.untitled_note')}
          </span>
          {row.hasPassword && <Badge tone="warning">{t('share.passcode_protected')}</Badge>}
        </div>
        <div className="mt-1"><LinkState row={row}/></div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          <span className="inline-flex items-center gap-1"><Eye size={11} aria-hidden/>{row.views}</span>
          <Filing row={row} folders={props.folders} tags={props.tags}/>
          <Expiry row={row}/>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Tooltip label={t('share.open_link')} side="left">
          <a
            href={row.url}
            target="_blank"
            rel="noreferrer"
            aria-label={t('share.open_link')}
            className="inline-flex size-7 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <ExternalLink size={13}/>
          </a>
        </Tooltip>
        <RowMenu
          label={t('share.hub_row_menu_label', { title: row.noteTitle || t('common.untitled_note') })}
          items={rowActions(props, row)}
        />
      </div>
    </article>
  )
}

/**
 * A checkbox whose only visible content is the box.
 *
 * The row's name is the note title beside it, so a printed label would be read twice; the accessible
 * name is still a real one, because a checkbox that announces itself as "checkbox" and nothing else is
 * twelve of them per page with no way to tell which link a tick answers for.
 */
function RowCheckbox(props: { checked: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <Checkbox
      className="ink-tap-pad relative"
      checked={props.checked}
      onChange={props.onChange}
      label={<span className="sr-only">{props.label}</span>}
    />
  )
}
