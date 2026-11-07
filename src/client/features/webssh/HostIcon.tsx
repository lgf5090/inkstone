/**
 * The leading icon of a host row and detail header.
 *
 * Resolution order is image → Lucide → emoji → provider monogram → the host's first letter. A failed
 * image load silently falls through to the same provider monogram, so a broken upload never leaves a
 * hole in the row.
 */
import { useState } from 'react'
import {
  Anchor, Box, Boxes, Building2, Cloud, CloudCog, Code2, Container, Cpu, Database, Flame,
  Globe, HardDrive, Layers, Lock, Monitor, Network, Rocket, Server, Shield, Terminal, Waves, Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { WebsshHost, WebsshProvider } from '@shared/webssh/types'
import { providerDefinition, providerShort } from '@shared/webssh/providers'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'

export function providerText(id: string, providers: readonly WebsshProvider[]): string {
  const custom = providers.find((provider) => provider.id === id)
  if (custom) return custom.label
  switch (id) {
    case 'oracle': return t('webssh.provider.oracle')
    case 'aws': return t('webssh.provider.aws')
    case 'azure': return t('webssh.provider.azure')
    case 'huawei': return t('webssh.provider.huawei')
    case 'tencent': return t('webssh.provider.tencent')
    case 'alibaba': return t('webssh.provider.alibaba')
    case 'gcp': return t('webssh.provider.gcp')
    case 'digitalocean': return t('webssh.provider.digitalocean')
    case 'linode': return t('webssh.provider.linode')
    case 'vultr': return t('webssh.provider.vultr')
    case 'cloudflare': return t('webssh.provider.cloudflare')
    case 'idc': return t('webssh.provider.idc')
    default: return t('webssh.provider.other')
  }
}

export const WEBSSH_LUCIDE_ICONS: ReadonlyArray<{ name: string; icon: LucideIcon }> = [
  { name: 'server', icon: Server },
  { name: 'database', icon: Database },
  { name: 'cloud', icon: Cloud },
  { name: 'cloud-cog', icon: CloudCog },
  { name: 'hard-drive', icon: HardDrive },
  { name: 'cpu', icon: Cpu },
  { name: 'network', icon: Network },
  { name: 'globe', icon: Globe },
  { name: 'shield', icon: Shield },
  { name: 'lock', icon: Lock },
  { name: 'terminal', icon: Terminal },
  { name: 'code', icon: Code2 },
  { name: 'container', icon: Container },
  { name: 'layers', icon: Layers },
  { name: 'monitor', icon: Monitor },
  { name: 'boxes', icon: Boxes },
  { name: 'box', icon: Box },
  { name: 'building', icon: Building2 },
  { name: 'rocket', icon: Rocket },
  { name: 'flame', icon: Flame },
  { name: 'waves', icon: Waves },
  { name: 'zap', icon: Zap },
  { name: 'anchor', icon: Anchor },
]

export const WEBSSH_EMOJI_ICONS: readonly string[] = [
  '🖥️', '💻', '🗄️', '☁️', '🌐', '🔒', '🔑', '⚙️', '🚀', '🔥', '⚡', '🐧', '🪟', '🍎', '🐳', '📦',
  '🧩', '🛠️', '🧪', '📡', '🏢', '🏭', '🌍', '🧭', '🛰️', '💾', '🧱', '🔧', '🗂️', '🧠',
]

const LUCIDE_BY_NAME = new Map(WEBSSH_LUCIDE_ICONS.map((entry) => [entry.name, entry.icon]))

export function providerColor(providerId: string, providers: readonly WebsshProvider[]): string {
  const custom = providers.find((provider) => provider.id === providerId)
  return custom?.color || providerDefinition(providerId).color
}

export function providerLabel(providerId: string, providers: readonly WebsshProvider[], labels: {
  builtin: (id: string, short: string) => string
  custom: (provider: WebsshProvider) => string
  other: (id: string) => string
}): string {
  const custom = providers.find((provider) => provider.id === providerId)
  if (custom) return labels.custom(custom)
  if (providerDefinition(providerId).id === providerId) return labels.builtin(providerId, providerDefinition(providerId).short)
  return labels.other(providerId)
}

export function HostIcon({
  host,
  providers,
  size = 18,
  className,
}: {
  host: Pick<WebsshHost, 'name' | 'provider' | 'iconKind' | 'iconValue' | 'iconUrl'>
  providers: readonly WebsshProvider[]
  size?: number
  className?: string
}) {
  const [imageFailed, setImageFailed] = useState(false)
  const custom = providers.find((provider) => provider.id === host.provider)
  const color = custom?.color || providerDefinition(host.provider).color
  const short = providerShort(host.provider, custom?.label)
  const glyphSize = Math.max(10, size - 6)

  if (host.iconKind === 'image' && host.iconUrl && !imageFailed) {
    return (
      <img
        src={host.iconUrl}
        alt=""
        width={size}
        height={size}
        aria-hidden="true"
        onError={() => setImageFailed(true)}
        className={cn('shrink-0 rounded-[var(--r-xs)] object-cover', className)}
        style={{ width: size, height: size }}
      />
    )
  }
  if (host.iconKind === 'lucide' && LUCIDE_BY_NAME.has(host.iconValue)) {
    const Glyph = LUCIDE_BY_NAME.get(host.iconValue)!
    return (
      <span
        aria-hidden="true"
        className={cn('flex shrink-0 items-center justify-center rounded-[var(--r-xs)]', className)}
        style={{ width: size, height: size, backgroundColor: `${color}1f`, color }}
      >
        <Glyph size={glyphSize} />
      </span>
    )
  }
  if (host.iconKind === 'emoji' && host.iconValue) {
    return (
      <span
        aria-hidden="true"
        className={cn('flex shrink-0 items-center justify-center rounded-[var(--r-xs)] bg-[var(--bg-inset)]', className)}
        style={{ width: size, height: size, fontSize: glyphSize }}
      >
        {host.iconValue}
      </span>
    )
  }
  return (
    <span
      aria-hidden="true"
      className={cn('flex shrink-0 items-center justify-center rounded-[var(--r-xs)] font-semibold text-[var(--text-inverse)]', className)}
      style={{ width: size, height: size, backgroundColor: color, fontSize: Math.max(8, size * 0.44) }}
    >
      {short || host.name.slice(0, 1).toUpperCase() || '?'}
    </span>
  )
}
