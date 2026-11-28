import type { ProjectCard, ProjectGuestOpenResponse, ProjectProperty } from '@shared/project/model'
import { PROJECT_INTAKE_PROPERTY_TYPES } from '@shared/project/model'
import { sha256Hex } from '../lib/encoding'
import { getProjectCard } from './cards'
import { readBoardProperties } from './boards'
import { assertPublicIntakeValues } from './intake'

const GUEST_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000

interface IntakeGrantRow {
  card_id: string
  board_id: string
  share_slug: string
  token_hash: string
  field_ids: string
  expires_at: number
  revoked_at: number | null
  created_at: number
}

function newGuestToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export async function createProjectIntakeGrant(
  db: D1Database,
  input: { cardId: string, boardId: string, shareSlug: string, fieldIds: readonly string[], expiresAt: number | null, now: number },
): Promise<string> {
  const token = newGuestToken()
  const expiresAt = Math.min(input.now + GUEST_GRANT_TTL_MS, input.expiresAt ?? Number.MAX_SAFE_INTEGER)
  await db.prepare(
    `INSERT INTO project_intake_grants (card_id, board_id, share_slug, token_hash, field_ids, expires_at, revoked_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)`,
  ).bind(input.cardId, input.boardId, input.shareSlug, await sha256Hex(token), JSON.stringify([...new Set(input.fieldIds)]), expiresAt, input.now).run()
  return token
}

export async function readProjectIntakeGrant(
  db: D1Database,
  shareSlug: string,
  cardId: string,
  token: string,
  now: number,
): Promise<{ card: ProjectCard, fieldIds: string[] } | null> {
  const tokenHash = await sha256Hex(token)
  const row = await db.prepare(
    `SELECT * FROM project_intake_grants
     WHERE share_slug = ?1 AND card_id = ?2 AND token_hash = ?3 AND revoked_at IS NULL AND expires_at > ?4`,
  ).bind(shareSlug, cardId, tokenHash, now).first<IntakeGrantRow>()
  if (!row) return null
  const card = await getProjectCard(db, cardId)
  if (!card || card.boardId !== row.board_id || card.deleteAt !== 0) return null
  const fieldIds = JSON.parse(row.field_ids) as unknown
  if (!Array.isArray(fieldIds) || fieldIds.some((id) => typeof id !== 'string')) throw new Error('Invalid intake grant fields')
  return { card, fieldIds }
}

export async function openProjectGuestCard(
  db: D1Database,
  boardId: string,
  card: ProjectCard,
  fieldIds: readonly string[],
): Promise<ProjectGuestOpenResponse> {
  const properties = await readBoardProperties(db, boardId)
  const allowed = new Set(fieldIds)
  const values = Object.fromEntries(Object.entries(card.values).filter(([propertyId]) => allowed.has(propertyId)))
  return {
    card: { id: card.id, title: card.title, values, updateAt: card.updateAt },
    properties: properties.filter((property) => allowed.has(property.id) && PROJECT_INTAKE_PROPERTY_TYPES.includes(property.type)),
  }
}

export async function assertProjectGuestValues(
  db: D1Database,
  boardId: string,
  properties: readonly ProjectProperty[],
  fieldIds: readonly string[],
  values: Record<string, string>,
): Promise<void> {
  await assertPublicIntakeValues(db, boardId, properties, {
    enabled: true,
    editable: true,
    title: '',
    propertyIds: [...fieldIds],
    requiredPropertyIds: [],
  }, values)
}
