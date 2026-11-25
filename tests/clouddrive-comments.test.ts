// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { CLOUDDRIVE_REQUIRED_INDEXES, CLOUDDRIVE_REQUIRED_TABLES, CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
import { clouddriveRoutes } from '../src/worker/clouddrive/routes'
import { errorResponse } from '../src/worker/lib/errors'
import { newId } from '../src/worker/lib/id'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { createLoginAttemptsTable } from './doubles/login-attempts'
import { createUsersTable } from './doubles/users-table'
import { testBindings } from './doubles/bindings'

const OWNER = '0123456789abcdefghjkmnpqrs'
const MEMBER = '0123456789abcdefghjkmnpqrt'
const OTHER = '0123456789abcdefghjkmnpqrz'
const USERS = {
  [OWNER]: { username: 'owner', name: 'Owner', role: 'owner' },
  [MEMBER]: { username: 'member', name: 'Member', role: 'member' },
  [OTHER]: { username: 'other', name: 'Other', role: 'owner' },
} as const

let sqlite: DatabaseSync
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of CLOUDDRIVE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  createUsersTable(sqlite)
  createLoginAttemptsTable(sqlite)
  for (const [id, user] of Object.entries(USERS)) {
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
       VALUES (?, ?, 'hash', ?, ?, '', ?, '{}', ?, ?)`,
    ).run(id, user.username, user.username, user.name, user.role, 1, 1)
  }
  env = testBindings(makeD1(sqlite))
})

function appFor(userId: string | null): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((error, c) => errorResponse(c, error))
  app.use('*', async (c, next) => {
    if (userId) {
      const user = USERS[userId as keyof typeof USERS]
      c.set('userId', userId)
      c.set('user', { id: userId, username: user.username, login: user.username, name: user.name, avatarUrl: '', role: user.role, createdAt: 1, settingsRaw: '{}' })
    }
    await next()
  })
  app.route('/api/clouddrive', clouddriveRoutes)
  return app
}

async function call(
  userId: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await appFor(userId).fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

function insertFile(ownerId: string, id: string, path: string, kind: 'file' | 'folder' = 'file'): void {
  const name = path.split('/').at(-1) || 'root'
  sqlite.prepare(
    `INSERT INTO CloudDrive_files
       (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path,
        category, mime, size, etag, checksum, storage_kind, storage_key, metadata, color,
        starred_at, last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
     VALUES (?, ?, 'primary', '', ?, ?, ?, '', ?, 'other', 'text/plain', 1, NULL, NULL,
             'r2', NULL, '{}', '', NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
  ).run(id, ownerId, kind, name, name.toLowerCase(), path, 1, 1, 1, 1)
}

function grant(ownerId: string, fileId: string, granteeId: string): void {
  sqlite.prepare(
    `INSERT INTO CloudDrive_acl (owner_id, file_id, grantee_id, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)`,
  ).run(ownerId, fileId, granteeId, 1)
}

interface CommentBody {
  comments: {
    id: string
    fileId: string
    body: string
    author: { id: string; username: string; name: string }
    mentions: { userId: string; username: string }[]
    canDelete: boolean
    createdAt: number
  }[]
}

describe('CloudDrive file comments', () => {
  it('creates the owner-scoped table and resolves mentions into notification records', async () => {
    expect(CLOUDDRIVE_REQUIRED_TABLES).toContain('CloudDrive_file_comments')
    expect(CLOUDDRIVE_REQUIRED_INDEXES).toContain('idx_clouddrive_file_comments_file')
    const fileId = newId()
    insertFile(OWNER, fileId, '/note.txt')

    const created = await call(OWNER, 'POST', `/api/clouddrive/files/${fileId}/comments?ownerId=${OWNER}`, {
      body: 'Hello @MEMBER and @member; not owner@example.com or @ghost.',
    })
    expect(created.status).toBe(201)
    const createdBody = created.body as {
      comment: CommentBody['comments'][number]
      notifications: { id: string; type: string; recipientId: string; commentId: string; ownerId: string; fileId: string }[]
    }
    expect(createdBody.comment).toMatchObject({
      fileId,
      body: 'Hello @MEMBER and @member; not owner@example.com or @ghost.',
      author: { id: OWNER, username: 'owner', name: 'Owner' },
      mentions: [{ userId: MEMBER, username: 'member' }],
      canDelete: true,
    })
    expect(createdBody.notifications).toEqual([{
      id: `${createdBody.comment.id}:${MEMBER}`,
      type: 'clouddrive_comment_mention',
      recipientId: MEMBER,
      commentId: createdBody.comment.id,
      ownerId: OWNER,
      fileId,
      createdAt: createdBody.comment.createdAt,
    }])

    const listed = await call(OWNER, 'GET', `/api/clouddrive/files/${fileId}/comments?ownerId=${OWNER}`)
    expect(listed.status).toBe(200)
    expect((listed.body as unknown as CommentBody).comments).toHaveLength(1)
    expect((listed.body as unknown as CommentBody).comments[0]?.author.username).toBe('owner')
  })

  it('requires ownership or an active ACL and keeps identical file ids isolated by owner', async () => {
    const fileId = newId()
    insertFile(OWNER, fileId, '/same.txt')
    insertFile(OTHER, fileId, '/same.txt')
    const ownerComment = await call(OWNER, 'POST', `/api/clouddrive/files/${fileId}/comments`, { body: 'owner only' })
    expect(ownerComment.status).toBe(201)

    expect((await call(MEMBER, 'GET', `/api/clouddrive/files/${fileId}/comments?ownerId=${OWNER}`)).status).toBe(404)
    expect((await call(MEMBER, 'POST', `/api/clouddrive/files/${fileId}/comments?ownerId=${OWNER}`, { body: 'denied' })).status).toBe(404)
    expect((await call(OWNER, 'GET', `/api/clouddrive/files/${fileId}/comments?ownerId=${OTHER}`)).status).toBe(404)

    grant(OWNER, fileId, MEMBER)
    const memberComment = await call(MEMBER, 'POST', `/api/clouddrive/files/${fileId}/comments?ownerId=${OWNER}`, { body: 'Hi @owner' })
    expect(memberComment.status).toBe(201)
    const memberCreated = memberComment.body as { comment: CommentBody['comments'][number]; notifications: { recipientId: string }[] }
    expect(memberCreated.comment.author.username).toBe('member')
    expect(memberCreated.notifications.map((item) => item.recipientId)).toEqual([OWNER])

    const listed = await call(MEMBER, 'GET', `/api/clouddrive/files/${fileId}/comments?ownerId=${OWNER}`)
    const comments = (listed.body as unknown as CommentBody).comments
    expect(comments.map((comment) => comment.body)).toEqual(['owner only', 'Hi @owner'])
    expect(comments.map((comment) => comment.canDelete)).toEqual([false, true])

    const ownerCommentId = comments[0]!.id
    const memberCommentId = comments[1]!.id
    expect((await call(MEMBER, 'DELETE', `/api/clouddrive/files/${fileId}/comments/${ownerCommentId}?ownerId=${OWNER}`)).status).toBe(403)
    expect((await call(MEMBER, 'DELETE', `/api/clouddrive/files/${fileId}/comments/${memberCommentId}?ownerId=${OWNER}`)).status).toBe(200)
    expect((await call(OWNER, 'GET', `/api/clouddrive/files/${fileId}/comments?ownerId=${OTHER}`)).status).toBe(404)

    sqlite.prepare('UPDATE CloudDrive_acl SET revoked_at = 2 WHERE owner_id = ? AND file_id = ? AND grantee_id = ?')
      .run(OWNER, fileId, MEMBER)
    expect((await call(MEMBER, 'GET', `/api/clouddrive/files/${fileId}/comments?ownerId=${OWNER}`)).status).toBe(404)
  })

  it('lets the file owner moderate comments and enforces folder grants and passwords', async () => {
    const folderId = newId()
    const fileId = newId()
    insertFile(OWNER, folderId, '/docs', 'folder')
    insertFile(OWNER, fileId, '/docs/note.txt')
    grant(OWNER, folderId, MEMBER)

    const created = await call(MEMBER, 'POST', `/api/clouddrive/files/${fileId}/comments?ownerId=${OWNER}`, { body: 'inside shared folder' })
    expect(created.status).toBe(201)
    const commentId = (created.body as { comment: { id: string } }).comment.id
    expect((await call(OWNER, 'DELETE', `/api/clouddrive/files/${fileId}/comments/${commentId}?ownerId=${OWNER}`)).status).toBe(200)

    expect((await call(OWNER, 'PUT', '/api/clouddrive/meta', {
      mountId: 'primary', path: '/docs', password: 'folder password',
    })).status).toBe(200)
    expect((await call(MEMBER, 'GET', `/api/clouddrive/files/${fileId}/comments?ownerId=${OWNER}`)).status).toBe(403)
    expect((await call(MEMBER, 'POST', `/api/clouddrive/files/${fileId}/comments?ownerId=${OWNER}`, { body: 'locked' })).status).toBe(403)
  })

  it('offers only visible collaborators as mention suggestions', async () => {
    const fileId = newId()
    insertFile(OWNER, fileId, '/people.txt')
    grant(OWNER, fileId, MEMBER)
    const suggestions = await call(MEMBER, 'GET', `/api/clouddrive/files/${fileId}/comments/people?ownerId=${OWNER}&q=own`)
    expect(suggestions.status).toBe(200)
    expect((suggestions.body as { users: { username: string }[] }).users.map((user) => user.username)).toEqual(['owner'])
    expect((await call(OTHER, 'GET', `/api/clouddrive/files/${fileId}/comments/people?ownerId=${OWNER}`)).status).toBe(404)
  })

  it('validates authentication and comment input', async () => {
    const fileId = newId()
    insertFile(OWNER, fileId, '/valid.txt')
    expect((await call(null, 'GET', `/api/clouddrive/files/${fileId}/comments`)).status).toBe(401)
    expect((await call(OWNER, 'POST', `/api/clouddrive/files/${fileId}/comments`, { body: '   ' })).status).toBe(400)
    expect((await call(OWNER, 'POST', `/api/clouddrive/files/${fileId}/comments`, { body: 'x'.repeat(4001) })).status).toBe(400)
    expect((await call(OWNER, 'POST', `/api/clouddrive/files/${fileId}/comments`, { body: 'bad\u0000text' })).status).toBe(400)
    expect((await call(OWNER, 'GET', `/api/clouddrive/files/${fileId}/comments?ownerId=invalid`)).status).toBe(400)
  })
})
