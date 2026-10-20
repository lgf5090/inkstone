/**
 * One row's mark: a brand, an emoji, a Lucide glyph, or an uploaded image.
 *
 * Every list draws this component instead of its own dot or generic chip, so a provider's mark and the
 * model's mark cannot disagree about which vendor they belong to. The value is decoded by the shared
 * parser first; an empty or unreadable value falls through to the caller's inferred default and then to
 * a neutral bot, which is the one mark that says "no vendor known" without inventing one.
 */
import type { LucideIcon } from 'lucide-react'
import {
  Aperture, Atom, Blocks, Bot, Boxes, Brain, CircuitBoard, Circle, Cloud, Code2, Compass, Container,
  Cpu, Database, Feather, Flame, FlaskConical, Gem, Gift, Globe2, Hexagon, Layers, Leaf, Microscope,
  Moon, Network, Orbit, Rocket, Satellite, Search, Server, Shield, Sparkles, Star, Sun, Telescope,
  Terminal, Wand2, Workflow, Zap,
} from 'lucide-react'
import { assistantBrand, parseAssistantIcon } from '@shared/assistant-icons'
import { cn } from '../../lib/cn'
import { BRAND_ICON_URLS } from './brand-icon-assets'

const LUCIDE_ICONS: Readonly<Record<string, LucideIcon>> = {
  Aperture, Atom, Blocks, Bot, Boxes, Brain, CircuitBoard, Circle, Cloud, Code2, Compass, Container,
  Cpu, Database, Feather, Flame, FlaskConical, Gem, Gift, Globe2, Hexagon, Layers, Leaf, Microscope,
  Moon, Network, Orbit, Rocket, Satellite, Search, Server, Shield, Sparkles, Star, Sun, Telescope,
  Terminal, Wand2, Workflow, Zap,
}

export function AssistantIcon({
  value,
  fallback,
  size = 18,
  className,
  label,
}: {
  value?: string | null
  /** The inferred mark to use when `value` is empty or no longer readable. */
  fallback?: string | null
  size?: number
  className?: string
  /** An accessible name for a mark that stands alone; omitted when a row already names it beside the mark. */
  label?: string
}) {
  const icon = parseAssistantIcon(value) || parseAssistantIcon(fallback)
  const box = { width: size, height: size }
  const frame = cn('inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--r-sm)]', className)
  const accessibility = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const }

  if (icon.startsWith('data:image/')) {
    return (
      <span style={box} className={cn(frame, 'border border-[var(--border-subtle)] bg-[var(--bg-inset)]')} {...accessibility}>
        <img src={icon} alt="" className="size-full object-cover" draggable={false} />
      </span>
    )
  }
  if (icon.startsWith('brand:')) {
    const key = icon.slice(6)
    const url = BRAND_ICON_URLS[key]
    if (url) {
      return (
        <span style={box} className={cn(frame, 'border border-black/10 bg-white')} {...accessibility}>
          <img src={url} alt="" className="size-[78%] object-contain" draggable={false} />
        </span>
      )
    }
    const brand = assistantBrand(key)
    if (brand) {
      return (
        <span
          style={{ ...box, backgroundColor: brand.color, fontSize: Math.max(7, size * 0.36), lineHeight: 1 }}
          className={cn(frame, 'font-semibold text-white')}
          {...accessibility}
        >
          {brand.monogram}
        </span>
      )
    }
  }
  if (icon.startsWith('emoji:')) {
    return (
      <span style={{ ...box, fontSize: Math.max(9, size * 0.72), lineHeight: 1 }} className={cn(frame, 'bg-[var(--bg-inset)]')} {...accessibility}>
        {icon.slice(6)}
      </span>
    )
  }
  if (icon.startsWith('lucide:')) {
    const Glyph = LUCIDE_ICONS[icon.slice(7)] ?? Bot
    return (
      <span style={box} className={cn(frame, 'bg-[var(--bg-inset)] text-[var(--text-secondary)]')} {...accessibility}>
        <Glyph size={Math.round(size * 0.66)} aria-hidden />
      </span>
    )
  }
  return (
    <span style={box} className={cn(frame, 'bg-[var(--bg-inset)] text-[var(--text-tertiary)]')} {...accessibility}>
      <Bot size={Math.round(size * 0.66)} aria-hidden />
    </span>
  )
}
