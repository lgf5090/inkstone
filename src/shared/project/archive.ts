/**
 * The archive envelope, shared by the exporter, the importer and the six external converters.
 *
 * A v2 archive is a ZIP holding `version.json`, one `<boardId>/board.jsonl` per board, and the boards'
 * binaries beside it. This module owns the JSONL only — the ZIP is the server's business — so a
 * converter running in the browser can produce exactly what the server reads without either side
 * knowing about the other's transport.
 */
import { z } from 'zod'

export const PROJECT_ARCHIVE_VERSION = 3

/**
 * The reference's writer emits three line kinds and its reader accepts four: `board_block` is an
 * older spelling of `block` that still appears in archives people have on disk. `cardLink` is this
 * port's addition: the reference never wrote dependency edges, so a v3 archive carries them on a line
 * of their own instead of pretending they are content blocks.
 */
export const PROJECT_ARCHIVE_LINE_TYPES = ['board', 'block', 'board_block', 'boardMember', 'cardLink', 'attachment'] as const
export type ProjectArchiveLineType = (typeof PROJECT_ARCHIVE_LINE_TYPES)[number]

export const ProjectArchiveHeaderSchema = z.object({
  version: z.number().int().min(1).max(PROJECT_ARCHIVE_VERSION),
  date: z.number().int().nonnegative(),
})
export type ProjectArchiveHeader = z.infer<typeof ProjectArchiveHeaderSchema>

/**
 * A block as the reference wrote it. Deliberately loose: the importer's job is to map these onto
 * boards, cards, views and contents, and a field this port does not use must not fail the import.
 */
export const ProjectArchiveBlockSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  parentId: z.string().default(''),
  boardId: z.string().default(''),
  title: z.string().default(''),
  fields: z.record(z.string(), z.unknown()).default({}),
  createdBy: z.string().default(''),
  modifiedBy: z.string().default(''),
  createAt: z.number().int().default(0),
  updateAt: z.number().int().default(0),
  deleteAt: z.number().int().default(0),
})
export type ProjectArchiveBlock = z.infer<typeof ProjectArchiveBlockSchema>

export const ProjectArchiveMemberSchema = z.object({
  boardId: z.string().min(1),
  userId: z.string().min(1),
  role: z.string().default(''),
})
export type ProjectArchiveMember = z.infer<typeof ProjectArchiveMemberSchema>

export const ProjectArchiveCardLinkSchema = z.object({
  fromCardId: z.string().min(1),
  toCardId: z.string().min(1),
  kind: z.enum(['blocks', 'parent']),
})
export type ProjectArchiveCardLink = z.infer<typeof ProjectArchiveCardLinkSchema>

/**
 * A file the ZIP carries beside the JSONL. `path` is archive-relative and is checked by the importer
 * against the board directory, so an uploaded archive cannot point a row at an arbitrary entry.
 */
export const ProjectArchiveAttachmentSchema = z.object({
  id: z.string().min(1),
  cardId: z.string().default(''),
  filename: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  storage: z.enum(['r2', 'kv']).default('r2'),
  width: z.number().int().nullable().default(null),
  height: z.number().int().nullable().default(null),
  path: z.string().min(1),
})
export type ProjectArchiveAttachment = z.infer<typeof ProjectArchiveAttachmentSchema>

export type ProjectArchiveLine =
  | { type: 'board'; data: Record<string, unknown> }
  | { type: 'block'; data: ProjectArchiveBlock }
  | { type: 'boardMember'; data: ProjectArchiveMember }
  | { type: 'cardLink'; data: ProjectArchiveCardLink }
  | { type: 'attachment'; data: ProjectArchiveAttachment }

export class ProjectArchiveError extends Error {
  constructor(message: string, readonly line: number) {
    super(message)
    this.name = 'ProjectArchiveError'
  }
}

/**
 * Read one `board.jsonl`.
 *
 * The board itself arrives two ways. A current export writes it as a `board` line; the reference's own
 * built-in templates predate that and carry it as a `block` line whose `data.type` is `board` and
 * whose parent is empty. Dispatching on the outer type alone reads none of those seven templates.
 */
export function parseProjectArchiveLines(text: string): ProjectArchiveLine[] {
  const out: ProjectArchiveLine[] = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!.trim()
    if (!raw) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new ProjectArchiveError('archive line is not JSON', index + 1)
    }
    const envelope = z.object({ type: z.string(), data: z.unknown() }).safeParse(parsed)
    if (!envelope.success) throw new ProjectArchiveError('archive line has no type and data', index + 1)
    const { type, data } = envelope.data
    if (type === 'board') {
      if (typeof data !== 'object' || data === null) throw new ProjectArchiveError('board line has no object', index + 1)
      out.push({ type: 'board', data: data as Record<string, unknown> })
    } else if (type === 'block' || type === 'board_block') {
      const block = ProjectArchiveBlockSchema.safeParse(data)
      if (!block.success) throw new ProjectArchiveError('block line is not a block', index + 1)
      out.push({ type: 'block', data: block.data })
    } else if (type === 'boardMember') {
      const member = ProjectArchiveMemberSchema.safeParse(data)
      if (!member.success) throw new ProjectArchiveError('member line is not a member', index + 1)
      out.push({ type: 'boardMember', data: member.data })
    } else if (type === 'cardLink') {
      const link = ProjectArchiveCardLinkSchema.safeParse(data)
      if (!link.success) throw new ProjectArchiveError('cardLink line is not a link', index + 1)
      out.push({ type: 'cardLink', data: link.data })
    } else if (type === 'attachment') {
      const attachment = ProjectArchiveAttachmentSchema.safeParse(data)
      if (!attachment.success) throw new ProjectArchiveError('attachment line is not a file', index + 1)
      out.push({ type: 'attachment', data: attachment.data })
    } else {
      throw new ProjectArchiveError(`unsupported archive line type: ${type}`, index + 1)
    }
  }
  return out
}

/** The board hidden in a legacy `block` line, or null when the block is an ordinary child. */
export function projectArchiveBlockIsBoard(block: ProjectArchiveBlock): boolean {
  return block.type === 'board' && block.parentId === ''
}

export function serializeProjectArchiveLines(lines: readonly ProjectArchiveLine[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
}