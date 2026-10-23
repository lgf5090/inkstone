export const EMAIL_DRAG_MIME = 'application/x-inkstone-emails'
export const EMAIL_FOLDER_DRAG_MIME = 'application/x-inkstone-email-folder'

interface EmailDragPayload {
  emailIds: string[]
}

interface EmailFolderDragPayload {
  folderId: string
}

function uniqueIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids = value.filter((id): id is string => typeof id === 'string' && id.length > 0)
  return [...new Set(ids)]
}

export function encodeEmailDrag(emailIds: readonly string[]): string {
  const payload: EmailDragPayload = { emailIds: uniqueIds(emailIds) }
  return JSON.stringify(payload)
}

export function decodeEmailDrag(value: string): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object') return []
    return uniqueIds((parsed as Partial<EmailDragPayload>).emailIds)
  } catch {
    return []
  }
}

export function encodeEmailFolderDrag(folderId: string): string {
  const payload: EmailFolderDragPayload = { folderId }
  return JSON.stringify(payload)
}

export function decodeEmailFolderDrag(value: string): string | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object') return null
    const folderId = (parsed as Partial<EmailFolderDragPayload>).folderId
    return typeof folderId === 'string' && folderId.length > 0 ? folderId : null
  } catch {
    return null
  }
}

function hasType(dataTransfer: DataTransfer, type: string): boolean {
  return Array.from(dataTransfer.types).includes(type)
}

export function hasEmailDrag(dataTransfer: DataTransfer): boolean {
  return hasType(dataTransfer, EMAIL_DRAG_MIME)
}

export function hasEmailFolderDrag(dataTransfer: DataTransfer): boolean {
  return hasType(dataTransfer, EMAIL_FOLDER_DRAG_MIME)
}

export function writeEmailDrag(dataTransfer: DataTransfer, emailIds: readonly string[]): void {
  const ids = uniqueIds(emailIds)
  if (ids.length === 0) return
  dataTransfer.setData(EMAIL_DRAG_MIME, encodeEmailDrag(ids))
  dataTransfer.effectAllowed = 'move'
}

export function readEmailDrag(dataTransfer: DataTransfer): string[] {
  if (!hasEmailDrag(dataTransfer)) return []
  return decodeEmailDrag(dataTransfer.getData(EMAIL_DRAG_MIME))
}

export function writeEmailFolderDrag(dataTransfer: DataTransfer, folderId: string): void {
  if (!folderId) return
  dataTransfer.setData(EMAIL_FOLDER_DRAG_MIME, encodeEmailFolderDrag(folderId))
  dataTransfer.effectAllowed = 'move'
}

export function readEmailFolderDrag(dataTransfer: DataTransfer): string | null {
  if (!hasEmailFolderDrag(dataTransfer)) return null
  return decodeEmailFolderDrag(dataTransfer.getData(EMAIL_FOLDER_DRAG_MIME))
}

export function setEmailDragImage(dataTransfer: DataTransfer, element: Element): void {
  if (typeof dataTransfer.setDragImage !== 'function') return
  dataTransfer.setDragImage(element, 12, 12)
}

export function dragLeftTarget(currentTarget: Element, relatedTarget: EventTarget | null): boolean {
  return !(relatedTarget instanceof Node) || !currentTarget.contains(relatedTarget)
}

export function emailDragBlocked(): boolean {
  return document.querySelector('[role="menu"], [role="dialog"]') !== null
}

export function hasSelectedTextInside(element: Element): boolean {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.anchorNode) return false
  if (element.contains(selection.anchorNode)) return true
  return selection.focusNode !== null && element.contains(selection.focusNode)
}
