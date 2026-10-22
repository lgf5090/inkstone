import { useMemo } from 'react'
import {
  Archive,
  Database,
  Download,
  Eye,
  FileCode,
  FileText,
  Film,
  FolderTree,
  HardDrive,
  Images,
  Link2Off,
  Sparkles,
  Tag,
  Trash2,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { HubAttachmentStats, HubAttachmentWithUsage } from '@shared/attachment-hub'
import { cn } from '../../lib/cn'
import { t, localeTag } from '../../lib/i18n'
import { formatBytes } from '../../lib/time'
import { IconButton } from '../../components/primitives'
import {
  DEFAULT_QUOTA_BYTES,
  HUB_BADGE_CLASS,
  badgeLabelOf,
  fileExtensionOf,
  type HubCategory,
} from './attachment-helpers'

const DONUT_SIZE = 180
const DONUT_RADIUS = 70
const MIN_BAR_PCT = 2

interface AttachmentDashboardViewProps {
  stats?: HubAttachmentStats
  onSelectCategory: (category: HubCategory) => void
  onSelectExtension: (ext: string) => void
  onPreviewFile: (file: HubAttachmentWithUsage) => void
  onDownloadFile: (file: HubAttachmentWithUsage) => void
  onDeleteFile: (file: HubAttachmentWithUsage) => void
  onPrune: () => void
}

interface CategoryBreakdown {
  id: HubCategory
  label: string
  bytes: number
  icon: ReactNode
  ratio: number
}

function categoryBreakdownOf(stats?: HubAttachmentStats): CategoryBreakdown[] {
  if (!stats) return []
  const total = stats.totalBytes || 1
  const items: CategoryBreakdown[] = [
    { id: 'image', label: t('attachments.photos'), bytes: stats.imageBytes, icon: <Images size={16} />, ratio: stats.imageBytes / total },
    { id: 'document', label: t('attachments.documents'), bytes: stats.documentBytes, icon: <FileText size={16} />, ratio: stats.documentBytes / total },
    { id: 'media', label: t('attachments.media'), bytes: stats.mediaBytes, icon: <Film size={16} />, ratio: stats.mediaBytes / total },
    { id: 'archive', label: t('attachments.archives'), bytes: stats.archiveBytes + stats.codeBytes, icon: <Archive size={16} />, ratio: (stats.archiveBytes + stats.codeBytes) / total },
    { id: 'all', label: t('attachments.filter_other'), bytes: stats.otherBytes, icon: <FileCode size={16} />, ratio: stats.otherBytes / total },
  ]
  return items.filter((item) => item.bytes > 0 || item.id === 'image' || item.id === 'document')
}

function topExtensionsOf(stats?: HubAttachmentStats): { ext: string; count: number; bytes: number }[] {
  if (!stats?.extensionBreakdown) return []
  return Object.entries(stats.extensionBreakdown)
    .map(([ext, data]) => ({ ext, count: data.count, bytes: data.bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 10)
}

export function AttachmentDashboardView(props: AttachmentDashboardViewProps) {
  const { stats, onSelectCategory, onSelectExtension, onPreviewFile, onDownloadFile, onDeleteFile, onPrune } = props
  const totalQuota = stats?.totalQuotaBytes || DEFAULT_QUOTA_BYTES
  const totalBytes = stats?.totalBytes || 0
  const usedRatio = Math.min(1, Math.max(0, totalBytes / totalQuota))
  const usedPercentage = (usedRatio * 100).toFixed(usedRatio < 0.001 && totalBytes > 0 ? 3 : 1)
  const freeBytes = Math.max(0, totalQuota - totalBytes)

  const categories = useMemo(() => categoryBreakdownOf(stats), [stats])
  const topExtensions = useMemo(() => topExtensionsOf(stats), [stats])

  return (
    <div className='h-full space-y-[var(--sp-6)] overflow-y-auto p-[var(--sp-6)] select-none'>
      <div className='grid grid-cols-1 gap-[var(--sp-4)] sm:grid-cols-2 lg:grid-cols-4'>
        <StatCard icon={<HardDrive size={20} />} label={t('attachments.total_files')} value={stats?.totalCount ?? 0} />
        <StatCard icon={<Database size={20} />} label={t('attachments.stats_title')}>
          <div className='mt-[var(--sp-0-5)] truncate text-[length:var(--text-20)] font-bold text-[var(--text-primary)]'>
            {formatBytes(totalBytes)}
            <span className='ml-[var(--sp-1)] text-[length:var(--text-11)] font-normal text-[var(--text-quaternary)]'>/ {formatBytes(totalQuota)}</span>
          </div>
        </StatCard>
        <UnreferencedCard count={stats?.unreferencedCount ?? 0} onPrune={onPrune} />
        <StatCard icon={<FolderTree size={20} />} label={t('attachments.structure')}>
          <div className='mt-[var(--sp-0-5)] text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]'>
            {stats?.folderCount ?? 0} {t('navigation.folder')} · {stats?.tagCount ?? 0} {t('navigation.tag')}
          </div>
        </StatCard>
      </div>

      <div className='grid grid-cols-1 gap-[var(--sp-6)] lg:grid-cols-12'>
        <section className='flex flex-col justify-between rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-5)] shadow-[var(--shadow-xs)] lg:col-span-5'>
          <CardHeader icon={<Database size={15} className='text-[var(--accent)]' />} title={t('attachments.storage_donut_title')} side={formatBytes(totalQuota)} />
          <StorageDonut usedPercentage={usedPercentage} usedRatio={usedRatio} freeBytes={freeBytes} />
          <div className='flex items-center justify-between rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-[var(--sp-3)] text-[length:var(--text-12)]'>
            <div className='flex items-center gap-[var(--sp-2)] text-[var(--text-secondary)]'>
              <Sparkles size={14} className='shrink-0 text-[var(--accent)]' />
              <span>{t('attachments.quota_info')}</span>
            </div>
            <span className='font-semibold text-[var(--text-primary)]'>{formatBytes(totalQuota)}</span>
          </div>
        </section>

        <section className='flex flex-col justify-between rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-5)] shadow-[var(--shadow-xs)] lg:col-span-7'>
          <CardHeader icon={<Images size={15} className='text-[var(--accent)]' />} title={t('attachments.category_breakdown')} side={t('attachments.total_value0', { value0: stats?.totalCount ?? 0 })} />
          <div className='space-y-[var(--sp-3-5)] py-[var(--sp-3)]'>
            {categories.map((category) => (
              <CategoryRow key={category.id} category={category} onSelectCategory={onSelectCategory} />
            ))}
          </div>
          <TopExtensions items={topExtensions} onSelectExtension={onSelectExtension} />
        </section>
      </div>

      <LargestFilesCard stats={stats} onPreviewFile={onPreviewFile} onDownloadFile={onDownloadFile} onDeleteFile={onDeleteFile} />
    </div>
  )
}

function StatCard({ icon, label, value, children }: {
  icon: ReactNode
  label: string
  value?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className='flex items-center gap-[var(--sp-3-5)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-4)] shadow-[var(--shadow-xs)]'>
      <div className='flex size-[var(--sp-10)] shrink-0 items-center justify-center rounded-[var(--r-md)] bg-[var(--bg-sunken)] text-[var(--accent)]'>
        {icon}
      </div>
      <div className='min-w-0 flex-1'>
        <div className='text-[length:var(--text-11-5)] font-medium tracking-wide text-[var(--text-tertiary)] uppercase'>
          {label}
        </div>
        {value !== undefined
          ? <div className='mt-[var(--sp-0-5)] text-[length:var(--text-20)] font-bold tabular text-[var(--text-primary)]'>{value}</div>
          : children}
      </div>
    </div>
  )
}

function UnreferencedCard({ count, onPrune }: { count: number; onPrune: () => void }) {
  return (
    <div className='flex items-center gap-[var(--sp-3-5)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-4)] shadow-[var(--shadow-xs)]'>
      <div className='flex size-[var(--sp-10)] shrink-0 items-center justify-center rounded-[var(--r-md)] bg-[var(--bg-sunken)] text-[var(--warning)]'>
        <Link2Off size={20} />
      </div>
      <div className='min-w-0 flex-1'>
        <div className='text-[length:var(--text-11-5)] font-medium tracking-wide text-[var(--text-tertiary)] uppercase'>
          {t('attachments.unreferenced')}
        </div>
        <div className='mt-[var(--sp-0-5)] flex items-baseline gap-[var(--sp-2)] text-[length:var(--text-20)] font-bold tabular text-[var(--text-primary)]'>
          <span>{count}</span>
          {count > 0 && (
            <button
              type='button'
              onClick={onPrune}
              className='cursor-pointer text-[length:var(--text-12)] font-medium text-[var(--warning)] hover:underline'
            >
              {t('attachments.cleanup')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function CardHeader({ icon, title, side }: { icon: ReactNode; title: string; side: string }) {
  return (
    <div className='flex items-center justify-between border-b border-[var(--border-subtle)] pb-[var(--sp-3)]'>
      <h3 className='flex items-center gap-[var(--sp-2)] text-[length:var(--text-13-5)] font-semibold text-[var(--text-primary)]'>
        {icon}
        {title}
      </h3>
      <span className='text-[length:var(--text-11-5)] text-[var(--text-tertiary)]'>{side}</span>
    </div>
  )
}

function StorageDonut({ usedPercentage, usedRatio, freeBytes }: { usedPercentage: string; usedRatio: number; freeBytes: number }) {
  const circumference = 2 * Math.PI * DONUT_RADIUS
  const center = DONUT_SIZE / 2
  return (
    <div className='flex flex-col items-center justify-center py-[var(--sp-6)]'>
      <div className='relative flex items-center justify-center'>
        <svg width={DONUT_SIZE} height={DONUT_SIZE} aria-hidden='true' className='-rotate-90'>
          <circle cx={center} cy={center} r={DONUT_RADIUS} stroke='currentColor' strokeWidth='14' fill='transparent' className='text-[var(--bg-hover)]' />
          <circle
            cx={center}
            cy={center}
            r={DONUT_RADIUS}
            stroke='currentColor'
            strokeWidth='14'
            fill='transparent'
            strokeDasharray={circumference}
            strokeDashoffset={circumference - usedRatio * circumference}
            strokeLinecap='round'
            className='text-[var(--accent)] transition-all duration-[var(--dur-slow)] ease-[var(--ease-out)]'
          />
        </svg>
        <div className='absolute flex flex-col items-center px-[var(--sp-4)] text-center'>
          <span className='text-[length:var(--text-26)] font-black tracking-tight text-[var(--text-primary)] tabular'>{usedPercentage}%</span>
          <span className='mt-[var(--sp-0-5)] text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]'>{t('attachments.used')}</span>
        </div>
      </div>
      <div className='mt-[var(--sp-4)] text-center text-[length:var(--text-12)] text-[var(--text-secondary)]'>
        {t('attachments.remaining_space', { value0: formatBytes(freeBytes) })}
      </div>
    </div>
  )
}

function CategoryRow({ category, onSelectCategory }: {
  category: CategoryBreakdown
  onSelectCategory: (category: HubCategory) => void
}) {
  const pct = (category.ratio * 100).toFixed(1)
  return (
    <button
      type='button'
      onClick={() => onSelectCategory(category.id)}
      className='block w-full cursor-pointer rounded-[var(--r-md)] p-[var(--sp-2)] text-left transition-colors hover:bg-[var(--bg-hover)]'
    >
      <div className='mb-[var(--sp-1-5)] flex items-center justify-between text-[length:var(--text-12-5)]'>
        <div className='flex items-center gap-[var(--sp-2)] font-medium text-[var(--text-primary)]'>
          {category.icon}
          <span>{category.label}</span>
        </div>
        <div className='flex items-center gap-[var(--sp-3)] font-mono text-[length:var(--text-11-5)] tabular text-[var(--text-secondary)]'>
          <span>{formatBytes(category.bytes)}</span>
          <span className='w-[var(--sp-12)] text-right font-semibold text-[var(--text-primary)]'>{pct}%</span>
        </div>
      </div>
      <div className='h-[var(--sp-2)] w-full overflow-hidden rounded-full bg-[var(--bg-sunken)]'>
        <div
          className='h-full rounded-full bg-[var(--accent)] transition-all duration-[var(--dur-slow)]'
          style={{ width: `${Math.max(category.bytes > 0 ? MIN_BAR_PCT : 0, Number(pct))}%` }}
        />
      </div>
    </button>
  )
}

function TopExtensions({ items, onSelectExtension }: {
  items: { ext: string; count: number }[]
  onSelectExtension: (ext: string) => void
}) {
  if (items.length === 0) return null
  return (
    <div className='flex flex-wrap items-center gap-[var(--sp-2)] border-t border-[var(--border-subtle)] pt-[var(--sp-3)]'>
      <span className='mr-[var(--sp-1)] flex items-center gap-[var(--sp-1)] text-[length:var(--text-11-5)] font-medium text-[var(--text-tertiary)]'>
        <Tag size={12} />
        {t('attachments.top_extensions')}
      </span>
      {items.map((item) => (
        <button
          key={item.ext}
          type='button'
          onClick={() => onSelectExtension(item.ext)}
          className='inline-flex cursor-pointer items-center gap-[var(--sp-1)] rounded-full border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-[var(--sp-2-5)] py-[var(--sp-0-5)] text-[length:var(--text-11)] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]'
        >
          <span className='font-semibold uppercase'>.{item.ext}</span>
          <span className='tabular text-[var(--text-quaternary)]'>{item.count}</span>
        </button>
      ))}
    </div>
  )
}

function LargestFilesCard({ stats, onPreviewFile, onDownloadFile, onDeleteFile }: {
  stats?: HubAttachmentStats
  onPreviewFile: (file: HubAttachmentWithUsage) => void
  onDownloadFile: (file: HubAttachmentWithUsage) => void
  onDeleteFile: (file: HubAttachmentWithUsage) => void
}) {
  const files = stats?.largestFiles ?? []
  return (
    <section className='space-y-[var(--sp-4)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-5)] shadow-[var(--shadow-xs)]'>
      <div className='flex items-center justify-between'>
        <h3 className='flex items-center gap-[var(--sp-2)] text-[length:var(--text-13-5)] font-semibold text-[var(--text-primary)]'>
          <HardDrive size={15} className='text-[var(--accent)]' />
          {t('attachments.largest_files')}
        </h3>
        {files.length > 0 && (
          <span className='text-[length:var(--text-11-5)] text-[var(--text-tertiary)]'>
            {t('attachments.top_files', { value0: files.length })}
          </span>
        )}
      </div>

      {files.length > 0 ? (
        <div className='divide-y divide-[var(--border-subtle)] overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)]'>
          {files.map((file) => (
            <LargestFileRow key={file.id} file={file} onPreviewFile={onPreviewFile} onDownloadFile={onDownloadFile} onDeleteFile={onDeleteFile} />
          ))}
        </div>
      ) : (
        <p className='py-[var(--sp-8)] text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]'>
          {t('attachments.empty_files')}
        </p>
      )}
    </section>
  )
}

function LargestFileRow({ file, onPreviewFile, onDownloadFile, onDeleteFile }: {
  file: HubAttachmentWithUsage
  onPreviewFile: (file: HubAttachmentWithUsage) => void
  onDownloadFile: (file: HubAttachmentWithUsage) => void
  onDeleteFile: (file: HubAttachmentWithUsage) => void
}) {
  const badge = badgeLabelOf(fileExtensionOf(file.filename))
  return (
    <div className='flex items-center justify-between px-[var(--sp-3-5)] py-[var(--sp-2-5)] text-[length:var(--text-12-5)] transition-colors hover:bg-[var(--bg-hover)]'>
      <div className='flex min-w-0 flex-1 items-center gap-[var(--sp-3)]'>
        <span className={cn('flex h-[var(--sp-7)] w-[var(--sp-9)] shrink-0 items-center justify-center rounded-[var(--r-xs)] text-[length:var(--text-10)] font-bold tracking-wider', HUB_BADGE_CLASS)}>
          {badge}
        </span>
        <div className='min-w-0 flex-1'>
          <div className='truncate font-medium text-[var(--text-primary)]'>{file.filename}</div>
          <div className='text-[length:var(--text-11)] text-[var(--text-tertiary)]'>
            {new Date(file.createdAt).toLocaleDateString(localeTag())}
          </div>
        </div>
      </div>

      <div className='flex shrink-0 items-center gap-[var(--sp-4)] pl-[var(--sp-3)]'>
        <span className='font-mono text-[length:var(--text-11)] font-semibold tabular text-[var(--text-secondary)]'>{formatBytes(file.size)}</span>
        <div className='flex items-center gap-[var(--sp-1)]'>
          <IconButton label={t('common.preview')} size='sm' onClick={() => onPreviewFile(file)}>
            <Eye size={13} />
          </IconButton>
          <IconButton label={t('common.download')} size='sm' onClick={() => onDownloadFile(file)}>
            <Download size={13} />
          </IconButton>
          <IconButton label={t('common.delete')} size='sm' className='hover:text-[var(--danger)]' onClick={() => onDeleteFile(file)}>
            <Trash2 size={13} />
          </IconButton>
        </div>
      </div>
    </div>
  )
}
