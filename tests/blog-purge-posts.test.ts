// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { purgeAdminPosts } from '../src/worker/blog/store'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * A trashed post is the only row the delete path may see, and it owns two things the row alone does
 * not show: the assets it pinned in `blog_post_assets` and the R2 render snapshot under `render_key`.
 * Leaving either behind makes the media library refuse to delete the file and keeps paying for storage.
 */
async function installed(): Promise<{ sqlite: DatabaseSync; db: D1Database }> {
  const sqlite = new DatabaseSync(':memory:')
  await initializeDatabase({ DB: makeD1(sqlite) } as unknown as Env)
  return { sqlite, db: makeD1(sqlite) as unknown as D1Database }
}

describe('purging a trashed blog post', () => {
  it('removes the post, its asset links and its render snapshot', async () => {
    const { sqlite, db } = await installed()
    sqlite.exec(`
      INSERT INTO blog_assets (id,user_id,kind,object_key,variants,filename,mime,size,hash,created_at)
        VALUES ('a1','u1','image','blog/images/2026/a1.png','[]','a.png','image/png',10,'h1',1);
      INSERT INTO blog_posts (id,user_id,note_id,slug,title,status,deleted_at,created_at,updated_at,render_key)
        VALUES ('p1','u1','n1','trashed','Trashed','withdrawn',10,1,10,'blog/txt/renders/n1/hash.json');
      INSERT INTO blog_post_assets (user_id,post_id,asset_id,source_ref,created_at)
        VALUES ('u1','p1','a1','',1);
    `)
    const removed: string[] = []
    const bucket = { delete: vi.fn(async (key: string) => { removed.push(key) }) } as unknown as R2Bucket

    const count = await purgeAdminPosts(db, bucket, 'u1', ['n1'])

    expect(count).toBe(1)
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM blog_posts`).get()).toMatchObject({ n: 0 })
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM blog_post_assets`).get()).toMatchObject({ n: 0 })
    expect(removed).toEqual(['blog/txt/renders/n1/hash.json'])
  })

  it('does nothing to a post that is not in the trash, and is safe to run twice', async () => {
    const { sqlite, db } = await installed()
    sqlite.exec(`
      INSERT INTO blog_posts (id,user_id,note_id,slug,title,status,deleted_at,created_at,updated_at)
        VALUES ('p1','u1','n1','live','Live','published',NULL,1,1);
    `)
    expect(await purgeAdminPosts(db, undefined, 'u1', ['n1'])).toBe(0)
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM blog_posts`).get()).toMatchObject({ n: 1 })

    sqlite.exec(`UPDATE blog_posts SET deleted_at = 10, status = 'withdrawn'`)
    expect(await purgeAdminPosts(db, undefined, 'u1', ['n1'])).toBe(1)
    expect(await purgeAdminPosts(db, undefined, 'u1', ['n1'])).toBe(0)
  })
})
