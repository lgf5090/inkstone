/** Tag drags between YouTube sidebar rows: one type, one id, same document only. */
const TAG_DRAG_MIME = 'application/x-inkstone-youtube-tag'

let activeTagId: string | null = null

export function beginTagDrag(id: string, name: string, dataTransfer: DataTransfer): void {
  activeTagId = id
  dataTransfer.setData(TAG_DRAG_MIME, id)
  dataTransfer.setData('text/plain', `#${name}`)
  dataTransfer.effectAllowed = 'move'
}

export function endTagDrag(): void {
  activeTagId = null
}

export function isTagDrag(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(TAG_DRAG_MIME)
}

export function droppedTagId(dataTransfer: DataTransfer): string | null {
  if (!isTagDrag(dataTransfer)) return null
  return dataTransfer.getData(TAG_DRAG_MIME) || activeTagId
}

export function currentTagDrag(): string | null {
  return activeTagId
}
