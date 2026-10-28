import type { XgetCategory } from '@shared/development/xget/types'
import { useThemeDark } from '../../../../lib/hooks'
import { categoryColor, categoryTint, CATEGORY_ICONS } from '../lib/category'
import { PLATFORM_ICONS } from '../utils/platform-icons'

export function PlatformIcon({
  platformKey,
  category,
  size = 'md',
}: {
  platformKey: string
  category: XgetCategory
  size?: 'sm' | 'md'
}) {
  const dark = useThemeDark()
  const icon = PLATFORM_ICONS[platformKey]
  const box = size === 'sm' ? 'h-5 w-5' : 'h-7 w-7'
  if (icon) {
    return (
      <span
        className={`flex shrink-0 items-center justify-center rounded-[var(--r-sm)] ${box}`}
        style={{ backgroundColor: `#${icon.hex}` }}
        title={icon.title}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" className="h-3/5 w-3/5 fill-white">
          <path d={icon.path} />
        </svg>
      </span>
    )
  }
  const Fallback = CATEGORY_ICONS[category]
  const color = categoryColor(category, dark)
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-[var(--r-sm)] ${box}`}
      style={{ color, backgroundColor: categoryTint(color, 15) }}
      aria-hidden="true"
    >
      <Fallback size={size === 'sm' ? 12 : 16} />
    </span>
  )
}
