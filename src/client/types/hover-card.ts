/** What a plain link previews as: a `[label](url)` span, a bare address, or a picture. */
export interface LinkPreview {
  /** The destination exactly as the note wrote it, truncated for display. */
  href: string;
  /** The words the reader sees, empty when the span shows the address itself. */
  text: string;
  kind: LinkPreviewKind;
  /** The host a browser would contact, or null when the address names no host. */
  host: string | null;
  /** Whether the card may offer to open it: only the schemes a browser can follow. */
  openable: boolean;
  /** True when `href` is a shortened preview of something too long to print whole. */
  truncated: boolean;
  /** The note of this notebook the address points back to, when it does. */
  noteTitle?: string;
  noteId?: string | null;
}

export type LinkPreviewKind = 'web' | 'image' | 'mail' | 'phone' | 'file' | 'other'

export interface WikiLinkHoverCardState {
  anchor: HTMLElement
  title: string
  noteId: string | null
  missing: boolean
  headline?: string
  /** Set on a card that previews a link rather than a note. */
  link?: LinkPreview
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
