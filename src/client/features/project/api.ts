/** The client half of `/api/project`: one typed function per route, no fetch calls elsewhere. */
import { request } from '../../lib/api'
import type {
  ProjectBoard,
  ProjectBoardBundle,
  ProjectBoardSummary,
  ProjectCard,
  ProjectView,
  ProjectViewType,
} from '@shared/project/model'
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

export async function createProjectCard(boardId: string, input: Partial<ProjectCardCreateInput>): Promise<ProjectCard> {
  const body = await request<{ card: ProjectCard }>(`/api/project/boards/${encodeURIComponent(boardId)}/cards`, { method: 'POST', body: input })
  return body.card
}

export async function deleteProjectCard(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/project/cards/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function patchProjectCard(id: string, patch: Record<string, unknown>): Promise<ProjectCard> {
  const body = await request<{ card: ProjectCard }>(`/api/project/cards/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })
  return body.card
}

export async function createProjectView(boardId: string, viewType: ProjectViewType): Promise<ProjectView> {
  const body = await request<{ view: ProjectView }>(`/api/project/boards/${encodeURIComponent(boardId)}/views`, { method: 'POST', body: { viewType } })
  return body.view
}