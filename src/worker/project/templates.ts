/**
 * Templates: the built-in starting points plus the account's own boards saved as templates. Creating
 * from a built-in replays its properties, views and sample cards through the same writers every other
 * create uses; creating from a saved template is a duplicate of that board.
 */
import type { ProjectBoard, ProjectBoardSummary } from '@shared/project/model'
import { BUILT_IN_PROJECT_TEMPLATES } from '@shared/project/templates'
import { ApiError } from '../lib/errors'
import { createProjectBoard, getProjectBoardRow } from './boards'
import { createProjectCard } from './cards'
import { createProjectContent } from './contents'
import { duplicateProjectBoard } from './duplicate'
import { readProjectBoardBundle } from './bundle'
import { createProjectView } from './views'

export interface ProjectTemplateSummary {
  id: string
  title: string
  icon: string
  description: string
  isBuiltIn: boolean
}

export async function listProjectTemplates(db: D1Database, userId: string): Promise<ProjectTemplateSummary[]> {
  const builtIn = BUILT_IN_PROJECT_TEMPLATES.map((template) => ({
    id: template.id, title: template.title, icon: template.icon, description: template.description, isBuiltIn: true,
  }))
  const { results } = await db
    .prepare('SELECT id, title, icon, description FROM project_boards WHERE owner_id = ?1 AND is_template = 1 AND delete_at = 0 ORDER BY update_at DESC')
    .bind(userId)
    .all<{ id: string, title: string, icon: string, description: string }>()
  const own = results.map((row) => ({ id: row.id, title: row.title, icon: row.icon, description: row.description, isBuiltIn: false }))
  return [...builtIn, ...own]
}

export async function saveBoardAsTemplate(db: D1Database, boardId: string, now: number): Promise<void> {
  await db.prepare('UPDATE project_boards SET is_template = 1, update_at = ?1 WHERE id = ?2').bind(now, boardId).run()
}

export async function createBoardFromTemplate(
  db: D1Database,
  userId: string,
  templateId: string,
  now: number,
): Promise<ProjectBoardSummary> {
  const builtIn = BUILT_IN_PROJECT_TEMPLATES.find((template) => template.id === templateId)
  if (builtIn) {
    const board = await createProjectBoard(db, userId, {
      title: builtIn.title,
      icon: builtIn.icon,
      description: builtIn.description,
      type: 'P',
      minimumRole: '',
      showDescription: false,
      isTemplate: false,
      cardProperties: builtIn.properties,
    }, now)
    for (const view of builtIn.views) {
      await createProjectView(db, board.id, userId, {
        title: view.title,
        viewType: view.viewType,
        fields: view.groupById ? { groupById: view.groupById } : {},
      }, now)
    }
    for (const card of builtIn.cards) {
      const created = await createProjectCard(db, board as ProjectBoard, userId, { title: card.title, parentId: '', icon: '', isTemplate: false, values: card.values ?? {} }, now)
      for (const content of card.contents ?? []) {
        await createProjectContent(db, created, userId, {
          type: content.type,
          title: content.title,
          fields: content.type === 'checkbox' ? { checked: content.checked ?? false } : {},
        }, now)
      }
    }
    return board
  }
  const source = await getProjectBoardRow(db, templateId)
  if (!source || source.ownerId !== userId || !source.isTemplate || source.deleteAt !== 0) throw ApiError.notFound('Template not found')
  const bundle = await readProjectBoardBundle(db, source, 'admin')
  return duplicateProjectBoard(db, bundle, userId, now)
}