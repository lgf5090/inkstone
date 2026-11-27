import type { ProjectRealtimeEntity } from '@shared/types'

export const PROJECT_REALTIME_EVENT = 'inkstone:project-change'

export interface ProjectRealtimeDetail {
  boardId: string
  cursor: number
  origin: string | null
  entity: ProjectRealtimeEntity
  cardId?: string
  commentId?: string
}

export function emitProjectRealtime(detail: ProjectRealtimeDetail): void {
  window.dispatchEvent(new CustomEvent<ProjectRealtimeDetail>(PROJECT_REALTIME_EVENT, { detail }))
}
