export interface ExcalidrawLibraryItem {
  id: string
  folderId: string | null
  name: string
  elements: readonly any[]
  status?: 'published' | 'unpublished'
  created: number
  error?: string
  svgPreview?: string
}

export interface ExcalidrawLibraryFolder {
  id: string
  name: string
  parentId: string | null
  createdAt: number
  updatedAt: number
  order: number
  color?: string
  icon?: string
}

export interface ExcalidrawLibraryManifest {
  version: number
  folders: ExcalidrawLibraryFolder[]
  items: ExcalidrawLibraryItem[]
  updatedAt: number
}

export interface LibraryFolderNode {
  id: string
  name: string
  parentId: string | null
  order: number
  depth: number
  children: LibraryFolderNode[]
  itemCount: number
  directCount: number
  color?: string
  icon?: string
}

export interface OfficialLibraryEntry {
  id?: string
  name: string
  description?: string
  authors?: Array<{ name: string; url?: string }>
  source: string
  preview?: string
  created?: string
  updated?: string
  totalDownloads?: number
}
