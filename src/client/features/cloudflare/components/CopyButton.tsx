/**
 * Copy a value, with the confirmation in the button itself.
 *
 * The clipboard call is the notebook's own (`copyText`), which falls back to `execCommand` on a plain
 * http deployment where the modern API is unavailable. A failure is reported through the app's toast
 * rather than silently doing nothing.
 */
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { copyText } from '../../../lib/clipboard'
import { useUi } from '../../../store/ui'
import { Button, IconButton } from '../../../components/primitives'

export function CopyButton({
  text,
  label,
  className,
  size = 'sm',
}: {
  text: string
  /** Visible text beside the icon; omitted for an icon-only control. */
  label?: string
  className?: string
  size?: 'xs' | 'sm' | 'md'
}) {
  const [copied, setCopied] = useState(false)
  const toast = useUi((state) => state.toast)

  async function handleCopy(): Promise<void> {
    const ok = await copyText(text)
    if (!ok) {
      toast({ title: t('common.action_failed'), tone: 'danger' })
      return
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
  }

  const name = label ?? t('common.copy')
  // A labelled copy control is a text button: the icon-only primitive is a fixed square, and preflight
  // makes every `svg` a block box, so a word inside it wraps one glyph per line.
  if (label) {
    return (
      <Button
        variant="ghost"
        size={size === 'md' ? 'md' : 'sm'}
        icon={copied ? <Check size={13} /> : <Copy size={13} />}
        onClick={() => { void handleCopy() }}
        className={className}
      >
        {copied ? t('common.copied') : label}
      </Button>
    )
  }
  return (
    <IconButton
      label={copied ? t('common.copied') : name}
      size={size}
      onClick={() => { void handleCopy() }}
      className={cn('shrink-0', className)}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </IconButton>
  )
}
