import {
  deriveMemoContentSearch,
  deriveMemoSnippet,
  deriveMemoTitle,
  scanMemoAttachmentIds,
  scanMemoProperties,
  scanMemoTags,
} from '@shared/memos/markdown'

export interface MemoDerivedFields {
  title: string
  snippet: string
  tags: string[]
  contentSearch: string
  hasLink: boolean
  hasCode: boolean
  hasTaskList: boolean
  hasIncompleteTasks: boolean
  hasLocation: boolean
  attachmentIds: string[]
}

export function deriveMemoFields(content: string, hasLocation: boolean): MemoDerivedFields {
  const properties = scanMemoProperties(content)
  return {
    title: deriveMemoTitle(content),
    snippet: deriveMemoSnippet(content),
    tags: scanMemoTags(content),
    contentSearch: deriveMemoContentSearch(content),
    hasLink: properties.hasLink,
    hasCode: properties.hasCode,
    hasTaskList: properties.hasTaskList,
    hasIncompleteTasks: properties.hasIncompleteTasks,
    hasLocation,
    attachmentIds: scanMemoAttachmentIds(content),
  }
}
