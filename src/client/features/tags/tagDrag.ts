import { decodeDataValue, encodeDataValue } from '../../lib/markdown/data-attr'
import { tagNamesEqual } from '@shared/markdown-utils'

export const TAG_MIME = 'application/x-inkstone-tag'

let activeDrag: string | null = null

/**
 * A dragged tag is kept in page memory as well as in the DataTransfer. The type list is readable
 * during dragover but the payload is not, so the sidebar can recognise a tag drag early yet still
 * needs the name from here to label the destination. Same-document only, which is all we drag
 * between. The plain-text twin is the hashtag itself: a drop onto anything that takes text, the
 * editor included, writes a tag rather than an encoded blob.
 */
export function beginTagDrag(name: string, dataTransfer: DataTransfer): void {
  activeDrag = name
  dataTransfer.setData(TAG_MIME, encodeDataValue(name))
  dataTransfer.setData('text/plain', `#${name}`)
  dataTransfer.effectAllowed = 'move'
}

export function endTagDrag(): void {
  activeDrag = null
}

export function currentTagDrag(): string | null {
  return activeDrag
}

/** A drop is a tag drop only when it carries our own type, so a note or a file can never reach the rename path. */
export function isTagDrag(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(TAG_MIME)
}

/** The dragged tag name, or null when the payload is not one of our tag drags. */
export function droppedTagName(dataTransfer: DataTransfer): string | null {
  if (!isTagDrag(dataTransfer)) return null
  return decodeDataValue(dataTransfer.getData(TAG_MIME)) || activeDrag
}

export function findDroppedTag<T extends { name: string }>(tags: readonly T[], name: string): T | null {
  return tags.find((tag) => tagNamesEqual(tag.name, name)) ?? null
}
