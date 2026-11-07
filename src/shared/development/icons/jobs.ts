import type {
  IconJob,
  IconJobItemStatus,
  IconJobKind,
  IconJobOptions,
  IconJobStatus,
} from './types'
import {
  ICON_JOB_ITEM_STATUSES,
  ICON_JOB_KINDS,
  ICON_JOB_MESSAGE_ITEMS,
  ICON_JOB_STATUSES,
  ICON_PNG_PRESETS,
  ICON_ICO_PRESETS,
  ICON_SPRITE_PADDING_DEFAULT,
  ICON_SPRITE_SCALES,
} from './limits'

const TERMINAL_STATUSES: readonly IconJobStatus[] = ['partial', 'done', 'failed', 'canceled']

export function isIconJobKind(value: unknown): value is IconJobKind {
  return typeof value === 'string' && ICON_JOB_KINDS.includes(value as IconJobKind)
}

export function isIconJobStatus(value: unknown): value is IconJobStatus {
  return typeof value === 'string' && ICON_JOB_STATUSES.includes(value as IconJobStatus)
}

export function isIconJobItemStatus(value: unknown): value is IconJobItemStatus {
  return typeof value === 'string' && ICON_JOB_ITEM_STATUSES.includes(value as IconJobItemStatus)
}

export function isIconJobTerminal(status: IconJobStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

export function defaultIconJobOptions(kind: IconJobKind): IconJobOptions {
  if (kind === 'png') return { kind, sizes: [...ICON_PNG_PRESETS] }
  if (kind === 'ico') return { kind, sizes: [...ICON_ICO_PRESETS] }
  if (kind === 'sprite_svg') return { kind, padding: ICON_SPRITE_PADDING_DEFAULT }
  return { kind, padding: ICON_SPRITE_PADDING_DEFAULT, scales: [...ICON_SPRITE_SCALES], scss: false }
}

export function iconJobBatchSize(itemCount: number): number {
  return Math.min(ICON_JOB_MESSAGE_ITEMS, Math.max(1, itemCount))
}

export function iconJobProgress(job: Pick<IconJob, 'totalItems' | 'processedItems' | 'failedItems'>): number {
  if (job.totalItems <= 0) return 0
  const finished = Math.min(job.totalItems, job.processedItems + job.failedItems)
  return Math.round((finished / job.totalItems) * 100)
}

export function iconJobOutputName(size: string | number): string {
  return String(size)
}
