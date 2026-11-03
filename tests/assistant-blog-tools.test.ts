// @vitest-environment node
/**
 * The blog tools the assistant reaches through the executor.
 *
 * The real blog store runs against an in-memory D1 double, because the point of these tools is that a
 * sentence becomes a stored row with the note still as its source: a fake projection would pass while
 * nothing was written. The cases pin the four steps the task asks for — note to draft, SEO fields that
 * the admin screen then shows, a publish that stays proposed until approved, and a member being refused
 * the site-wide blog — plus the slug uniqueness the admin already enforces.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantConversation } from '../src/shared/assistant'
import { initializeDatabase } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { ToolExecutor, runApprovedAction, type ToolContext } from '../src/worker/assistant/tools'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const OWNER = '0123456789abcdefghjkmnpqrs'
const MEMBER = '0123456789abcdefghjkmnpqrt'
const ZONE = 'Asia/Shanghai'

let sqlite: DatabaseSync
let env: Env
let assistant: AssistantStore
let conversation: AssistantConversation

function context(store = assistant, over: Partial<ToolContext> = {}): ToolContext {
  return {
    store,
    env,
    ftsEnabled: false,
    origin: 'http://localhost',
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, timezone: ZONE },
    timezone: ZONE,
    dayEnd: 1_700_000_000_000,
    mode: 'chat',
    conversationId: conversation.id,
    memoryHistory: {} as ToolContext['memoryHistory'],
    memoryScope: { projectId: null },
    automations: {} as ToolContext['automations'],
    noteScope: async () => ({ restricted: false, folderIds: new Set(), tagIds: new Set(), noteIds: new Set() }),
    writeContext: {
      env,
      userId: store.userId,
      ftsEnabled: false,
      executionCtx: { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    },
    ...over,
  }
}

function executor(store = assistant): ToolExecutor {
  return new ToolExecutor(context(store), { maxToolCalls: 20 })
}

let sequence = 0

async function makeNote(title: string, content: string): Promise<string> {
  sequence += 1
  const result = await executor().execute('create_note', { title, content }, `note-op-${String(sequence).padStart(4, '0')}`) as {
    created: { id: string }
  }
  return result.created.id
}

function postRow(noteId: string): Record<string, unknown> | undefined {
  return sqlite.prepare('SELECT * FROM blog_posts WHERE note_id = ?1').get(noteId) as Record<string, unknown> | undefined
}

function noteContent(noteId: string): string {
  return (sqlite.prepare('SELECT content FROM notes WHERE id = ?1').get(noteId) as { content: string }).content
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await initializeDatabase(env)
  const insertUser = sqlite.prepare(
    'INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?1, ?2, ?4, ?5, ?5)',
  )
  insertUser.run(OWNER, 'owner', 'x', 'owner', 1)
  insertUser.run(MEMBER, 'member', 'x', 'member', 2)
  assistant = new AssistantStore(env.DB, OWNER, env)
  conversation = await assistant.createConversation('Blog bench')
})

describe('turning a note into a blog draft', () => {
  it('writes a real draft row whose note id stays the mapping', async () => {
    const noteId = await makeNote('把雨写进夜色', '## 起风了\n\n雨落在窗台上，像一场没有排练的演出。')
    const draft = await executor().execute('blog_create_draft', { note_id: noteId }, 'blog-draft-1') as {
      created: boolean
      post: Record<string, unknown>
    }

    expect(draft.created).toBe(true)
    expect(draft.post).toMatchObject({ note_id: noteId, status: 'draft' })
    expect(String(draft.post.slug).length).toBeGreaterThan(0)

    const row = postRow(noteId)
    expect(row).toBeDefined()
    expect(row!.status).toBe('draft')
    expect(row!.slug).toBe(String(draft.post.slug))
    const content = noteContent(noteId)
    expect(content).toContain('blogType: post')
    expect(content).toContain('isPublished: false')
  })

  it('returns the same draft instead of a duplicate when called again', async () => {
    const noteId = await makeNote('重复的草稿', '一段正文。')
    const first = await executor().execute('blog_create_draft', { note_id: noteId }, 'blog-draft-a') as { post: { id: string } }
    const second = await executor().execute('blog_create_draft', { note_id: noteId }, 'blog-draft-b') as {
      created: boolean
      post: { id: string }
    }
    expect(second.created).toBe(false)
    expect(second.post.id).toBe(first.post.id)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM blog_posts WHERE note_id = ?1').get(noteId)).toMatchObject({ count: 1 })
  })

  it('gives two posts with the same title distinct slugs', async () => {
    const one = await makeNote('同名文章', '第一篇。')
    const two = await makeNote('同名文章', '第二篇。')
    const first = await executor().execute('blog_create_draft', { note_id: one }, 'blog-same-1') as { post: { slug: string } }
    const second = await executor().execute('blog_create_draft', { note_id: two }, 'blog-same-2') as { post: { slug: string } }
    expect(first.post.slug).not.toBe(second.post.slug)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM blog_posts WHERE slug = ?1').get(first.post.slug))
      .toMatchObject({ count: 1 })
  })
})

describe('generating SEO fields', () => {
  it('writes the chosen title, summary and slug into the post and tags into the note', async () => {
    const noteId = await makeNote('雨夜', '## 雨夜\n\n城市把灯光留在水里，行人绕开倒影。')
    await executor().execute('blog_create_draft', { note_id: noteId }, 'blog-seo-draft')

    const seo = await executor().execute('blog_seo', {
      id: noteId,
      title: '雨夜：城市把灯光留在水里',
      description: '一篇关于雨夜与城市灯光的随笔。',
      slug: 'rainy-night-city-lights',
      tags: ['随笔', '城市'],
    }, 'blog-seo-1') as { applied: boolean, applied_fields: Record<string, unknown> }

    expect(seo.applied).toBe(true)
    expect(seo.applied_fields).toMatchObject({
      title: '雨夜：城市把灯光留在水里',
      description: '一篇关于雨夜与城市灯光的随笔。',
      excerpt: '一篇关于雨夜与城市灯光的随笔。',
      slug: 'rainy-night-city-lights',
    })
    expect([...(seo.applied_fields.tags as string[])].sort()).toEqual(['城市', '随笔'])

    const row = postRow(noteId)
    expect(row!.slug).toBe('rainy-night-city-lights')
    expect(row!.description).toBe('一篇关于雨夜与城市灯光的随笔。')
    expect(row!.excerpt).toBe('一篇关于雨夜与城市灯光的随笔。')
    expect(sqlite.prepare('SELECT title FROM notes WHERE id = ?1').get(noteId)).toMatchObject({ title: '雨夜：城市把灯光留在水里' })

    const storedTags = sqlite.prepare(
      'SELECT t.name FROM blog_post_tags pt JOIN blog_tags t ON t.id = pt.tag_id AND t.user_id = pt.user_id WHERE pt.post_id = ?1',
    ).all(String(row!.id)) as Array<{ name: string }>
    expect(storedTags.map((tag) => tag.name).sort()).toEqual(['城市', '随笔'])
  })

  it('returns candidates and a free slug without writing when apply is off', async () => {
    const noteId = await makeNote('候选标题', '## 第一节\n\n正文。')
    await executor().execute('blog_create_draft', { note_id: noteId }, 'blog-seo-dry-draft')
    const before = postRow(noteId)!
    const preview = await executor().execute('blog_seo', {
      id: noteId,
      title: '另一个标题',
      apply: false,
    }, 'blog-seo-2') as { applied: boolean, title_candidates: string[], suggested: Record<string, unknown> }

    expect(preview.applied).toBe(false)
    expect(preview.title_candidates.length).toBeGreaterThan(0)
    expect(preview.suggested.slug).toBeTruthy()
    expect(postRow(noteId)).toEqual(before)
  })
})

describe('publishing', () => {
  it('raises an approval card and publishes nothing until it is approved', async () => {
    const noteId = await makeNote('待发布的文章', '正文已经写好。')
    await executor().execute('blog_create_draft', { note_id: noteId }, 'blog-publish-draft')
    const post = postRow(noteId)!

    const proposal = await executor().execute('blog_publish', { id: noteId }, 'blog-publish-1') as {
      status: string
      action: string
    }
    expect(proposal.status).toBe('awaiting_reader_approval')
    expect(proposal.action).toContain('待发布的文章')
    expect(proposal.action).toContain(String(post.slug))
    expect(postRow(noteId)!.status).toBe('draft')
    expect(noteContent(noteId)).toContain('isPublished: false')

    const actions = await assistant.actionStatesForConversation(conversation.id)
    const pending = [...actions.values()].find((action) => action.tool === 'blog_publish')
    expect(pending).toBeDefined()
    expect(pending!.status).toBe('pending')

    await runApprovedAction(assistant, context(), pending!.id)
    expect(noteContent(noteId)).toContain('isPublished: true')
    const published = postRow(noteId)!
    expect(['published', 'pending_snapshot']).toContain(String(published.status))
    const audit = sqlite.prepare("SELECT COUNT(*) AS count FROM blog_audit WHERE action = 'post.publish'").get() as { count: number }
    expect(audit.count).toBe(1)
  })

  it('refuses to propose a publish for an empty body', async () => {
    const noteId = await makeNote('空文章', '')
    await executor().execute('blog_create_draft', { note_id: noteId }, 'blog-empty-draft')
    await expect(executor().execute('blog_publish', { id: noteId }, 'blog-empty-publish')).rejects.toThrow(/body/i)
    expect(postRow(noteId)!.status).toBe('draft')
  })
})

describe('a member account', () => {
  it('is refused the site-wide blog', async () => {
    const member = new AssistantStore(env.DB, MEMBER, env)
    await expect(executor(member).execute('blog_list_posts', {}, 'blog-member-list')).rejects.toThrow(/owner/i)
  })
})
