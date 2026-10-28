import { xgetPathPrefix } from '@shared/development/xget/catalog'
import type { XgetCategory } from '@shared/development/xget/types'
import { useThemeDark } from '../../../../lib/hooks'
import { categoryColor, categoryTint } from '../lib/category'

export function PlatformBadge({
  platformKey,
  category,
  size = 'md',
}: {
  platformKey: string
  category: XgetCategory
  size?: 'sm' | 'md'
}) {
  const dark = useThemeDark()
  const color = categoryColor(category, dark)
  return (
    <span
      data-slot="platform-badge"
      className={`inline-flex shrink-0 items-center rounded-[var(--r-sm)] border font-mono font-medium ${
        size === 'sm' ? 'px-1.5 py-0.5 text-[length:var(--text-11)]' : 'px-2 py-1 text-[length:var(--text-12)]'
      }`}
      style={{ color, borderColor: categoryTint(color, 28), backgroundColor: categoryTint(color, 10) }}
    >
      {xgetPathPrefix(platformKey)}
    </span>
  )
}
