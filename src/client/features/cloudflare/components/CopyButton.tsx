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
import { IconButton } from '../../../components/primitives'

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
  return (
    <IconButton
      label={copied ? t('common.copied') : name}
      size={size}
      onClick={() => { void handleCopy() }}
      className={cn(!label && 'shrink-0', className)}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {label && <span className="ml-1.5">{copied ? t('common.copied') : label}</span>}
    </IconButton>
  )
}
