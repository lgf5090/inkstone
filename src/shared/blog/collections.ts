import { BLOG_COLLECTION_KINDS, type BlogCollectionKind } from './model'

type FieldType = 'string' | 'text' | 'number' | 'boolean' | 'json'

export interface FieldDef {
  key: string
  type: FieldType
  max?: number
  required?: boolean
}

export interface CollectionDef {
  table: string
  titleField: string
  slugField?: string
  fields: FieldDef[]
  orderBy: string
}

export const BLOG_COLLECTION_DEFS: Record<BlogCollectionKind, CollectionDef> = {
  moments: {
    table: 'blog_moments',
    titleField: 'content',
    fields: [
      { key: 'content', type: 'text', max: 20_000, required: true },
      { key: 'pinned', type: 'boolean' },
      { key: 'location', type: 'string', max: 200 },
      { key: 'mood', type: 'string', max: 80 },
      { key: 'images', type: 'json' },
      { key: 'tags', type: 'json' },
      { key: 'published_at', type: 'number' },
      { key: 'draft', type: 'boolean' },
    ],
    orderBy: 'pinned DESC, published_at DESC, id DESC',
  },
  albums: {
    table: 'blog_albums',
    titleField: 'title',
    slugField: 'slug',
    fields: [
      { key: 'title', type: 'string', max: 200, required: true },
      { key: 'slug', type: 'string', max: 120 },
      { key: 'description', type: 'text', max: 5_000 },
      { key: 'cover_asset_id', type: 'string', max: 80 },
      { key: 'date', type: 'string', max: 40 },
      { key: 'location', type: 'string', max: 200 },
      { key: 'tags', type: 'json' },
      { key: 'layout', type: 'string', max: 40 },
      { key: 'columns', type: 'number' },
      { key: 'password', type: 'string', max: 200 },
      { key: 'password_hint', type: 'string', max: 200 },
      { key: 'position', type: 'number' },
      { key: 'published_at', type: 'number' },
    ],
    orderBy: 'position, created_at DESC',
  },
  friends: {
    table: 'blog_friends',
    titleField: 'name',
    fields: [
      { key: 'name', type: 'string', max: 200, required: true },
      { key: 'url', type: 'string', max: 500, required: true },
      { key: 'avatar_asset_id', type: 'string', max: 80 },
      { key: 'description', type: 'text', max: 2_000 },
      { key: 'tags', type: 'json' },
      { key: 'position', type: 'number' },
      { key: 'enabled', type: 'boolean' },
    ],
    orderBy: 'position, name',
  },
  projects: {
    table: 'blog_projects',
    titleField: 'title',
    fields: [
      { key: 'key', type: 'string', max: 120, required: true },
      { key: 'title', type: 'string', max: 200, required: true },
      { key: 'summary', type: 'text', max: 5_000 },
      { key: 'category', type: 'string', max: 120 },
      { key: 'phase', type: 'string', max: 80 },
      { key: 'technologies', type: 'json' },
      { key: 'icon', type: 'string', max: 200 },
      { key: 'cover_asset_id', type: 'string', max: 80 },
      { key: 'featured', type: 'boolean' },
      { key: 'website', type: 'string', max: 500 },
      { key: 'repository', type: 'string', max: 500 },
      { key: 'year', type: 'string', max: 40 },
      { key: 'position', type: 'number' },
    ],
    orderBy: 'position, title',
  },
  skills: {
    table: 'blog_skills',
    titleField: 'name',
    fields: [
      { key: 'name', type: 'string', max: 200, required: true },
      { key: 'description', type: 'text', max: 2_000 },
      { key: 'icon', type: 'string', max: 200 },
      { key: 'category', type: 'string', max: 120 },
      { key: 'level', type: 'number' },
      { key: 'position', type: 'number' },
    ],
    orderBy: 'position, name',
  },
  devices: {
    table: 'blog_devices',
    titleField: 'name',
    fields: [
      { key: 'name', type: 'string', max: 200, required: true },
      { key: 'brand', type: 'string', max: 120 },
      { key: 'category', type: 'string', max: 120 },
      { key: 'status', type: 'string', max: 80 },
      { key: 'specs', type: 'json' },
      { key: 'description', type: 'text', max: 5_000 },
      { key: 'icon', type: 'string', max: 200 },
      { key: 'featured', type: 'boolean' },
      { key: 'year', type: 'string', max: 40 },
      { key: 'link', type: 'string', max: 500 },
      { key: 'position', type: 'number' },
    ],
    orderBy: 'position, name',
  },
  games: {
    table: 'blog_games',
    titleField: 'name',
    fields: [
      { key: 'name', type: 'string', max: 200, required: true },
      { key: 'developer', type: 'string', max: 200 },
      { key: 'category', type: 'string', max: 120 },
      { key: 'status', type: 'string', max: 80 },
      { key: 'cover_asset_id', type: 'string', max: 80 },
      { key: 'icon', type: 'string', max: 200 },
      { key: 'rating', type: 'number' },
      { key: 'hours', type: 'number' },
      { key: 'platform', type: 'string', max: 120 },
      { key: 'year', type: 'string', max: 40 },
      { key: 'tags', type: 'json' },
      { key: 'description', type: 'text', max: 5_000 },
      { key: 'link', type: 'string', max: 500 },
      { key: 'featured', type: 'boolean' },
      { key: 'position', type: 'number' },
    ],
    orderBy: 'position, name',
  },
  anime: {
    table: 'blog_anime',
    titleField: 'title',
    fields: [
      { key: 'title', type: 'string', max: 200, required: true },
      { key: 'cover_asset_id', type: 'string', max: 80 },
      { key: 'cover_url', type: 'string', max: 500 },
      { key: 'link', type: 'string', max: 500 },
      { key: 'status', type: 'string', max: 80 },
      { key: 'rating', type: 'number' },
      { key: 'watched', type: 'number' },
      { key: 'total', type: 'number' },
      { key: 'year', type: 'string', max: 40 },
      { key: 'studio', type: 'string', max: 200 },
      { key: 'genres', type: 'json' },
      { key: 'period_start', type: 'string', max: 40 },
      { key: 'period_end', type: 'string', max: 40 },
      { key: 'identity', type: 'string', max: 200 },
      { key: 'position', type: 'number' },
    ],
    orderBy: 'position, title',
  },
  timeline: {
    table: 'blog_timeline',
    titleField: 'title',
    fields: [
      { key: 'title', type: 'string', max: 200, required: true },
      { key: 'date', type: 'string', max: 40 },
      { key: 'category', type: 'string', max: 120 },
      { key: 'subtitle', type: 'string', max: 300 },
      { key: 'location', type: 'string', max: 200 },
      { key: 'description', type: 'text', max: 5_000 },
      { key: 'highlights', type: 'json' },
      { key: 'tags', type: 'json' },
      { key: 'links', type: 'json' },
      { key: 'icon', type: 'string', max: 200 },
      { key: 'featured', type: 'boolean' },
      { key: 'position', type: 'number' },
    ],
    orderBy: 'position, date DESC',
  },
  compass: {
    table: 'blog_compass_shelves',
    titleField: 'name',
    fields: [
      { key: 'key', type: 'string', max: 120, required: true },
      { key: 'name', type: 'string', max: 200, required: true },
      { key: 'icon', type: 'string', max: 200 },
      { key: 'blurb', type: 'text', max: 2_000 },
      { key: 'position', type: 'number' },
    ],
    orderBy: 'position, name',
  },
}

export function collectionKind(value: unknown): BlogCollectionKind {
  if (typeof value === 'string' && (BLOG_COLLECTION_KINDS as readonly string[]).includes(value)) {
    return value as BlogCollectionKind
  }
  throw new Error('collection_kind_invalid')
}

