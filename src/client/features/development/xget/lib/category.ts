import type { ComponentType } from 'react'
import { Container, FileText, GitBranch, Monitor, Package, Sparkles } from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import { XGET_CATEGORIES, type XgetCategory } from '@shared/development/xget/types'
import { chartIdentityPalette, chartPaletteKey } from '../../../../lib/markdown/chart/accent'

export const CATEGORY_ORDER = XGET_CATEGORIES

export const CATEGORY_LABEL_KEYS: Record<XgetCategory, MessageKey> = {
  code: 'development.xget.category.code',
  package: 'development.xget.category.package',
  linux: 'development.xget.category.linux',
  misc: 'development.xget.category.misc',
  ai: 'development.xget.category.ai',
  registry: 'development.xget.category.registry',
}

export const CATEGORY_ICONS: Record<XgetCategory, ComponentType<{ size?: number; className?: string }>> = {
  code: GitBranch,
  package: Package,
  linux: Monitor,
  misc: FileText,
  ai: Sparkles,
  registry: Container,
}

const FALLBACK_COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#06b6d4', '#f97316']
const paletteCache = new Map<string, string[]>()

function categoryPalette(dark: boolean): string[] {
  const key = chartPaletteKey(dark)
  const cached = paletteCache.get(key)
  if (cached) return cached
  const palette = chartIdentityPalette(dark)
  paletteCache.set(key, palette)
  return palette
}

export function categoryColor(category: XgetCategory, dark: boolean): string {
  const index = CATEGORY_ORDER.indexOf(category)
  const palette = categoryPalette(dark)
  return palette[index] ?? FALLBACK_COLORS[index] ?? FALLBACK_COLORS[0]!
}

export function categoryTint(color: string, percent: number): string {
  return `color-mix(in oklab, ${color} ${percent}%, transparent)`
}
