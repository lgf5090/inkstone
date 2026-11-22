import type { AssistantPageContext } from '@shared/assistant'
import type { OfficeFileType } from '@shared/office/constants'
import type { OfficeEditorContext } from '../editor/contracts'

export interface OfficeSurfaceInput {
  fileId: string | null
  fileType: OfficeFileType | null
  title: string | null
  folder: string | null
  view: string
  editor?: OfficeEditorContext | null
}

/** A pointer to the screen, never the document body. */
export function officePageContext(input: OfficeSurfaceInput): AssistantPageContext {
  const facts: string[] = []
  if (input.fileId) facts.push(`file id: ${input.fileId}`)
  if (input.fileType) facts.push(`type: ${input.fileType}`)
  if (input.folder) facts.push(`folder: ${input.folder}`)
  facts.push(`view: ${input.view}`)
  if (input.editor) {
    for (const [key, value] of Object.entries(input.editor).slice(0, 5)) {
      if (value !== null && value !== '') facts.push(`${key}: ${String(value).slice(0, 120)}`)
    }
  }
  return {
    surface: 'office',
    label: input.title ?? 'office',
    facts: facts.slice(0, 8),
  }
}