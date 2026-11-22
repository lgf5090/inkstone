import type { LazyExoticComponent, ComponentType } from 'react'
import type { OfficeFileType } from '@shared/office/constants'
import type { OfficeEditPlan } from '@shared/office/ai'
import type { OfficeSnapshot } from '@shared/office/model'

export interface OfficeEditorContext {
  readonly [key: string]: string | number | boolean | null
}

export interface OfficeEditorHandle {
  save(): OfficeSnapshot
  flush(): Promise<void>
  undo(): void
  applyPlan(plan: OfficeEditPlan): Promise<void>
  context(): OfficeEditorContext
}

export interface OfficeEditorProps {
  fileId: string
  fileType: OfficeFileType
  title: string
  snapshot: OfficeSnapshot | null
  onReady?: (handle: OfficeEditorHandle) => void
  onContext?: (context: OfficeEditorContext) => void
  onError?: (message: string) => void
}

export type OfficeEditorComponent = LazyExoticComponent<ComponentType<OfficeEditorProps>>