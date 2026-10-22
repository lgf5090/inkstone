export interface FilePreviewTarget {
  url: string
  filename: string
  mime: string
  size?: number
}

export interface FilePreviewModalProps {
  open: boolean
  onClose: () => void
  file: FilePreviewTarget
}
