/** The client half of `/api/project`: one typed function per route, no fetch calls elsewhere. */
import { CLIENT_HEADER } from '@shared/constants'
import { request } from '../../lib/api'
import type {
  ProjectActivityEntry,
  ProjectAttachment,
  ProjectBoard,
  ProjectBoardBundle,
  ProjectBoardMetadata,
  ProjectBoardPatch,
  ProjectBoardMember,
  ProjectBoardSummary,
  ProjectCard,
  ProjectCardLink,
  ProjectCategory,
  ProjectCategoryBoard,
  ProjectComment,
  ProjectContent,
  ProjectRole,
  ProjectShare,
  ProjectSubscription,
  ProjectView,
  ProjectViewPatch,
  ProjectViewType,
} from '@shared/project/model'
import type { ProjectContentCreateInput, ProjectContentPatchInput } from '@shared/project/validation'
import type { ProjectBoardCreateInput, ProjectCardCreateInput } from '@shared/project/validation'

export async function fetchProjectBoards(signal?: AbortSignal): Promise<ProjectBoardSummary[]> {
  const body = await request<{ boards: ProjectBoardSummary[] }>('/api/project/boards', { signal })
  return body.boards
}

export async function createProjectBoard(input: Partial<ProjectBoardCreateInput>): Promise<ProjectBoardSummary> {
  const body = await request<{ board: ProjectBoardSummary }>('/api/project/boards', { method: 'POST', body: input })
  return body.board
}

export async function deleteProjectBoard(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/project/boards/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function duplicateProjectBoard(id: string): Promise<ProjectBoardSummary> {
  const body = await request<{ board: ProjectBoardSummary }>(`/api/project/boards/${encodeURIComponent(id)}/duplicate`, { method: 'POST', body: {} })
  return body.board
}

export async function renameProjectBoard(id: string, title: string): Promise<ProjectBoard> {
  const body = await request<{ board: ProjectBoard }>(`/api/project/boards/${encodeURIComponent(id)}`, { method: 'PATCH', body: { title } })
  return body.board
}

export async function fetchProjectBoardBundle(id: string, signal?: AbortSignal): Promise<ProjectBoardBundle> {
  return request<ProjectBoardBundle>(`/api/project/boards/${encodeURIComponent(id)}/bundle`, { signal })
}

/** The staleness question a poller asks before paying for the whole bundle. */
export async function fetchBoardCursor(boardId: string, signal?: AbortSignal): Promise<number> {
  const body = await request<{ cursor: number }>(`/api/project/boards/${encodeURIComponent(boardId)}/cursor`, { signal })
  return body.cursor
}

export async function createProjectCard(boardId: string, input: Partial<ProjectCardCreateInput>): Promise<ProjectCard> {
  const body = await request<{ card: ProjectCard }>(`/api/project/boards/${encodeURIComponent(boardId)}/cards`, { method: 'POST', body: input })
  return body.card
}

export async function deleteProjectCard(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/project/cards/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function undeleteProjectCard(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/project/cards/${encodeURIComponent(id)}/undelete`, { method: 'POST', body: {} })
}

export async function batchPatchProjectBoard(boardId: string, input: { cards?: { id: string, patch: Record<string, unknown> }[] }): Promise<void> {
  await request<{ ok: true }>(`/api/project/boards/${encodeURIComponent(boardId)}/batch`, { method: 'PATCH', body: input })
}

export async function batchDeleteProjectBoard(boardId: string, input: { cardIds?: string[] }): Promise<void> {
  await request<{ ok: true }>(`/api/project/boards/${encodeURIComponent(boardId)}/batch-delete`, { method: 'POST', body: input })
}

export async function reorderProjectCategories(categoryIds: string[]): Promise<void> {
  await request<{ ok: true }>('/api/project/categories/order', { method: 'PUT', body: { categoryIds } })
}

export async function reorderCategoryBoards(categoryId: string, boardIds: string[]): Promise<void> {
  await request<{ ok: true }>(`/api/project/categories/${encodeURIComponent(categoryId)}/boards/order`, { method: 'PUT', body: { boardIds } })
}

export async function patchProjectCard(id: string, patch: Record<string, unknown>): Promise<ProjectCard> {
  const body = await request<{ card: ProjectCard }>(`/api/project/cards/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })
  return body.card
}

export async function duplicateProjectCard(id: string): Promise<ProjectCard> {
  const body = await request<{ card: ProjectCard }>(`/api/project/cards/${encodeURIComponent(id)}/duplicate`, { method: 'POST', body: {} })
  return body.card
}

export async function createProjectView(boardId: string, viewType: ProjectViewType): Promise<ProjectView> {
  const body = await request<{ view: ProjectView }>(`/api/project/boards/${encodeURIComponent(boardId)}/views`, { method: 'POST', body: { viewType } })
  return body.view
}

export async function patchProjectBoard(id: string, patch: ProjectBoardPatch): Promise<{ board: ProjectBoard, properties: ProjectBoardBundle['properties'] }> {
  return request<{ board: ProjectBoard, properties: ProjectBoardBundle['properties'] }>(`/api/project/boards/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })
}

export async function patchProjectView(id: string, patch: ProjectViewPatch): Promise<ProjectView> {
  const body = await request<{ view: ProjectView }>(`/api/project/views/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })
  return body.view
}

export async function deleteProjectView(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/project/views/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function duplicateProjectView(id: string): Promise<ProjectView> {
  const body = await request<{ view: ProjectView }>(`/api/project/views/${encodeURIComponent(id)}/duplicate`, { method: 'POST', body: {} })
  return body.view
}

export async function fetchBoardMetadata(id: string): Promise<ProjectBoardMetadata> {
  return request<ProjectBoardMetadata>(`/api/project/boards/${encodeURIComponent(id)}/metadata`)
}

export function projectBoardExportUrl(id: string, kind: 'csv' | 'archive' | 'markdown'): string {
  return `/api/project/boards/${encodeURIComponent(id)}/${kind}`
}

export async function fetchCardComments(cardId: string, signal?: AbortSignal): Promise<ProjectComment[]> {
  const body = await request<{ comments: ProjectComment[] }>(`/api/project/cards/${encodeURIComponent(cardId)}/comments`, { signal })
  return body.comments
}

export async function createCardComment(cardId: string, body: string): Promise<ProjectComment> {
  const result = await request<{ comment: ProjectComment }>(`/api/project/cards/${encodeURIComponent(cardId)}/comments`, { method: 'POST', body: { body } })
  return result.comment
}

export async function patchCardComment(id: string, body: string): Promise<ProjectComment> {
  const result = await request<{ comment: ProjectComment }>(`/api/project/comments/${encodeURIComponent(id)}`, { method: 'PATCH', body: { body } })
  return result.comment
}

export async function deleteCardComment(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/project/comments/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function createCardContent(cardId: string, input: Partial<ProjectContentCreateInput>): Promise<ProjectContent> {
  const result = await request<{ content: ProjectContent }>(`/api/project/cards/${encodeURIComponent(cardId)}/contents`, { method: 'POST', body: input })
  return result.content
}

export async function patchCardContent(id: string, patch: ProjectContentPatchInput): Promise<ProjectContent> {
  const result = await request<{ content: ProjectContent }>(`/api/project/contents/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })
  return result.content
}

export async function deleteCardContent(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/project/contents/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export interface ProjectTemplateSummary {
  id: string
  title: string
  icon: string
  description: string
  isBuiltIn: boolean
}

export async function fetchProjectTemplates(signal?: AbortSignal, locale = ''): Promise<ProjectTemplateSummary[]> {
  const body = await request<{ templates: ProjectTemplateSummary[] }>(`/api/project/templates?locale=${encodeURIComponent(locale)}`, { signal })
  return body.templates
}

export async function createBoardFromTemplate(templateId: string, locale = ''): Promise<ProjectBoardSummary> {
  const body = await request<{ board: ProjectBoardSummary }>('/api/project/boards/from-template', { method: 'POST', body: { templateId, locale } })
  return body.board
}

export async function saveBoardAsTemplate(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/project/boards/${encodeURIComponent(id)}/save-as-template`, { method: 'POST', body: {} })
}

export async function fetchProjectCategories(signal?: AbortSignal): Promise<{ categories: ProjectCategory[], categoryBoards: ProjectCategoryBoard[] }> {
  return request<{ categories: ProjectCategory[], categoryBoards: ProjectCategoryBoard[] }>('/api/project/categories', { signal })
}

export async function createProjectCategory(name: string): Promise<ProjectCategory> {
  const body = await request<{ category: ProjectCategory }>('/api/project/categories', { method: 'POST', body: { name } })
  return body.category
}

export async function patchProjectCategory(id: string, patch: { name?: string, collapsed?: boolean }): Promise<ProjectCategory> {
  const body = await request<{ category: ProjectCategory }>(`/api/project/categories/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })
  return body.category
}

export async function deleteProjectCategory(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/project/categories/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function addBoardToCategory(categoryId: string, boardId: string): Promise<ProjectCategoryBoard> {
  const body = await request<{ categoryBoard: ProjectCategoryBoard }>(`/api/project/categories/${encodeURIComponent(categoryId)}/boards/${encodeURIComponent(boardId)}`, { method: 'POST', body: {} })
  return body.categoryBoard
}

export async function setCategoryBoardHidden(categoryId: string, boardId: string, hidden: boolean): Promise<ProjectCategoryBoard> {
  const body = await request<{ categoryBoard: ProjectCategoryBoard }>(`/api/project/categories/${encodeURIComponent(categoryId)}/boards/${encodeURIComponent(boardId)}/hidden`, { method: 'PUT', body: { hidden } })
  return body.categoryBoard
}

export interface ProjectSearchResult {
  boards: { id: string, title: string, icon: string }[]
  cards: { id: string, boardId: string, title: string }[]
}

export async function searchProject(query: string, signal?: AbortSignal): Promise<ProjectSearchResult> {
  return request<ProjectSearchResult>(`/api/project/search?q=${encodeURIComponent(query)}`, { signal })
}

export async function getProjectShare(boardId: string): Promise<ProjectShare | null> {
  const body = await request<{ share: ProjectShare | null }>(`/api/project/boards/${encodeURIComponent(boardId)}/share`)
  return body.share
}

export async function putProjectShare(boardId: string, input: { password?: string | null, expiresAt?: number | null }): Promise<ProjectShare> {
  const body = await request<{ share: ProjectShare }>(`/api/project/boards/${encodeURIComponent(boardId)}/share`, { method: 'PUT', body: input })
  return body.share
}

export async function deleteProjectShare(boardId: string): Promise<void> {
  await request<{ ok: true }>(`/api/project/boards/${encodeURIComponent(boardId)}/share`, { method: 'DELETE' })
}

/** The stranger's read: no session, the slug and passcode are the whole capability. */
export async function readPublicProjectBoard(slug: string, password?: string): Promise<ProjectBoardBundle> {
  return request<ProjectBoardBundle>(`/api/project/public/${encodeURIComponent(slug)}`, { method: 'POST', body: password ? { password } : {} })
}

export async function importProjectArchive(bytes: Uint8Array): Promise<ProjectBoardSummary> {
  const response = await fetch('/api/project/boards/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip', [CLIENT_HEADER]: '1' },
    body: bytes as BodyInit,
    credentials: 'same-origin',
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
    throw new Error(body?.error?.message ?? `Import failed (${response.status})`)
  }
  const body = await response.json() as { board: ProjectBoardSummary }
  return body.board
}

export async function fetchCardLinks(cardId: string): Promise<ProjectCardLink[]> {
  const body = await request<{ links: ProjectCardLink[] }>(`/api/project/cards/${encodeURIComponent(cardId)}/links`)
  return body.links
}

export async function fetchBoardLinks(boardId: string, signal?: AbortSignal): Promise<ProjectCardLink[]> {
  const body = await request<{ links: ProjectCardLink[] }>(`/api/project/boards/${encodeURIComponent(boardId)}/links`, { signal })
  return body.links
}

export async function addCardLink(cardId: string, toCardId: string, kind: ProjectCardLink['kind']): Promise<void> {
  await request<{ ok: true }>(`/api/project/cards/${encodeURIComponent(cardId)}/links`, { method: 'POST', body: { toCardId, kind } })
}

export async function removeCardLink(cardId: string, toCardId: string, kind: ProjectCardLink['kind']): Promise<void> {
  await request<{ ok: true }>(`/api/project/cards/${encodeURIComponent(cardId)}/links/${encodeURIComponent(toCardId)}?kind=${kind}`, { method: 'DELETE' })
}

export async function fetchBoardActivity(boardId: string, signal?: AbortSignal): Promise<ProjectActivityEntry[]> {
  const body = await request<{ activity: ProjectActivityEntry[] }>(`/api/project/boards/${encodeURIComponent(boardId)}/activity`, { signal })
  return body.activity
}

export async function saveCardAsTemplate(cardId: string): Promise<void> {
  await request<{ ok: true }>(`/api/project/cards/${encodeURIComponent(cardId)}/save-as-template`, { method: 'POST', body: {} })
}

export async function createCardFromTemplate(boardId: string, templateId: string): Promise<ProjectCard> {
  const body = await request<{ card: ProjectCard }>(`/api/project/boards/${encodeURIComponent(boardId)}/cards/from-template`, { method: 'POST', body: { templateId } })
  return body.card
}

export async function listBoardFiles(boardId: string, cardId?: string): Promise<ProjectAttachment[]> {
  const query = cardId ? `?cardId=${encodeURIComponent(cardId)}` : ''
  const body = await request<{ files: ProjectAttachment[] }>(`/api/project/boards/${encodeURIComponent(boardId)}/files${query}`)
  return body.files
}

export async function uploadBoardFile(boardId: string, file: File, cardId?: string): Promise<ProjectAttachment> {
  const form = new FormData()
  form.append('file', file)
  if (cardId) form.append('cardId', cardId)
  const body = await request<{ file: ProjectAttachment }>(`/api/project/boards/${encodeURIComponent(boardId)}/files`, { method: 'POST', formData: form })
  return body.file
}

export async function deleteProjectFile(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/project/files/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function projectFileUrl(id: string): string {
  return `/api/project/files/${encodeURIComponent(id)}`
}
export async function fetchBoardMembers(boardId: string, signal?: AbortSignal): Promise<ProjectBoardMember[]> {
  const body = await request<{ members: ProjectBoardMember[] }>(`/api/project/boards/${encodeURIComponent(boardId)}/members`, { signal })
  return body.members
}

export async function addBoardMember(boardId: string, userId: string, role: ProjectRole): Promise<ProjectBoardMember> {
  const body = await request<{ member: ProjectBoardMember }>(`/api/project/boards/${encodeURIComponent(boardId)}/members`, { method: 'POST', body: { userId, role } })
  return body.member
}

export async function setBoardMemberRole(boardId: string, userId: string, role: ProjectRole): Promise<ProjectBoardMember> {
  const body = await request<{ member: ProjectBoardMember }>(`/api/project/boards/${encodeURIComponent(boardId)}/members/${encodeURIComponent(userId)}`, { method: 'PATCH', body: { role } })
  return body.member
}

export async function removeBoardMember(boardId: string, userId: string): Promise<void> {
  await request<{ ok: true }>(`/api/project/boards/${encodeURIComponent(boardId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' })
}

export async function joinProjectBoard(boardId: string): Promise<ProjectBoardMember> {
  return request<ProjectBoardMember>(`/api/project/boards/${encodeURIComponent(boardId)}/join`, { method: 'POST', body: {} })
}

export async function leaveProjectBoard(boardId: string): Promise<void> {
  await request<{ ok: true }>(`/api/project/boards/${encodeURIComponent(boardId)}/leave`, { method: 'POST', body: {} })
}

export async function fetchProjectSubscriptions(signal?: AbortSignal): Promise<ProjectSubscription[]> {
  const body = await request<{ subscriptions: ProjectSubscription[] }>('/api/project/subscriptions', { signal })
  return body.subscriptions
}

export async function watchProjectBlock(blockType: ProjectSubscription['blockType'], blockId: string): Promise<void> {
  await request<{ subscription: ProjectSubscription }>('/api/project/subscriptions', { method: 'POST', body: { blockType, blockId } })
}

export async function unwatchProjectBlock(blockId: string): Promise<void> {
  await request<{ ok: true }>(`/api/project/subscriptions/${encodeURIComponent(blockId)}`, { method: 'DELETE' })
}

export interface DeletedProjectCard { id: string, title: string, deleteAt: number }

export async function fetchProjectTrash(signal?: AbortSignal): Promise<ProjectBoardSummary[]> {
  const body = await request<{ boards: ProjectBoardSummary[] }>('/api/project/trash', { signal })
  return body.boards
}

export async function fetchBoardTrash(boardId: string, signal?: AbortSignal): Promise<DeletedProjectCard[]> {
  const body = await request<{ cards: DeletedProjectCard[] }>(`/api/project/boards/${encodeURIComponent(boardId)}/trash`, { signal })
  return body.cards
}

export async function restoreProjectBoard(boardId: string): Promise<void> {
  await request<{ ok: true }>(`/api/project/boards/${encodeURIComponent(boardId)}/undelete`, { method: 'POST', body: {} })
}
