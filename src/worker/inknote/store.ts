/**
 * Every read and write the Inknote routes make against D1.
 *
 * The same rules as `notes/store.ts`: a store is built per request from the authenticated account,
 * every statement carries `user_id`, and a mutation's statements stay in one batch so the rev guard
 * means what it says.
 */
import { DEFAULT_INKNOTE_SETTINGS, INKNOTE_LIMITS, INKNOTE_PAGE_HEIGHT, INKNOTE_PAGE_WIDTH, PAPER_STYLES } from '@shared/inknote/constants'
import { normalizePaperColor } from '@shared/inknote/color'
import { extractPageText, emptyPageContent, parseInknotePageContent, sanitizePageForSave, serializePageContent, utf8Bytes } from '@shared/inknote/parse'
import { sanitizeInknoteSettings } from '@shared/inknote/settings'
import type {
  InknotePageContent,
  InknoteLibrary,
  InknoteNoteMeta,
  InknoteNotebook,
  InknotePage,
  InknotePaper,
  InknoteSettings,
  InknoteSubject,
  InknoteTemplate,
} from '@shared/inknote/types'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { acquireLease } from '../lib/lease'
import { ensureInknoteSeed } from './seed'

type Row = Record<string, unknown>

function text(row: Row, key: string): string {
  return typeof row[key] === 'string' ? row[key] as string : ''
}
function number(row: Row, key: string): number {
  return typeof row[key] === 'number' ? row[key] as number : Number(row[key] ?? 0)
}
function nullableText(row: Row, key: string): string | null {
  return typeof row[key] === 'string' ? row[key] as string : null
}

export function paperFromRow(row: Row): InknotePaper {
  const style = text(row, 'paper_style')
  const allowed = ['blank', 'line', 'grid', 'dot', 'cornell', 'check', 'planner', 'story', 'music', 'legal']
  return {
    style: (allowed.includes(style) ? style : 'line') as InknotePaper['style'],
    color: text(row, 'paper_color') || 'white',
    spacing: text(row, 'paper_spacing') === 'tight' ? 'tight' : text(row, 'paper_spacing') === 'wide' ? 'wide' : 'normal',
  }
}

export function toNoteMeta(row: Row): InknoteNoteMeta {
  const coverAssetId = nullableText(row, 'cover_asset_id')
  return {
    id: text(row, 'id'),
    notebookId: text(row, 'notebook_id'),
    title: text(row, 'title'),
    pageCount: number(row, 'page_count'),
    contentBytes: number(row, 'content_bytes'),
    pageWidth: number(row, 'page_width'),
    pageHeight: number(row, 'page_height'),
    contentWidth: number(row, 'content_width'),
    contentHeight: number(row, 'content_height'),
    paper: paperFromRow(row),
    colorTag: nullableText(row, 'color_tag'),
    pinned: number(row, 'pinned') === 1,
    coverAssetId,
    coverUrl: coverAssetId ? `/api/inknote/assets/${coverAssetId}` : null,
    rev: number(row, 'rev'),
    createdAt: number(row, 'created_at'),
    updatedAt: number(row, 'updated_at'),
    deletedAt: typeof row.deleted_at === 'number' ? row.deleted_at : null,
  }
}

function toSubject(row: Row): InknoteSubject {
  return { id: text(row, 'id'), name: text(row, 'name'), position: number(row, 'position') }
}
function toNotebook(row: Row): InknoteNotebook {
  return {
    id: text(row, 'id'),
    subjectId: text(row, 'subject_id'),
    name: text(row, 'name'),
    coverColor: text(row, 'cover_color'),
    emoji: text(row, 'emoji'),
    position: number(row, 'position'),
  }
}
export function toTemplate(row: Row): InknoteTemplate {
  let texts: InknoteTemplate['texts'] = []
  try {
    const parsed = JSON.parse(text(row, 'texts'))
    if (Array.isArray(parsed)) texts = parsed
  } catch {
    texts = []
  }
  const bgAssetId = nullableText(row, 'bg_asset_id')
  return {
    id: text(row, 'id'),
    name: text(row, 'name'),
    paper: paperFromRow(row),
    bgAssetId,
    bgUrl: bgAssetId ? `/api/inknote/assets/${bgAssetId}` : null,
    texts,
    title: text(row, 'title'),
    sub: text(row, 'sub'),
    titleSize: number(row, 'title_size'),
    subSize: number(row, 'sub_size'),
    builtIn: false,
    createdAt: number(row, 'created_at'),
  }
}

export const INKNOTE_PAGE_SIZE_LIMITS = { minWidth: 200, maxWidth: 4000, minHeight: 200, maxHeight: 4000 } as const

export type InknotePageDto = InknotePage & { contentError?: 'invalid_json' | 'invalid_shape' | 'too_large' }

const NOTE_COLUMNS = 'id, notebook_id, title, paper_style, paper_color, paper_spacing, page_width, page_height, content_width, content_height, color_tag, pinned, page_count, content_bytes, cover_asset_id, rev, created_at, updated_at, deleted_at'

export class InknoteStore {
  constructor(readonly db: D1Database, readonly userId: string) {}

  async library(): Promise<InknoteLibrary & { counts: { subjects: number; notebooks: number; notes: number } }> {
    await ensureInknoteSeed(this.db, this.userId)
    const [subjects, notebooks, notes, settings, templates] = await Promise.all([
      this.db.prepare(`SELECT id, name, position FROM inknote_subjects WHERE user_id = ?1 ORDER BY position, id`).bind(this.userId).all<Row>(),
      this.db.prepare(`SELECT id, subject_id, name, cover_color, emoji, position FROM inknote_notebooks WHERE user_id = ?1 ORDER BY position, id`).bind(this.userId).all<Row>(),
      this.db.prepare(`SELECT ${NOTE_COLUMNS} FROM inknote_notes WHERE user_id = ?1 AND deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC, id`).bind(this.userId).all<Row>(),
      this.readSettings(),
      this.db.prepare(`SELECT id, name, paper_style, paper_color, paper_spacing, bg_asset_id, texts, title, sub, title_size, sub_size, created_at FROM inknote_templates WHERE user_id = ?1 ORDER BY created_at, id`).bind(this.userId).all<Row>(),
    ])
    const noteMetas = notes.results.map(toNoteMeta)
    return {
      subjects: subjects.results.map(toSubject),
      notebooks: notebooks.results.map(toNotebook),
      notes: noteMetas,
      settings,
      templates: templates.results.map(toTemplate),
      counts: { subjects: subjects.results.length, notebooks: notebooks.results.length, notes: noteMetas.length },
    }
  }


  async trash(): Promise<InknoteNoteMeta[]> {
    const { results } = await this.db.prepare(
      `SELECT ${NOTE_COLUMNS} FROM inknote_notes WHERE user_id = ?1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, id`,
    ).bind(this.userId).all<Row>()
    return results.map(toNoteMeta)
  }

  async readSettings(): Promise<InknoteSettings> {
    const row = await this.db.prepare(`SELECT config FROM inknote_settings WHERE user_id = ?1`).bind(this.userId).first<{ config: string }>()
    if (!row) return { ...DEFAULT_INKNOTE_SETTINGS }
    try {
      return sanitizeInknoteSettings(JSON.parse(row.config))
    } catch {
      return { ...DEFAULT_INKNOTE_SETTINGS }
    }
  }

  async writeSettings(raw: unknown, baseUpdatedAt?: number): Promise<{ config: InknoteSettings; updatedAt: number }> {
    const settings = sanitizeInknoteSettings(raw)
    const now = Date.now()
    if (baseUpdatedAt !== undefined) {
      const current = await this.db.prepare(`SELECT updated_at FROM inknote_settings WHERE user_id = ?1`).bind(this.userId).first<{ updated_at: number }>()
      if (current && current.updated_at !== baseUpdatedAt) throw ApiError.conflict('The settings changed on another device')
    }
    await this.db.prepare(
      `INSERT INTO inknote_settings (user_id, config, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
    ).bind(this.userId, JSON.stringify(settings), now).run()
    return { config: settings, updatedAt: now }
  }

  async subjectCount(): Promise<number> {
    return Number((await this.db.prepare(`SELECT COUNT(*) AS n FROM inknote_subjects WHERE user_id = ?1`).bind(this.userId).first<{ n: number }>())?.n ?? 0)
  }
  async notebookCount(): Promise<number> {
    return Number((await this.db.prepare(`SELECT COUNT(*) AS n FROM inknote_notebooks WHERE user_id = ?1`).bind(this.userId).first<{ n: number }>())?.n ?? 0)
  }
  async noteCount(): Promise<number> {
    return Number((await this.db.prepare(`SELECT COUNT(*) AS n FROM inknote_notes WHERE user_id = ?1`).bind(this.userId).first<{ n: number }>())?.n ?? 0)
  }

  private async subjectExists(id: string): Promise<boolean> {
    return Boolean(await this.db.prepare(`SELECT id FROM inknote_subjects WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id).first())
  }

  private async notebookCountForSubject(id: string): Promise<number> {
    return Number((await this.db.prepare(`SELECT COUNT(*) AS n FROM inknote_notebooks WHERE user_id = ?1 AND subject_id = ?2`).bind(this.userId, id).first<{ n: number }>())?.n ?? 0)
  }

  async createSubject(input: string | { id?: string; name: string; position?: number }): Promise<{ subject: InknoteSubject; created: boolean }> {
    const request = typeof input === 'string' ? { name: input } : input
    const name = request.name.trim()
    if (!name) throw ApiError.badRequest('A project needs a name')
    if (Array.from(name).length > INKNOTE_LIMITS.nameMaxLength) throw ApiError.badRequest('The project name is too long')
    const id = request.id ?? newId()
    const owner = await ownerOf(this.db, 'inknote_subjects', id)
    if (owner && owner !== this.userId) throw ApiError.conflict('That project id is already in use')
    if (owner === this.userId) {
      const row = await this.db.prepare(`SELECT id, name, position FROM inknote_subjects WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id).first<Row>()
      if (row) return { subject: toSubject(row), created: false }
    }
    if (await this.subjectCount() >= INKNOTE_LIMITS.subjectsPerUser) throw ApiError.badRequest('Too many projects')
    const position = request.position ?? Number((await this.db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM inknote_subjects WHERE user_id = ?1`).bind(this.userId).first<{ p: number }>())?.p ?? 0)
    await this.db.prepare(`INSERT INTO inknote_subjects (user_id, id, name, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`).bind(this.userId, id, name, position, Date.now()).run()
    return { subject: { id, name, position }, created: true }
  }


  async updateSubject(id: string, patch: { name?: string; position?: number }): Promise<InknoteSubject> {
    const row = await this.db.prepare(`SELECT id, name, position FROM inknote_subjects WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id).first<Row>()
    if (!row) throw ApiError.notFound('Project not found')
    const name = patch.name === undefined ? text(row, 'name') : patch.name.trim()
    if (!name || Array.from(name).length > INKNOTE_LIMITS.nameMaxLength) throw ApiError.badRequest('The project name is too long')
    const position = patch.position ?? number(row, 'position')
    await this.db.prepare(`UPDATE inknote_subjects SET name = ?3, position = ?4, updated_at = ?5 WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id, name, position, Date.now()).run()
    return { id, name, position }
  }


  async createNotebook(input: { id?: string; subjectId: string; name: string; coverColor?: string; emoji?: string; position?: number }): Promise<{ notebook: InknoteNotebook; created: boolean }> {
    if (!await this.subjectExists(input.subjectId)) throw ApiError.notFound('Project not found')
    const name = input.name.trim()
    if (!name) throw ApiError.badRequest('A notebook needs a name')
    if (Array.from(name).length > INKNOTE_LIMITS.nameMaxLength) throw ApiError.badRequest('The notebook name is too long')
    const id = input.id ?? newId()
    const owner = await ownerOf(this.db, 'inknote_notebooks', id)
    if (owner && owner !== this.userId) throw ApiError.conflict('That notebook id is already in use')
    if (owner === this.userId) {
      const row = await this.db.prepare(`SELECT id, subject_id, name, cover_color, emoji, position FROM inknote_notebooks WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id).first<Row>()
      if (row) return { notebook: toNotebook(row), created: false }
    }
    if (await this.notebookCount() >= INKNOTE_LIMITS.notebooksPerUser) throw ApiError.badRequest('Too many notebooks')
    const position = input.position ?? Number((await this.db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM inknote_notebooks WHERE user_id = ?1 AND subject_id = ?2`).bind(this.userId, input.subjectId).first<{ p: number }>())?.p ?? 0)
    const notebook: InknoteNotebook = { id, subjectId: input.subjectId, name, coverColor: input.coverColor ?? '', emoji: input.emoji ?? '', position }
    await this.db.prepare(`INSERT INTO inknote_notebooks (user_id, id, subject_id, name, cover_color, emoji, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`).bind(this.userId, id, input.subjectId, name, notebook.coverColor, notebook.emoji, position, Date.now()).run()
    return { notebook, created: true }
  }


  async updateNotebook(id: string, patch: { name?: string; coverColor?: string; emoji?: string; position?: number }): Promise<InknoteNotebook> {
    const row = await this.db.prepare(`SELECT id, subject_id, name, cover_color, emoji, position FROM inknote_notebooks WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id).first<Row>()
    if (!row) throw ApiError.notFound('Notebook not found')
    const name = patch.name === undefined ? text(row, 'name') : patch.name.trim()
    if (!name || Array.from(name).length > INKNOTE_LIMITS.nameMaxLength) throw ApiError.badRequest('The notebook name is too long')
    const notebook: InknoteNotebook = {
      id,
      subjectId: text(row, 'subject_id'),
      name,
      coverColor: patch.coverColor ?? text(row, 'cover_color'),
      emoji: patch.emoji ?? text(row, 'emoji'),
      position: patch.position ?? number(row, 'position'),
    }
    await this.db.prepare(`UPDATE inknote_notebooks SET name = ?3, cover_color = ?4, emoji = ?5, position = ?6, updated_at = ?7 WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id, notebook.name, notebook.coverColor, notebook.emoji, notebook.position, Date.now()).run()
    return notebook
  }


  async deleteNotebook(id: string): Promise<{ trashed: number; removed: number }> {
    const row = await this.db.prepare(`SELECT id FROM inknote_notebooks WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id).first()
    if (!row) throw ApiError.notFound('Notebook not found')
    const result = await this.db.prepare(`UPDATE inknote_notes SET deleted_at = ?3 WHERE user_id = ?1 AND notebook_id = ?2 AND deleted_at IS NULL`).bind(this.userId, id, Date.now()).run()
    await this.db.prepare(`DELETE FROM inknote_notebooks WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id).run()
    return { trashed: result.meta.changes ?? 0, removed: 1 }
  }


  async deleteSubject(id: string): Promise<{ trashed: number; removed: number }> {
    if (!await this.subjectExists(id)) throw ApiError.notFound('Project not found')
    const notebookCount = await this.notebookCountForSubject(id)
    const result = await this.db.prepare(`UPDATE inknote_notes SET deleted_at = ?3 WHERE user_id = ?1 AND notebook_id IN (SELECT id FROM inknote_notebooks WHERE user_id = ?1 AND subject_id = ?2) AND deleted_at IS NULL`).bind(this.userId, id, Date.now()).run()
    await this.db.prepare(`DELETE FROM inknote_notebooks WHERE user_id = ?1 AND subject_id = ?2`).bind(this.userId, id).run()
    await this.db.prepare(`DELETE FROM inknote_subjects WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id).run()
    return { trashed: result.meta.changes ?? 0, removed: notebookCount }
  }


  async getNote(id: string): Promise<{ note: InknoteNoteMeta; pages: InknotePage[] }> {
    const note = await this.db.prepare(
      `SELECT ${NOTE_COLUMNS} FROM inknote_notes WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
    ).bind(this.userId, id).first<Row>()
    if (!note) throw ApiError.notFound('Note not found')
    return { note: toNoteMeta(note), pages: await this.pagesFor(id) }
  }

  async pagesFor(noteId: string): Promise<InknotePageDto[]> {
    const { results } = await this.db.prepare(
      `SELECT id, position, content, rev, updated_at FROM inknote_pages WHERE user_id = ?1 AND note_id = ?2 ORDER BY position, id`,
    ).bind(this.userId, noteId).all<Row>()
    return results.map((row) => {
      const parsed = parseInknotePageContent(text(row, 'content'))
      return {
        id: text(row, 'id'),
        position: number(row, 'position'),
        content: parsed.ok ? parsed.content : emptyPageContent(),
        ...(parsed.ok ? {} : { contentError: parsed.reason }),
        rev: number(row, 'rev'),
        updatedAt: number(row, 'updated_at'),
      }
    })
  }

  async getNoteWithPages(id: string, mode: 'all' | 'none' = 'all'): Promise<{ note: InknoteNoteMeta; pages: InknotePageDto[] } | null> {
    const row = await this.db.prepare(`SELECT ${NOTE_COLUMNS} FROM inknote_notes WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`).bind(this.userId, id).first<Row>()
    if (!row) return null
    return { note: toNoteMeta(row), pages: mode === 'all' ? await this.pagesFor(id) : [] }
  }


  async createNote(input: { id?: string; notebookId: string; title?: string; paper?: unknown; pageWidth?: number; pageHeight?: number }): Promise<{ note: InknoteNoteMeta; pages: InknotePage[]; created: boolean }> {
    const notebook = await this.db.prepare(`SELECT id FROM inknote_notebooks WHERE user_id = ?1 AND id = ?2`).bind(this.userId, input.notebookId).first()
    if (!notebook) throw ApiError.notFound('Notebook not found')
    const id = input.id ?? newId()
    const owner = await ownerOf(this.db, 'inknote_notes', id)
    if (owner && owner !== this.userId) throw ApiError.conflict('That note id is already in use')
    if (owner === this.userId) {
      const existing = await this.getNoteWithPages(id, 'all')
      if (existing) return { ...existing, created: false }
    }
    if (await this.noteCount() >= INKNOTE_LIMITS.notesPerUser) throw ApiError.badRequest('Too many notes')
    const titleInput = (input.title ?? '').trim()
    if (Array.from(titleInput).length > INKNOTE_LIMITS.titleMaxLength) throw ApiError.badRequest('The note title is too long')
    const pageId = newId()
    const now = Date.now()
    const width = Math.round(Math.min(INKNOTE_PAGE_SIZE_LIMITS.maxWidth, Math.max(INKNOTE_PAGE_SIZE_LIMITS.minWidth, input.pageWidth ?? INKNOTE_PAGE_WIDTH)))
    const height = Math.round(Math.min(INKNOTE_PAGE_SIZE_LIMITS.maxHeight, Math.max(INKNOTE_PAGE_SIZE_LIMITS.minHeight, input.pageHeight ?? INKNOTE_PAGE_HEIGHT)))
    const paper = input.paper && typeof input.paper === 'object' ? sanitizePaperInput(input.paper) : { style: 'line', color: 'white', spacing: 'normal' }
    const title = titleInput || defaultTitle(now)
    const content = emptyPageContent()
    const serialized = serializePageContent(content)
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO inknote_notes
         (user_id, id, notebook_id, title, title_key, paper_style, paper_color, paper_spacing,
          page_width, page_height, content_width, content_height, color_tag, pinned, page_count, content_bytes, cover_asset_id, rev, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?9, ?10, NULL, 0, 1, 0, NULL, 1, ?11, ?11, NULL)`,
      ).bind(this.userId, id, input.notebookId, title, title.toLowerCase(), paper.style, paper.color, paper.spacing, width, height, now),
      this.db.prepare(
        `INSERT INTO inknote_pages (user_id, id, note_id, position, content, search_text, rev, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, ?4, '', 1, ?5, ?5)`,
      ).bind(this.userId, pageId, id, serialized, now),
    ])
    const row = await this.db.prepare(`SELECT ${NOTE_COLUMNS} FROM inknote_notes WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id).first<Row>()
    return { note: toNoteMeta(row!), pages: [{ id: pageId, position: 0, content, rev: 1, updatedAt: now }], created: true }
  }


  async updateNote(id: string, patch: { title?: string; notebookId?: string; paper?: unknown; pageWidth?: number; pageHeight?: number; colorTag?: string | null; pinned?: boolean; baseRev?: number }): Promise<InknoteNoteMeta> {
    const current = await this.db.prepare(`SELECT ${NOTE_COLUMNS} FROM inknote_notes WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`).bind(this.userId, id).first<Row>()
    if (!current) throw ApiError.notFound('Note not found')
    if (patch.baseRev !== undefined && number(current, 'rev') !== patch.baseRev) throw ApiError.conflict('The note changed elsewhere')
    if (patch.notebookId !== undefined) {
      const target = await this.db.prepare(`SELECT id FROM inknote_notebooks WHERE user_id = ?1 AND id = ?2`).bind(this.userId, patch.notebookId).first()
      if (!target) throw ApiError.notFound('Notebook not found')
    }
    const sets: string[] = []
    const values: unknown[] = []
    if (patch.title !== undefined) {
      const title = patch.title.trim().slice(0, INKNOTE_LIMITS.titleMaxLength)
      if (!title) throw ApiError.badRequest('A note needs a title')
      sets.push('title = ?', 'title_key = ?'); values.push(title, title.toLowerCase())
    }
    if (patch.notebookId !== undefined) { sets.push('notebook_id = ?'); values.push(patch.notebookId) }
    if (patch.paper !== undefined) {
      const paper = sanitizePaperInput(patch.paper)
      sets.push('paper_style = ?', 'paper_color = ?', 'paper_spacing = ?'); values.push(paper.style, paper.color, paper.spacing)
    }
    if (patch.pageWidth !== undefined) { sets.push('page_width = ?'); values.push(Math.round(Math.min(4000, Math.max(200, patch.pageWidth)))) }
    if (patch.pageHeight !== undefined) { sets.push('page_height = ?'); values.push(Math.round(Math.min(4000, Math.max(200, patch.pageHeight)))) }
    if (patch.colorTag !== undefined) { sets.push('color_tag = ?'); values.push(patch.colorTag) }
    if (patch.pinned !== undefined) { sets.push('pinned = ?'); values.push(patch.pinned ? 1 : 0) }
    if (!sets.length) return toNoteMeta(current)
    sets.push('rev = rev + 1', 'updated_at = ?'); values.push(Date.now(), this.userId, id)
    const result = await this.db.prepare(`UPDATE inknote_notes SET ${sets.join(', ')} WHERE user_id = ? AND id = ? AND deleted_at IS NULL`).bind(...values).run()
    if (!result.meta.changes) throw ApiError.conflict('The note changed elsewhere')
    const row = await this.db.prepare(`SELECT ${NOTE_COLUMNS} FROM inknote_notes WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id).first<Row>()
    return toNoteMeta(row!)
  }

  async trashNote(id: string): Promise<number> {
    const now = Date.now()
    const result = await this.db.prepare(`UPDATE inknote_notes SET deleted_at = ?3, updated_at = ?3 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`).bind(this.userId, id, now).run()
    if (!result.meta.changes) throw ApiError.notFound('Note not found')
    return now
  }

  async restoreNote(id: string): Promise<InknoteNoteMeta> {
    const row = await this.db.prepare(`SELECT ${NOTE_COLUMNS} FROM inknote_notes WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NOT NULL`).bind(this.userId, id).first<Row>()
    if (!row) throw ApiError.notFound('Note not found')
    let notebookId = text(row, 'notebook_id')
    const parent = await this.db.prepare(`SELECT id FROM inknote_notebooks WHERE user_id = ?1 AND id = ?2`).bind(this.userId, notebookId).first()
    if (!parent) {
      const subject = await this.db.prepare(`SELECT id FROM inknote_subjects WHERE user_id = ?1 ORDER BY position, id LIMIT 1`).bind(this.userId).first<{ id: string }>()
      if (!subject) throw ApiError.badRequest('No project to restore into')
      const created = await this.createNotebook({ subjectId: subject.id, name: 'Recovered notebook' })
      notebookId = created.notebook.id
    }
    await this.db.prepare(`UPDATE inknote_notes SET deleted_at = NULL, notebook_id = ?3, updated_at = ?4, rev = rev + 1 WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id, notebookId, Date.now()).run()
    const restored = await this.db.prepare(`SELECT ${NOTE_COLUMNS} FROM inknote_notes WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id).first<Row>()
    return toNoteMeta(restored!)
  }

  async purgeNote(id: string): Promise<void> {
    const note = await this.db.prepare(`SELECT id FROM inknote_notes WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id).first()
    if (!note) throw ApiError.notFound('Note not found')
    await this.db.batch([
      this.db.prepare(`DELETE FROM inknote_pages WHERE user_id = ?1 AND note_id = ?2`).bind(this.userId, id),
      this.db.prepare(`DELETE FROM inknote_recordings WHERE user_id = ?1 AND note_id = ?2`).bind(this.userId, id),
      this.db.prepare(`DELETE FROM inknote_notes WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id),
    ])
  }

  async deleteNote(id: string): Promise<{ deletedAt: number }> {
    const note = await this.db.prepare(`SELECT id, deleted_at FROM inknote_notes WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id).first<Row>()
    if (!note) throw ApiError.notFound('Note not found')
    if (typeof note.deleted_at === 'number') return { deletedAt: note.deleted_at }
    const deletedAt = Date.now()
    await this.db.prepare(`UPDATE inknote_notes SET deleted_at = ?3, updated_at = ?3 WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id, deletedAt).run()
    return { deletedAt }
  }


  async duplicateNote(id: string, requestedTitle?: string): Promise<{ note: InknoteNoteMeta; pages: InknotePageDto[] }> {
    const source = await this.getNoteWithPages(id, 'all')
    if (!source) throw ApiError.notFound('Note not found')
    if (await this.noteCount() >= INKNOTE_LIMITS.notesPerUser) throw ApiError.badRequest('Too many notes')
    const newNoteId = newId()
    const now = Date.now()
    const title = (requestedTitle?.trim() || `${source.note.title} copy`).slice(0, INKNOTE_LIMITS.titleMaxLength)
    const cloned = source.pages.map((page) => {
      const content = clonePageContent(page.content)
      return { id: newId(), content, serialized: serializePageContent(content), text: extractPageText(content) }
    })
    const bytes = cloned.reduce((sum, page) => sum + utf8Bytes(page.serialized), 0)
    if (bytes > INKNOTE_LIMITS.noteContentMaxBytes) throw ApiError.tooLarge('The note is too large to duplicate')
    const statements = [
      this.db.prepare(
        `INSERT INTO inknote_notes
         (user_id, id, notebook_id, title, title_key, paper_style, paper_color, paper_spacing,
          page_width, page_height, content_width, content_height, color_tag, pinned, page_count, content_bytes, cover_asset_id, rev, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14, ?15, NULL, 1, ?16, ?16, NULL)`,
      ).bind(
        this.userId, newNoteId, source.note.notebookId, title, title.toLowerCase(),
        source.note.paper.style, source.note.paper.color, source.note.paper.spacing,
        source.note.pageWidth, source.note.pageHeight, source.note.contentWidth, source.note.contentHeight,
        source.note.colorTag, cloned.length, bytes, now,
      ),
      ...cloned.map((page, position) => this.db.prepare(
        `INSERT INTO inknote_pages (user_id, id, note_id, position, content, search_text, rev, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)`,
      ).bind(this.userId, page.id, newNoteId, position, page.serialized, page.text, now)),
    ]
    await this.db.batch(statements)
    const row = await this.db.prepare(`SELECT ${NOTE_COLUMNS} FROM inknote_notes WHERE user_id = ?1 AND id = ?2`).bind(this.userId, newNoteId).first<Row>()
    return {
      note: toNoteMeta(row!),
      pages: cloned.map((page, position) => ({ id: page.id, position, content: page.content, rev: 1, updatedAt: now })),
    }
  }


  async createPage(noteId: string, input: { id?: string; afterPageId?: string; content?: string } = {}): Promise<{ page: InknotePageDto; created: boolean }> {
    const note = await this.db.prepare(`SELECT page_count, content_bytes FROM inknote_notes WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`).bind(this.userId, noteId).first<Row>()
    if (!note) throw ApiError.notFound('Note not found')
    const id = input.id ?? newId()
    const owner = await ownerOf(this.db, 'inknote_pages', id)
    if (owner && owner !== this.userId) throw ApiError.conflict('That page id is already in use')
    if (owner === this.userId) {
      const existing = await this.db.prepare(`SELECT id, position, content, rev, updated_at FROM inknote_pages WHERE user_id = ?1 AND note_id = ?2 AND id = ?3`).bind(this.userId, noteId, id).first<Row>()
      if (existing) {
        const parsedExisting = parseInknotePageContent(text(existing, 'content'))
        return { page: { id, position: number(existing, 'position'), content: parsedExisting.ok ? parsedExisting.content : emptyPageContent(), rev: number(existing, 'rev'), updatedAt: number(existing, 'updated_at') }, created: false }
      }
    }
    if (number(note, 'page_count') >= INKNOTE_LIMITS.pagesPerNote) throw ApiError.badRequest('This note has reached its page limit')
    const content = input.content === undefined ? emptyPageContent() : (() => {
      const parsed = parseInknotePageContent(input.content)
      if (!parsed.ok) throw ApiError.badRequest('The page content is invalid')
      return parsed.content
    })()
    const serialized = serializePageContent(content)
    const bytes = utf8Bytes(serialized)
    if (number(note, 'content_bytes') + bytes > INKNOTE_LIMITS.noteContentMaxBytes) throw ApiError.tooLarge('This note has reached its content limit')
    let position = number(note, 'page_count')
    if (input.afterPageId) {
      const after = await this.db.prepare(`SELECT position FROM inknote_pages WHERE user_id = ?1 AND note_id = ?2 AND id = ?3`).bind(this.userId, noteId, input.afterPageId).first<{ position: number }>()
      if (!after) throw ApiError.badRequest('afterPageId is not a page of this note')
      position = after.position + 1
    }
    const now = Date.now()
    await this.db.batch([
      this.db.prepare(`UPDATE inknote_pages SET position = position + 1 WHERE user_id = ?1 AND note_id = ?2 AND position >= ?3`).bind(this.userId, noteId, position),
      this.db.prepare(`INSERT INTO inknote_pages (user_id, id, note_id, position, content, search_text, rev, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)`).bind(this.userId, id, noteId, position, serialized, extractPageText(content), now),
      this.db.prepare(`UPDATE inknote_notes SET page_count = page_count + 1, content_bytes = content_bytes + ?3, updated_at = ?4 WHERE user_id = ?1 AND id = ?2`).bind(this.userId, noteId, bytes, now),
    ])
    return { page: { id, position, content, rev: 1, updatedAt: now }, created: true }
  }


  async savePageContent(noteId: string, pageId: string, raw: string, baseRev: number): Promise<{ rev: number; updatedAt: number; searchText: string }> {
    const parsed = sanitizePageForSave(raw)
    if (!parsed.ok) {
      if (parsed.reason === 'too_large') throw ApiError.tooLarge('This page is too large')
      throw ApiError.badRequest('The page content is invalid')
    }
    const page = await this.db.prepare(`SELECT id, content FROM inknote_pages WHERE user_id = ?1 AND note_id = ?2 AND id = ?3`).bind(this.userId, noteId, pageId).first<{ id: string, content: string }>()
    if (!page) throw ApiError.notFound('Page not found')
    const note = await this.db.prepare(`SELECT content_bytes FROM inknote_notes WHERE user_id = ?1 AND id = ?2`).bind(this.userId, noteId).first<{ content_bytes: number }>()
    if (!note) throw ApiError.notFound('Note not found')
    if (parsed.result.assetIds.length) {
      const found = new Set<string>()
      for (let index = 0; index < parsed.result.assetIds.length; index += 80) {
        const chunk = parsed.result.assetIds.slice(index, index + 80)
        const placeholders = chunk.map((_, offset) => `?${offset + 2}`).join(', ')
        const { results } = await this.db.prepare(`SELECT id FROM inknote_assets WHERE user_id = ?1 AND id IN (${placeholders})`).bind(this.userId, ...chunk).all<{ id: string }>()
        for (const row of results) found.add(row.id)
      }
      if (found.size !== parsed.result.assetIds.length) throw ApiError.badRequest('A page references an unknown asset')
    }
    const release = await acquireLease(this.db, `inknote-save:${this.userId}:${noteId}`, 2 * 60 * 1000, 'This note is being saved elsewhere. Try again.')
    try {
      const currentRev = await this.db.prepare(`SELECT rev FROM inknote_pages WHERE user_id = ?1 AND note_id = ?2 AND id = ?3`).bind(this.userId, noteId, pageId).first<{ rev: number }>()
      if (!currentRev || currentRev.rev !== baseRev) {
        const current = await this.db.prepare(`SELECT content, rev, updated_at FROM inknote_pages WHERE user_id = ?1 AND note_id = ?2 AND id = ?3`).bind(this.userId, noteId, pageId).first<Row>()
        throw ApiError.conflict('The page changed elsewhere', { current: current ? { content: text(current, 'content'), rev: number(current, 'rev'), updatedAt: number(current, 'updated_at') } : null })
      }
      const total = Number((await this.db.prepare(`SELECT COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS bytes FROM inknote_pages WHERE user_id = ?1 AND note_id = ?2`).bind(this.userId, noteId).first<{ bytes: number }>())?.bytes ?? 0)
      const oldBytes = utf8Bytes(page.content)
      const nextBytes = parsed.result.bytes
      if (total - oldBytes + nextBytes > INKNOTE_LIMITS.noteContentMaxBytes) throw ApiError.tooLarge('This note has reached its content limit')
      const serialized = serializePageContent(parsed.result.content)
      const searchText = extractPageText(parsed.result.content)
      const now = Date.now()
      const updated = await this.db.batch([
        this.db.prepare(`UPDATE inknote_pages SET content = ?4, search_text = ?5, rev = rev + 1, updated_at = ?6 WHERE user_id = ?1 AND note_id = ?2 AND id = ?3 AND rev = ?7`).bind(this.userId, noteId, pageId, serialized, searchText, now, baseRev),
        this.db.prepare(`UPDATE inknote_notes SET content_bytes = content_bytes + ?3, updated_at = ?4 WHERE user_id = ?1 AND id = ?2`).bind(this.userId, noteId, nextBytes - oldBytes, now),
      ])
      if (!updated[0]?.meta.changes) {
        const current = await this.db.prepare(`SELECT content, rev, updated_at FROM inknote_pages WHERE user_id = ?1 AND note_id = ?2 AND id = ?3`).bind(this.userId, noteId, pageId).first<Row>()
        throw ApiError.conflict('The page changed elsewhere', { current: current ? { content: text(current, 'content'), rev: number(current, 'rev'), updatedAt: number(current, 'updated_at') } : null })
      }
      return { rev: baseRev + 1, updatedAt: now, searchText }
    } finally {
      await release()
    }
  }


  async duplicatePage(noteId: string, pageId: string): Promise<InknotePage> {
    const source = await this.db.prepare(`SELECT id, position, content, rev FROM inknote_pages WHERE user_id = ?1 AND note_id = ?2 AND id = ?3`).bind(this.userId, noteId, pageId).first<Row>()
    if (!source) throw ApiError.notFound('Page not found')
    const parsed = parseInknotePageContent(text(source, 'content'))
    if (!parsed.ok) throw ApiError.badRequest('The page is damaged')
    const clone = clonePageContent(parsed.content)
    const serialized = serializePageContent(clone)
    const bytes = utf8Bytes(serialized)
    const note = await this.db.prepare(`SELECT page_count, content_bytes FROM inknote_notes WHERE user_id = ?1 AND id = ?2`).bind(this.userId, noteId).first<Row>()
    if (!note || number(note, 'page_count') >= INKNOTE_LIMITS.pagesPerNote) throw ApiError.badRequest('This note has reached its page limit')
    if (number(note, 'content_bytes') + bytes > INKNOTE_LIMITS.noteContentMaxBytes) throw ApiError.tooLarge('This note has reached its content limit')
    const id = newId()
    const now = Date.now()
    const position = number(source, 'position') + 1
    await this.db.batch([
      this.db.prepare(`UPDATE inknote_pages SET position = position + 1 WHERE user_id = ?1 AND note_id = ?2 AND position >= ?3`).bind(this.userId, noteId, position),
      this.db.prepare(`INSERT INTO inknote_pages (user_id, id, note_id, position, content, search_text, rev, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)`).bind(this.userId, id, noteId, position, serialized, extractPageText(clone), now),
      this.db.prepare(`UPDATE inknote_notes SET page_count = page_count + 1, content_bytes = content_bytes + ?3, updated_at = ?4 WHERE user_id = ?1 AND id = ?2`).bind(this.userId, noteId, bytes, now),
    ])
    return { id, position, content: clone, rev: 1, updatedAt: now }
  }

  async deletePage(noteId: string, pageId: string): Promise<{ deleted: true }> {
    const note = await this.db.prepare(`SELECT page_count FROM inknote_notes WHERE user_id = ?1 AND id = ?2`).bind(this.userId, noteId).first<Row>()
    if (!note) throw ApiError.notFound('Note not found')
    if (number(note, 'page_count') <= 1) throw ApiError.badRequest('A note needs at least one page')
    const page = await this.db.prepare(`SELECT position, content FROM inknote_pages WHERE user_id = ?1 AND note_id = ?2 AND id = ?3`).bind(this.userId, noteId, pageId).first<Row>()
    if (!page) throw ApiError.notFound('Page not found')
    const bytes = utf8Bytes(text(page, 'content'))
    await this.db.batch([
      this.db.prepare(`DELETE FROM inknote_pages WHERE user_id = ?1 AND note_id = ?2 AND id = ?3`).bind(this.userId, noteId, pageId),
      this.db.prepare(`UPDATE inknote_pages SET position = position - 1 WHERE user_id = ?1 AND note_id = ?2 AND position > ?3`).bind(this.userId, noteId, number(page, 'position')),
      this.db.prepare(`UPDATE inknote_notes SET page_count = page_count - 1, content_bytes = MAX(0, content_bytes - ?3), updated_at = ?4 WHERE user_id = ?1 AND id = ?2`).bind(this.userId, noteId, bytes, Date.now()),
    ])
    return { deleted: true }
  }


  async reorderPages(noteId: string, pageIds: string[]): Promise<{ pageIds: string[] }> {
    if (!pageIds.length) throw ApiError.badRequest('No pages supplied')
    const note = await this.db.prepare(`SELECT id FROM inknote_notes WHERE user_id = ?1 AND id = ?2`).bind(this.userId, noteId).first()
    if (!note) throw ApiError.notFound('Note not found')
    const { results } = await this.db.prepare(`SELECT id FROM inknote_pages WHERE user_id = ?1 AND note_id = ?2`).bind(this.userId, noteId).all<{ id: string }>()
    const existing = new Set(results.map((row) => row.id))
    if (existing.size !== pageIds.length || pageIds.some((id) => !existing.has(id)) || new Set(pageIds).size !== pageIds.length) {
      throw ApiError.badRequest('The page list does not match this note')
    }
    const payload = JSON.stringify(pageIds)
    await this.db.prepare(
      `UPDATE inknote_pages SET position = (SELECT CAST(key AS INTEGER) FROM json_each(?1) WHERE json_each.value = inknote_pages.id)
        WHERE user_id = ?2 AND note_id = ?3 AND id IN (SELECT value FROM json_each(?1))`,
    ).bind(payload, this.userId, noteId).run()
    await this.db.prepare(`UPDATE inknote_notes SET updated_at = ?3 WHERE user_id = ?1 AND id = ?2`).bind(this.userId, noteId, Date.now()).run()
    return { pageIds }
  }


  async copyPage(targetNoteId: string, sourceNoteId: string, pageId: string): Promise<InknotePage> {
    const source = await this.db.prepare(`SELECT content FROM inknote_pages WHERE user_id = ?1 AND note_id = ?2 AND id = ?3`).bind(this.userId, sourceNoteId, pageId).first<{ content: string }>()
    if (!source) throw ApiError.notFound('Page not found')
    const parsed = parseInknotePageContent(source.content)
    if (!parsed.ok) throw ApiError.badRequest('The page is damaged')
    const target = await this.db.prepare(`SELECT page_count, content_bytes FROM inknote_notes WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`).bind(this.userId, targetNoteId).first<Row>()
    if (!target) throw ApiError.notFound('Target note not found')
    if (number(target, 'page_count') >= INKNOTE_LIMITS.pagesPerNote) throw ApiError.badRequest('The target note has reached its page limit')
    const clone = clonePageContent(parsed.content)
    const serialized = serializePageContent(clone)
    const bytes = utf8Bytes(serialized)
    if (number(target, 'content_bytes') + bytes > INKNOTE_LIMITS.noteContentMaxBytes) throw ApiError.tooLarge('The target note has reached its content limit')
    const id = newId()
    const now = Date.now()
    const position = number(target, 'page_count')
    await this.db.batch([
      this.db.prepare(`INSERT INTO inknote_pages (user_id, id, note_id, position, content, search_text, rev, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)`).bind(this.userId, id, targetNoteId, position, serialized, extractPageText(clone), now),
      this.db.prepare(`UPDATE inknote_notes SET page_count = page_count + 1, content_bytes = content_bytes + ?3, updated_at = ?4 WHERE user_id = ?1 AND id = ?2`).bind(this.userId, targetNoteId, bytes, now),
    ])
    return { id, position, content: clone, rev: 1, updatedAt: now }
  }


  async search(query: string, notebookId?: string, limit = 50): Promise<{ results: import('@shared/inknote/types').InknoteSearchResult[]; total: number }> {
    const q = query.trim()
    if (!q) return { results: [], total: 0 }
    const pattern = `%${q.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
    const cap = Math.min(INKNOTE_LIMITS.searchResultsMax, Math.max(1, Math.floor(limit)))
    const notebookClause = notebookId ? ' AND n.notebook_id = ?5' : ''
    const args: unknown[] = notebookId ? [this.userId, pattern, pattern, q.toLowerCase(), notebookId] : [this.userId, pattern, pattern, q.toLowerCase()]
    const { results } = await this.db.prepare(
      `SELECT n.id AS note_id, n.title, n.notebook_id, nb.name AS notebook_name, nb.subject_id, s.name AS subject_name,
              p.position AS page_index, p.search_text
         FROM inknote_notes n
         JOIN inknote_notebooks nb ON nb.user_id = n.user_id AND nb.id = n.notebook_id
         JOIN inknote_subjects s ON s.user_id = nb.user_id AND s.id = nb.subject_id
         LEFT JOIN inknote_pages p ON p.user_id = n.user_id AND p.note_id = n.id
        WHERE n.user_id = ?1 AND n.deleted_at IS NULL
          AND (n.title_key LIKE ?2 ESCAPE '\\' OR p.search_text LIKE ?3 ESCAPE '\\')
          ${notebookClause}
        ORDER BY n.updated_at DESC, n.id, p.position
        LIMIT 400`,
    ).bind(...args).all<Row>()
    const byNote = new Map<string, import('@shared/inknote/types').InknoteSearchResult>()
    for (const row of results) {
      const noteId = text(row, 'note_id')
      if (byNote.has(noteId)) continue
      const body = text(row, 'search_text')
      const titleHit = text(row, 'title').toLowerCase().includes(q.toLowerCase())
      const index = body.toLowerCase().indexOf(q.toLowerCase())
      const snippet = index < 0 ? '' : body.slice(Math.max(0, index - 30), index + q.length + 50).replace(/\s+/g, ' ').trim().slice(0, 160)
      byNote.set(noteId, {
        noteId,
        title: text(row, 'title'),
        notebookId: text(row, 'notebook_id'),
        notebookName: text(row, 'notebook_name'),
        subjectName: text(row, 'subject_name'),
        pageIndex: Math.max(0, number(row, 'page_index')),
        snippet,
        titleMatch: titleHit,
      })
      if (byNote.size >= cap) break
    }
    return { results: [...byNote.values()], total: byNote.size }
  }

  async listTemplates(): Promise<InknoteTemplate[]> {
    const { results } = await this.db.prepare(`SELECT id, name, paper_style, paper_color, paper_spacing, bg_asset_id, texts, title, sub, title_size, sub_size, created_at FROM inknote_templates WHERE user_id = ?1 ORDER BY created_at, id`).bind(this.userId).all<Row>()
    return results.map(toTemplate)
  }

  async createTemplate(input: { id?: string; name: string; paper: unknown; bgAssetId?: string | null; texts?: unknown; title?: string; sub?: string }): Promise<InknoteTemplate> {
    const count = Number((await this.db.prepare(`SELECT COUNT(*) AS n FROM inknote_templates WHERE user_id = ?1`).bind(this.userId).first<{ n: number }>())?.n ?? 0)
    if (count >= INKNOTE_LIMITS.templatesPerUser) throw ApiError.badRequest('Too many templates')
    const paper = sanitizePaperInput(input.paper)
    if (input.bgAssetId) await this.assertAsset(input.bgAssetId)
    const id = input.id ?? newId()
    const now = Date.now()
    const name = input.name.trim().slice(0, INKNOTE_LIMITS.nameMaxLength) || 'Template'
    const texts = Array.isArray(input.texts) ? JSON.stringify(input.texts).slice(0, 500_000) : '[]'
    await this.db.prepare(
      `INSERT INTO inknote_templates (user_id, id, name, paper_style, paper_color, paper_spacing, bg_asset_id, texts, title, sub, title_size, sub_size, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 32, 15, ?11, ?11)`,
    ).bind(this.userId, id, name, paper.style, paper.color, paper.spacing, input.bgAssetId ?? null, texts, (input.title ?? '').slice(0, 512), (input.sub ?? '').slice(0, 512), now).run()
    const row = await this.db.prepare(`SELECT id, name, paper_style, paper_color, paper_spacing, bg_asset_id, texts, title, sub, title_size, sub_size, created_at FROM inknote_templates WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id).first<Row>()
    return toTemplate(row!)
  }

  async updateTemplate(id: string, patch: { name?: string }): Promise<void> {
    const name = (patch.name ?? '').trim().slice(0, INKNOTE_LIMITS.nameMaxLength)
    if (!name) throw ApiError.badRequest('A template needs a name')
    const result = await this.db.prepare(`UPDATE inknote_templates SET name = ?3, updated_at = ?4 WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id, name, Date.now()).run()
    if (!result.meta.changes) throw ApiError.notFound('Template not found')
  }

  async deleteTemplate(id: string): Promise<void> {
    const result = await this.db.prepare(`DELETE FROM inknote_templates WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id).run()
    if (!result.meta.changes) throw ApiError.notFound('Template not found')
  }

  async assertAsset(id: string): Promise<void> {
    const asset = await this.db.prepare(`SELECT id FROM inknote_assets WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id).first()
    if (!asset) throw ApiError.badRequest('Unknown asset')
  }

}

function sanitizePaperInput(raw: unknown): InknotePaper {
  const row = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Row : {}
  const styleRaw = typeof row.style === 'string' ? row.style : 'line'
  const style = PAPER_STYLES.some((entry) => entry.id === styleRaw) ? styleRaw as InknotePaper['style'] : 'line'
  const color = normalizePaperColor(row.color) ?? 'white'
  const spacingRaw = typeof row.spacing === 'string' ? row.spacing : 'normal'
  const spacing = spacingRaw === 'tight' || spacingRaw === 'wide' ? spacingRaw : 'normal'
  return { style, color, spacing }
}

function defaultTitle(now: number): string {
  const date = new Date(now)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function clonePageContent(content: InknotePageContent): InknotePageContent {
  return {
    format: content.format,
    version: content.version,
    strokes: content.strokes.map((stroke) => ({ ...stroke, id: newId(), points: stroke.points.map((point) => ({ ...point })) })),
    texts: content.texts.map((text) => ({ ...text, id: newId() })),
    images: content.images.map((image) => ({ ...image, id: newId() })),
    bg: content.bg ? { ...content.bg } : null,
  }
}


async function ownerOf(db: D1Database, table: 'inknote_subjects' | 'inknote_notebooks' | 'inknote_notes' | 'inknote_pages', id: string): Promise<string | null> {
  const row = await db.prepare(`SELECT user_id FROM ${table} WHERE id = ?1 LIMIT 1`).bind(id).first<{ user_id: string }>()
  return row?.user_id ?? null
}
