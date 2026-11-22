import type { OfficeEditorHandle } from './contracts'

const handles = new Map<string, OfficeEditorHandle>()

export function registerOfficeEditorHandle(fileId: string, handle: OfficeEditorHandle): () => void {
  handles.set(fileId, handle)
  return () => {
    if (handles.get(fileId) === handle) handles.delete(fileId)
  }
}

export function getOfficeEditorHandle(fileId: string): OfficeEditorHandle | null {
  return handles.get(fileId) ?? null
}