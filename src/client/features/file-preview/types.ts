export interface FilePreviewTarget {
  url: string
  filename: string
  mime: string
  size?: number
}

/** Every renderer the viewer can load, named once so a policy and the registry cannot drift apart. */
export type FilePreviewRenderer =
  | 'pdf'
  | 'image'
  | 'text'
  | 'spreadsheet'
  | 'word'
  | 'presentation'
  | 'media'
  | 'archive'
  | 'ofd'

/**
 * Per-extension answers a host application supplies for its own files, keyed by the lowercase
 * extension without the dot. `null` refuses a preview, and `native` hands the file back to the
 * viewer's own answer.
 */
export interface FilePreviewPolicy {
  byExtension: Record<string, FilePreviewRenderer | 'native' | null>
}

export interface FilePreviewModalProps {
  open: boolean
  onClose: () => void
  file: FilePreviewTarget
  policy?: FilePreviewPolicy
}
