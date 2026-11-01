/**
 * The saved colour collection, as a file a reader can keep.
 *
 * A favourite colour and a palette had no way out: deleting one was permanent, and the export dialog only
 * wrote colour codes for design tools, not the names, tags and notes that make a collection readable. This
 * is the round trip — same shape in, same shape out — kept in `shared` so the file a reader hands back is
 * checked against the same rules that wrote it.
 */
import { z } from 'zod'
import { COLOR_LIST_LIMIT, COLOR_PALETTE_MAX_COLORS } from './contract'

/** Bumped when the shape below changes; a reader's old file says which version it is. */
export const COLOR_BACKUP_VERSION = 1

/** A backup may not carry more than a page of each collection, whatever the file claims. */
export const COLOR_BACKUP_MAX_ROWS = COLOR_LIST_LIMIT

const FavoriteRow = z.object({
  id: z.string(),
  hex: z.string(),
  name: z.string().default(''),
  tags: z.array(z.string()).default([]),
  note: z.string().default(''),
  sort: z.number().int().default(0),
})

const PaletteRow = z.object({
  id: z.string(),
  title: z.string(),
  colors: z.array(z.object({ hex: z.string(), name: z.string().optional(), ratio: z.number().optional() }))
    .min(1)
    .max(COLOR_PALETTE_MAX_COLORS),
  sourceType: z.enum(['custom', 'colorhunt', 'mycolorspace', 'ai', 'image', 'harmony']).default('custom'),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),
  isFavorite: z.boolean().default(false),
  sort: z.number().int().default(0),
})

export const ColorBackupSchema = z.object({
  version: z.literal(COLOR_BACKUP_VERSION),
  exportedAt: z.string(),
  favorites: z.array(FavoriteRow).max(COLOR_BACKUP_MAX_ROWS),
  palettes: z.array(PaletteRow).max(COLOR_BACKUP_MAX_ROWS),
})

export type ColorBackup = z.infer<typeof ColorBackupSchema>

export interface ColorBackupRow {
  id: string
  hex: string
  name: string
  tags: string[]
  note: string
  sort: number
}

export interface ColorBackupPaletteRow {
  id: string
  title: string
  colors: Array<{ hex: string; name?: string; ratio?: number }>
  sourceType: 'custom' | 'colorhunt' | 'mycolorspace' | 'ai' | 'image' | 'harmony'
  description: string
  tags: string[]
  isFavorite: boolean
  sort: number
}

export function buildColorBackup(input: {
  favorites: ColorBackupRow[]
  palettes: ColorBackupPaletteRow[]
  exportedAt?: string
}): string {
  return JSON.stringify(
    {
      version: COLOR_BACKUP_VERSION,
      exportedAt: input.exportedAt ?? new Date().toISOString(),
      favorites: input.favorites,
      palettes: input.palettes,
    },
    null,
    2,
  )
}

/** The file as written, or null when it is not a backup this version can read. */
export function parseColorBackup(text: string): ColorBackup | null {
  try {
    return ColorBackupSchema.parse(JSON.parse(text))
  } catch {
    return null
  }
}
