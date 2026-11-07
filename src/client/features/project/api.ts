/** The client half of `/api/project`: one typed function per route, no fetch calls elsewhere. */
import { request } from '../../lib/api'
import type { ProjectBoardSummary } from '@shared/project/model'

export async function fetchProjectBoards(signal?: AbortSignal): Promise<ProjectBoardSummary[]> {
  const body = await request<{ boards: ProjectBoardSummary[] }>('/api/project/boards', { signal })
  return body.boards
}
