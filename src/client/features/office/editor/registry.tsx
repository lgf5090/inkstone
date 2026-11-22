import { lazy } from 'react'
import type { OfficeFileType } from '@shared/office/constants'
import type { OfficeEditorComponent } from './contracts'

/** The one table that decides which editor chunk an Office file downloads. */
export const OFFICE_EDITOR_COMPONENTS: Record<OfficeFileType, OfficeEditorComponent> = {
  sheets: lazy(() => import('./sheets').then((module) => ({ default: module.OfficeSheetsEditor }))),
  docs: lazy(() => import('./docs').then((module) => ({ default: module.OfficeDocsEditor }))),
  slides: lazy(() => import('./slides').then((module) => ({ default: module.OfficeSlidesEditor }))),
  bases: lazy(() => import('./bases').then((module) => ({ default: module.OfficeBasesEditor }))),
  boards: lazy(() => import('./boards').then((module) => ({ default: module.OfficeBoardsEditor }))),
  pdfs: lazy(() => import('./pdfs').then((module) => ({ default: module.OfficePdfsEditor }))),
}