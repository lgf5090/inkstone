import { memo } from 'react'
import { Copy, Download, MoreHorizontal, Pin, Star } from 'lucide-react'
import type { IconAssetSummary } from '@shared/development/icons/types'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { IconButton } from '../../../../components/primitives'
import { Checkbox } from '../../../../components/form'

export interface IconCardActions {
  onOpen: (item: IconAssetSummary) => void
  onFavorite: (item: IconAssetSummary) => void
  onPin: (item: IconAssetSummary) => void
  onCopy: (item: IconAssetSummary) => void
  onSelect: (id: string, checked: boolean) => void
}

interface IconCardProps extends IconCardActions {
  item: IconAssetSummary
  selected: boolean
  height: number
  imageSize: number
}

function shortSize(item: IconAssetSummary): string {
  return item.width && item.height ? `${item.width}×${item.height}` : item.format.toUpperCase()
}

/**
 * A square tile with a two-line name and a fixed caption. Hover swaps the caption for four equal
 * action cells, so the verbs are always inside the card and never clipped by its rounded overflow.
 */
export const IconCard = memo(function IconCard({ item, selected, height, imageSize, onOpen, onFavorite, onCopy, onSelect }: IconCardProps) {
  return (
    <div
      data-icon-card={item.id}
      className={cn(
        'group relative flex select-none flex-col overflow-hidden rounded-[var(--r-md)] border bg-[var(--bg-surface)]',
        'transition-[border-color,background-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        selected
          ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-[var(--shadow-ring-focus)]'
          : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-raised)]',
      )}
      style={{ height }}
    >
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="flex min-h-0 flex-1 items-center justify-center p-3 focus-visible:rounded-[var(--r-sm)] focus-visible:shadow-[var(--shadow-ring-focus)] focus-visible:outline-none"
        aria-label={`${t('development.icons.card.open')}: ${item.name}`}
        title={`${item.name} · ${item.format.toUpperCase()} · ${shortSize(item)}`}
      >
        <img
          src={item.thumbUrl}
          alt=""
          loading="eager"
          decoding="sync"
          width={imageSize}
          height={imageSize}
          className="max-h-full max-w-full object-contain"
        />
      </button>

      <div className="relative h-16 shrink-0 border-t border-[var(--border-subtle)] px-2 py-1">
        <div className="line-clamp-2 text-[length:var(--text-11)] font-medium leading-[13px] text-[var(--text-primary)]" title={item.name}>{item.name}</div>
        <div className="mt-0.5 flex items-center gap-1 truncate text-[length:var(--text-10)] text-[var(--text-tertiary)] group-hover:invisible">
          <span className="uppercase">{item.format}</span>
          <span aria-hidden="true">·</span>
          <span>{shortSize(item)}</span>
          {item.pinned && <Pin size={9} aria-hidden="true" className="ml-auto shrink-0 text-[var(--warning)]" />}
          {item.favorited && <Star size={9} aria-hidden="true" className={cn('shrink-0 text-[var(--warning)]', item.pinned ? '' : 'ml-auto', 'fill-current')} />}
        </div>
        <div className="invisible absolute inset-x-1 bottom-1 flex items-center gap-0.5 bg-[var(--bg-surface)] group-hover:visible group-focus-within:visible">
          <button type="button" aria-label={t('development.icons.card.copy')} title={t('development.icons.card.copy')} onClick={() => onCopy(item)} className="inline-flex h-7 min-w-0 flex-1 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Copy size={13} /></button>
          <a
            href={item.rawUrl}
            download={`${item.name}.${item.format}`}
            aria-label={t('development.icons.card.download')}
            title={t('development.icons.card.download')}
            className="inline-flex h-7 min-w-0 flex-1 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <Download size={13} />
          </a>
          <button
            type="button"
            aria-label={item.favorited ? t('development.icons.card.unfavorite') : t('development.icons.card.favorite')}
            title={item.favorited ? t('development.icons.card.unfavorite') : t('development.icons.card.favorite')}
            onClick={() => onFavorite(item)}
            className="inline-flex h-7 min-w-0 flex-1 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <Star size={13} className={item.favorited ? 'fill-current text-[var(--warning)]' : ''} />
          </button>
          <button type="button" aria-label={t('development.icons.card.more')} title={t('development.icons.card.more')} onClick={() => onOpen(item)} className="inline-flex h-7 min-w-0 flex-1 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><MoreHorizontal size={13} /></button>
        </div>
      </div>

      <div className="invisible absolute left-1 top-1 group-hover:visible group-focus-within:visible">
        <span className="flex rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-overlay)] p-0.5 shadow-sm">
          <Checkbox checked={selected} onChange={(checked) => onSelect(item.id, checked)} ariaLabel={`${t('development.icons.card.select')} ${item.name}`} />
        </span>
      </div>
    </div>
  )
})

interface IconRowProps extends IconCardActions {
  item: IconAssetSummary
  selected: boolean
  collectionName: string
}

/** The compact list keeps one line per icon; it is the mode for scanning names, not for browsing art. */
export const IconRow = memo(function IconRow({ item, selected, collectionName, onOpen, onFavorite, onPin, onCopy, onSelect }: IconRowProps) {
  return (
    <div
      data-icon-row={item.id}
      className={cn(
        'group flex min-h-12 items-center gap-2 rounded-[var(--r-sm)] border px-2 text-[length:var(--text-12)]',
        selected ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-transparent hover:border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]',
      )}
    >
      <Checkbox checked={selected} onChange={(checked) => onSelect(item.id, checked)} ariaLabel={`${t('development.icons.card.select')} ${item.name}`} />
      <img src={item.thumbUrl} alt="" loading="eager" className="h-8 w-8 shrink-0 object-contain" />
      <button type="button" className="min-w-0 flex-1 truncate text-left text-[var(--text-primary)]" onClick={() => onOpen(item)}>{item.name}</button>
      <span className="hidden w-28 truncate text-[length:var(--text-11)] text-[var(--text-tertiary)] sm:block">{collectionName}</span>
      <span className="w-10 uppercase text-[length:var(--text-10)] text-[var(--text-tertiary)]">{item.format}</span>
      <span className="hidden w-16 text-[length:var(--text-10)] text-[var(--text-tertiary)] md:block">{shortSize(item)}</span>
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <IconButton label={t('development.icons.card.copy')} size="sm" className="h-7 w-7" onClick={() => onCopy(item)}><Copy size={12} /></IconButton>
        <IconButton label={t('development.icons.card.favorite')} size="sm" className="h-7 w-7" onClick={() => onFavorite(item)}><Star size={12} className={item.favorited ? 'fill-current text-[var(--warning)]' : ''} /></IconButton>
        <IconButton label={t('development.icons.card.pin')} size="sm" className="h-7 w-7" onClick={() => onPin(item)}><Pin size={12} className={item.pinned ? 'text-[var(--warning)]' : ''} /></IconButton>
        <a href={item.rawUrl} download={`${item.name}.${item.format}`} aria-label={t('development.icons.card.download')} className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"><Download size={12} /></a>
      </div>
    </div>
  )
})

interface IconTableRowProps extends IconCardActions {
  item: IconAssetSummary
  selected: boolean
  collectionName: string
}

/** The table mode is the audit view: every fact a row carries is a column, not a tooltip. */
export const IconTableRow = memo(function IconTableRow({ item, selected, collectionName, onOpen, onFavorite, onPin, onCopy, onSelect }: IconTableRowProps) {
  return (
    <tr data-icon-row={item.id} className={cn('group border-b border-[var(--border-subtle)]', selected ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]')}>
      <td className="w-8 px-2 py-1.5"><Checkbox checked={selected} onChange={(checked) => onSelect(item.id, checked)} ariaLabel={`${t('development.icons.card.select')} ${item.name}`} /></td>
      <td className="w-10 px-1 py-1.5">
        <button type="button" onClick={() => onOpen(item)} aria-label={`${t('development.icons.card.open')}: ${item.name}`} className="flex h-8 w-8 items-center justify-center rounded-[var(--r-sm)] hover:bg-[var(--bg-hover)]">
          <img src={item.thumbUrl} alt="" loading="eager" className="h-6 w-6 object-contain" />
        </button>
      </td>
      <td className="min-w-0 px-2 py-1.5">
        <button type="button" onClick={() => onOpen(item)} className="block w-full truncate text-left text-[length:var(--text-12)] text-[var(--text-primary)]">{item.name}</button>
      </td>
      <td className="hidden max-w-40 truncate px-2 py-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)] md:table-cell">{collectionName || '—'}</td>
      <td className="px-2 py-1.5 text-[length:var(--text-11)] uppercase text-[var(--text-tertiary)]">{item.format}</td>
      <td className="px-2 py-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{shortSize(item)}</td>
      <td className="hidden px-2 py-1.5 md:table-cell">
        <div className="flex max-w-48 flex-wrap gap-1">
          {item.tags.slice(0, 2).map((tag) => (
            <span key={tag.id} className="rounded-[var(--r-full)] border px-1.5 py-0.5 text-[length:var(--text-10)]" style={{ borderColor: tag.color, color: tag.color }}>{tag.name}</span>
          ))}
          {item.tags.length > 2 && <span className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">+{item.tags.length - 2}</span>}
        </div>
      </td>
      <td className="w-16 px-2 py-1.5">
        <div className="flex items-center gap-1">
          {item.pinned && <Pin size={11} aria-hidden="true" className="text-[var(--warning)]" />}
          {item.favorited && <Star size={11} aria-hidden="true" className="fill-current text-[var(--warning)]" />}
          {!item.pinned && !item.favorited && <span className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">—</span>}
        </div>
      </td>
      <td className="w-24 px-2 py-1.5">
        <div className="flex justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <IconButton label={t('development.icons.card.copy')} size="sm" className="h-6 w-6" onClick={() => onCopy(item)}><Copy size={11} /></IconButton>
          <IconButton label={t('development.icons.card.favorite')} size="sm" className="h-6 w-6" onClick={() => onFavorite(item)}><Star size={11} /></IconButton>
          <IconButton label={t('development.icons.card.pin')} size="sm" className="h-6 w-6" onClick={() => onPin(item)}><Pin size={11} /></IconButton>
          <a href={item.rawUrl} download={`${item.name}.${item.format}`} aria-label={t('development.icons.card.download')} className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"><Download size={11} /></a>
        </div>
      </td>
    </tr>
  )
})
