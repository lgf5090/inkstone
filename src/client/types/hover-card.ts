export interface WikiLinkHoverCardState {
  anchor: HTMLElement
  title: string
  noteId: string | null
  missing: boolean
  headline?: string
}

export interface PinnedNoteCardState {
  id: number
  noteId: string | null
  title: string
  missing: boolean
  headline?: string
  x: number
  y: number
  width: number
  height: number
  z: number
}
