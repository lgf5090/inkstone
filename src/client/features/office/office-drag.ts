import type { DragEvent } from 'react'

/**
 * One private `dataTransfer` type for every in-app drag the office shell starts: files onto a
 * folder, folders into another folder, and tags under another tag. The payload is also kept in a
 * module variable because `dataTransfer` refuses to hand its data back before the drop, and every
 * drop target has to decide whether to accept the drag while it is still in flight.
 */
export const OFFICE_DRAG_MIME = 'application/x-inkstone-office'

export type OfficeDragPayload =
  | { kind: 'files'; ids: string[] }
  | { kind: 'folder'; id: string }
  | { kind: 'tag'; name: string }

let currentDrag: OfficeDragPayload | null = null

export function beginOfficeDrag(event: DragEvent<HTMLElement>, payload: OfficeDragPayload): void {
  currentDrag = payload
  event.dataTransfer.setData(OFFICE_DRAG_MIME, JSON.stringify(payload))
  event.dataTransfer.effectAllowed = 'move'
}

export function endOfficeDrag(): void {
  currentDrag = null
}

export function currentOfficeDrag(): OfficeDragPayload | null {
  return currentDrag
}

export function hasOfficeDrag(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(OFFICE_DRAG_MIME)
}

export function readOfficeDrag(event: DragEvent<HTMLElement>): OfficeDragPayload | null {
  if (currentDrag) return currentDrag
  try {
    const raw = event.dataTransfer.getData(OFFICE_DRAG_MIME)
    if (!raw) return null
    return parseOfficeDrag(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

export function parseOfficeDrag(value: unknown): OfficeDragPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.kind === 'files') {
    if (!Array.isArray(record.ids)) return null
    const ids = record.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    return ids.length ? { kind: 'files', ids } : null
  }
  if (record.kind === 'folder') {
    return typeof record.id === 'string' && record.id ? { kind: 'folder', id: record.id } : null
  }
  if (record.kind === 'tag') {
    return typeof record.name === 'string' && record.name ? { kind: 'tag', name: record.name } : null
  }
  return null
}