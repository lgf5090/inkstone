import { useMemo, useRef, useState } from 'react'
import {
  ArrowDownAZ,
  ArrowDownWideNarrow,
  ArrowUpAZ,
  ArrowUpWideNarrow,
  Calendar,
  ChevronDown,
  FileType,
  Filter,
  Grid,
  List,
  Search,
  SlidersHorizontal,
  Sparkles,
  Upload,
  X,
} from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import type { HubAttachmentSort, HubAttachmentStats } from '@shared/attachment-hub'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { useFilterInput } from '../../components/FilterInput'
import { Menu, Tooltip, type MenuItem } from '../../components/overlay'
import type { HubSizeFilter } from './attachment-helpers'

const KNOWN_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'md', 'zip', '7z', 'tar', 'rar', 'gz', 'mp4', 'mp3', 'wav', 'mov', 'webm']

const SORT_OPTIONS: { id: HubAttachmentSort; labelKey: MessageKey; icon: React.ReactNode }[] = [
  { id: 'date_desc', labelKey: 'attachments.sort_date_desc', icon: <Calendar size={13} /> },
  { id: 'date_asc', labelKey: 'attachments.sort_date_asc', icon: <Calendar size={13} /> },
  { id: 'name_asc', labelKey: 'attachments.sort_name_asc', icon: <ArrowDownAZ size={13} /> },
  { id: 'name_desc', labelKey: 'attachments.sort_name_desc', icon: <ArrowUpAZ size={13} /> },
  { id: 'size_desc', labelKey: 'attachments.sort_size_desc', icon: <ArrowDownWideNarrow size={13} /> },
  { id: 'size_asc', labelKey: 'attachments.sort_size_asc', icon: <ArrowUpWideNarrow size={13} /> },
]

function sortLabelOf(sort: HubAttachmentSort): string {
  const option = SORT_OPTIONS.find((item) => item.id === sort)
  return t(option ? option.labelKey : 'attachments.sort_date_desc')
}

function sizeLabelOf(range: HubSizeFilter): string {
  if (range === 'small') return t('attachments.size_small')
  if (range === 'medium') return t('attachments.size_medium')
  if (range === 'large') return t('attachments.size_large')
  return t('attachments.size_all')
}

function buildExtensionMenuItems(
  stats: HubAttachmentStats | undefined,
  onExtensionChange: (ext: string) => void,
  onClose: () => void,
): MenuItem[] {
  const pick = (ext: string) => () => {
    onExtensionChange(ext)
    onClose()
  }
  const items: MenuItem[] = [
    { id: 'all', label: t('attachments.type_all'), onSelect: pick('all') },
    { id: 'png', label: 'PNG (.png)', onSelect: pick('png') },
    { id: 'jpg', label: 'JPG / JPEG (.jpg, .jpeg)', onSelect: pick('jpg,jpeg') },
    { id: 'webp', label: 'WEBP (.webp)', onSelect: pick('webp') },
    { id: 'gif', label: 'GIF (.gif)', onSelect: pick('gif') },
    { id: 'svg', label: 'SVG (.svg)', onSelect: pick('svg') },
    { id: 'pdf', label: 'PDF (.pdf)', separatorBefore: true, onSelect: pick('pdf') },
    { id: 'docx', label: 'DOC / DOCX (.doc, .docx)', onSelect: pick('doc,docx') },
    { id: 'xlsx', label: 'XLS / XLSX (.xls, .xlsx)', onSelect: pick('xls,xlsx') },
    { id: 'txt', label: 'TXT / MD (.txt, .md)', onSelect: pick('txt,md') },
    { id: 'zip', label: 'ZIP / 7Z / TAR (.zip, .7z, .tar, .rar, .gz)', separatorBefore: true, onSelect: pick('zip,7z,tar,rar,gz') },
    { id: 'media', label: 'MP4 / MP3 / WAV (.mp4, .mp3, .wav, .mov, .webm)', onSelect: pick('mp4,mp3,wav,mov,webm') },
  ]

  if (stats?.extensionBreakdown) {
    for (const key of Object.keys(stats.extensionBreakdown).filter((ext) => !KNOWN_EXTENSIONS.includes(ext)).slice(0, 5)) {
      items.push({ id: key, label: `.${key.toUpperCase()}`, onSelect: pick(key) })
    }
  }
  return items
}

function extLabelOf(extension: string): string {
  if (!extension || extension === 'all') return t('attachments.type_all')
  const first = extension.split(',')[0] ?? ''
  return first ? `.${first.toUpperCase()}${extension.includes(',') ? '+' : ''}` : t('attachments.type_all')
}

interface AttachmentHubToolbarProps {
  search: string
  onSearchChange: (query: string) => void
  extension: string
  onExtensionChange: (ext: string) => void
  sizeRange: HubSizeFilter
  onSizeRangeChange: (range: HubSizeFilter) => void
  sort: HubAttachmentSort
  onSortChange: (sort: HubAttachmentSort) => void
  viewMode: 'grid' | 'list'
  onViewModeChange: (mode: 'grid' | 'list') => void
  zoom: 'sm' | 'md' | 'lg'
  onZoomChange: (zoom: 'sm' | 'md' | 'lg') => void
  stats?: HubAttachmentStats
  onUploadClick: () => void
  onPruneClick: () => void
  pruning?: boolean
}

export function AttachmentHubToolbar(props: AttachmentHubToolbarProps) {
  const {
    search, onSearchChange, extension, onExtensionChange, sizeRange, onSizeRangeChange,
    sort, onSortChange, viewMode, onViewModeChange, zoom, onZoomChange,
    stats, onUploadClick, onPruneClick, pruning,
  } = props
  const extButtonRef = useRef<HTMLButtonElement>(null)
  const sizeButtonRef = useRef<HTMLButtonElement>(null)
  const sortButtonRef = useRef<HTMLButtonElement>(null)
  const [isExtOpen, setIsExtOpen] = useState(false)
  const [isSizeOpen, setIsSizeOpen] = useState(false)
  const [isSortOpen, setIsSortOpen] = useState(false)

  const extensionMenuItems = useMemo(
    () => buildExtensionMenuItems(stats, onExtensionChange, () => setIsExtOpen(false)),
    [stats, onExtensionChange],
  )

  return (
    <div className='flex h-12 min-w-0 shrink-0 items-center justify-between gap-[var(--sp-3)] overflow-x-auto border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-[var(--sp-3)]'>
      <div className='flex min-w-0 shrink-0 items-center gap-[var(--sp-2)]'>
        <SearchBox search={search} onSearchChange={onSearchChange} />
        <FilterDropdown
          buttonRef={extButtonRef}
          isOpen={isExtOpen}
          onToggle={() => setIsExtOpen((prev) => !prev)}
          onClose={() => setIsExtOpen(false)}
          isActive={Boolean(extension && extension !== 'all')}
          icon={<FileType size={12} className='shrink-0' />}
          label={extLabelOf(extension)}
          items={extensionMenuItems}
        />
        <FilterDropdown
          buttonRef={sizeButtonRef}
          isOpen={isSizeOpen}
          onToggle={() => setIsSizeOpen((prev) => !prev)}
          onClose={() => setIsSizeOpen(false)}
          isActive={sizeRange !== 'all'}
          icon={<Filter size={12} className='shrink-0' />}
          label={sizeLabelOf(sizeRange)}
          items={buildSizeMenuItems(sizeRange, onSizeRangeChange, () => setIsSizeOpen(false))}
        />
        <FilterDropdown
          buttonRef={sortButtonRef}
          isOpen={isSortOpen}
          onToggle={() => setIsSortOpen((prev) => !prev)}
          onClose={() => setIsSortOpen(false)}
          isActive={false}
          icon={<SlidersHorizontal size={12} className='shrink-0' />}
          label={sortLabelOf(sort)}
          items={SORT_OPTIONS.map((option) => ({
            id: option.id,
            label: t(option.labelKey),
            icon: option.icon,
            onSelect: () => {
              onSortChange(option.id)
              setIsSortOpen(false)
            },
          }))}
        />
      </div>

      <div className='flex shrink-0 items-center gap-[var(--sp-2)]'>
        <ViewModeToggle viewMode={viewMode} onViewModeChange={onViewModeChange} />
        {viewMode === 'grid' && <ZoomControl zoom={zoom} onZoomChange={onZoomChange} />}
        <Button size='sm' variant='secondary' onClick={onPruneClick} disabled={pruning} className='shrink-0 cursor-pointer text-[var(--warning)]'>
          <Sparkles size={12} className={cn(pruning && 'animate-spin')} />
          <span>{t('attachments.cleanup')}</span>
        </Button>
        <Button size='sm' onClick={onUploadClick} className='shrink-0 cursor-pointer'>
          <Upload size={12} />
          <span>{t('attachments.upload_file')}</span>
        </Button>
      </div>
    </div>
  )
}

function buildSizeMenuItems(
  current: HubSizeFilter,
  onSizeRangeChange: (range: HubSizeFilter) => void,
  onClose: () => void,
): MenuItem[] {
  const ranges: { id: HubSizeFilter; label: string }[] = [
    { id: 'all', label: t('attachments.size_all') },
    { id: 'small', label: t('attachments.size_small') },
    { id: 'medium', label: t('attachments.size_medium') },
    { id: 'large', label: t('attachments.size_large') },
  ]
  return ranges.map((range) => ({
    id: range.id,
    label: range.label,
    checked: current === range.id,
    onSelect: () => {
      onSizeRangeChange(range.id)
      onClose()
    },
  }))
}

function SearchBox({ search, onSearchChange }: { search: string; onSearchChange: (query: string) => void }) {
  // The hub searches by plain substring, so it keeps its own box rather than the regex one — but the
  // box is still the app's Escape/IME contract, and an empty box hands Escape back to the modal.
  const { field, clear } = useFilterInput({
    value: search,
    onClear: () => onSearchChange(''),
    escapeWhenEmpty: 'release',
  })
  return (
    <div className='relative w-36 shrink-0 sm:w-44 lg:w-52'>
      <Search size={13} className='pointer-events-none absolute top-1/2 left-[var(--sp-2-5)] -translate-y-1/2 text-[var(--text-quaternary)]' />
      <input
        {...field}
        type='search'
        value={search}
        spellCheck={false}
        autoComplete='off'
        aria-label={t('attachments.search_placeholder')}
        placeholder={t('attachments.search_placeholder')}
        onChange={(e) => onSearchChange(e.target.value)}
        className='h-8 w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] pr-7 pl-8 text-[length:var(--text-12-5)] outline-none transition-colors placeholder:text-[var(--text-quaternary)] [&::-webkit-search-cancel-button]:hidden focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)]'
      />
      {search && (
        <IconButton
          label={t('common.clear')}
          size='sm'
          onClick={clear}
          className='absolute top-1/2 right-1 -translate-y-1/2 text-[var(--text-quaternary)] hover:text-[var(--text-primary)]'
        >
          <X size={12} />
        </IconButton>
      )}
    </div>
  )
}

function FilterDropdown({ buttonRef, isOpen, onToggle, onClose, isActive, icon, label, items }: {
  buttonRef: React.RefObject<HTMLButtonElement | null>
  isOpen: boolean
  onToggle: () => void
  onClose: () => void
  isActive: boolean
  icon: React.ReactNode
  label: string
  items: MenuItem[]
}) {
  return (
    <div className='relative shrink-0'>
      <button
        ref={buttonRef}
        type='button'
        aria-haspopup='menu'
        aria-expanded={isOpen}
        onClick={onToggle}
        className={cn(
          'inline-flex h-8 shrink-0 cursor-pointer items-center gap-[var(--sp-1-5)] whitespace-nowrap rounded-[var(--r-md)] border px-[var(--sp-2-5)] text-[length:var(--text-12)] font-medium transition-colors select-none',
          isActive
            ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
            : 'border-[var(--border-subtle)] bg-[var(--bg-base)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
        )}
      >
        {icon}
        <span className='whitespace-nowrap'>{label}</span>
        <ChevronDown size={11} className='shrink-0 opacity-60' />
      </button>
      <Menu open={isOpen} anchor={buttonRef} items={items} onClose={onClose} />
    </div>
  )
}

function ViewModeToggle({ viewMode, onViewModeChange }: { viewMode: 'grid' | 'list'; onViewModeChange: (mode: 'grid' | 'list') => void }) {
  const modes: { id: 'grid' | 'list'; label: string; icon: React.ReactNode }[] = [
    { id: 'grid', label: t('attachments.view_grid'), icon: <Grid size={14} /> },
    { id: 'list', label: t('attachments.view_list'), icon: <List size={14} /> },
  ]
  return (
    <div className='flex shrink-0 items-center rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-[var(--sp-0-5)]'>
      {modes.map((mode) => (
        <Tooltip key={mode.id} label={mode.label}>
          <button
            type='button'
            aria-label={mode.label}
            aria-pressed={viewMode === mode.id}
            onClick={() => onViewModeChange(mode.id)}
            className={cn(
              'cursor-pointer rounded p-1 text-[var(--text-tertiary)] transition-colors',
              viewMode === mode.id ? 'bg-[var(--bg-surface)] text-[var(--accent)] shadow-[var(--shadow-xs)]' : 'hover:text-[var(--text-primary)]',
            )}
          >
            {mode.icon}
          </button>
        </Tooltip>
      ))}
    </div>
  )
}

function ZoomControl({ zoom, onZoomChange }: { zoom: 'sm' | 'md' | 'lg'; onZoomChange: (zoom: 'sm' | 'md' | 'lg') => void }) {
  const options: { id: 'sm' | 'md' | 'lg'; label: string }[] = [
    { id: 'sm', label: t('attachments.zoom_sm') },
    { id: 'md', label: t('attachments.zoom_md') },
    { id: 'lg', label: t('attachments.zoom_lg') },
  ]
  return (
    <div className='hidden shrink-0 items-center rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-[var(--sp-0-5)] text-[length:var(--text-11)] font-medium lg:flex'>
      {options.map((option) => (
        <button
          key={option.id}
          type='button'
          aria-pressed={zoom === option.id}
          onClick={() => onZoomChange(option.id)}
          className={cn(
            'cursor-pointer rounded px-[var(--sp-1-5)] py-[var(--sp-0-5)]',
            zoom === option.id ? 'bg-[var(--bg-surface)] font-semibold text-[var(--accent)] shadow-[var(--shadow-xs)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
