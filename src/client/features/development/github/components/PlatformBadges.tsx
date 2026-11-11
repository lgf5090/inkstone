import { Laptop, Monitor, Smartphone, Terminal } from 'lucide-react'
import type { GithubAssetPlatform } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'

const PLATFORM_META: Record<GithubAssetPlatform, { icon: typeof Monitor; color: string; labelKey: Parameters<typeof t>[0] }> = {
  android: { icon: Smartphone, color: 'var(--platform-android)', labelKey: 'development.github.store.platform.android' },
  windows: { icon: Monitor, color: 'var(--platform-windows)', labelKey: 'development.github.store.platform.windows' },
  macos: { icon: Laptop, color: 'var(--platform-macos)', labelKey: 'development.github.store.platform.macos' },
  linux: { icon: Terminal, color: 'var(--platform-linux)', labelKey: 'development.github.store.platform.linux' },
}

export function PlatformBadge({ platform, size = 10 }: { platform: GithubAssetPlatform; size?: number }) {
  const meta = PLATFORM_META[platform]
  const Icon = meta.icon
  return (
    <span className="inline-flex items-center gap-1 text-[length:var(--text-10)]" style={{ color: meta.color }}>
      <Icon size={size} />
      {t(meta.labelKey)}
    </span>
  )
}

export function PlatformBadges({ platforms, size = 10 }: { platforms: readonly GithubAssetPlatform[]; size?: number }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {platforms.map((platform) => <PlatformBadge key={platform} platform={platform} size={size} />)}
    </span>
  )
}
