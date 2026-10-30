import { z } from 'zod'
import { BLOG_SETTING_KEYS } from './settings'

export const BlogHeadingSchema = z.object({
  depth: z.number().int().min(1).max(6),
  slug: z.string().min(1).max(500),
  text: z.string().max(4000),
  html: z.string().max(8000).optional(),
})

export const BlogSnapshotSchema = z.object({
  version: z.literal(1),
  rendererVersion: z.string().min(1).max(200),
  noteId: z.string().min(1).max(200),
  contentHash: z.string().min(1).max(128),
  html: z.string().max(4 * 1024 * 1024),
  headings: z.array(BlogHeadingSchema).max(5000),
  fences: z.record(
    z.string().max(500),
    z.array(z.string().max(1024 * 1024)).max(2000),
  ),
  features: z.array(z.string().min(1).max(64)).max(50),
  assets: z
    .array(
      z.object({
        attachmentId: z.string().max(200).optional(),
        blogAssetId: z.string().max(200).optional(),
        url: z.string().min(1).max(2000),
      }),
    )
    .max(500),
  wikiLinks: z
    .array(z.object({ target: z.string().min(1).max(500), slug: z.string().max(500).nullable() }))
    .max(2000),
  settings: z.object({ locale: z.string().min(1).max(32), emojiShortcodes: z.boolean() }),
  generatedAt: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(500)).max(100),
})

export const BlogPublishSchema = z.object({ snapshot: BlogSnapshotSchema })

export const BlogSettingPatchSchema = z.object({
  key: z.enum(BLOG_SETTING_KEYS),
  value: z.unknown(),
})

export type BlogSnapshotInput = z.infer<typeof BlogSnapshotSchema>
