import { Pipette } from 'lucide-react'
import { useState } from 'react'
import { t } from '../../../../lib/i18n'
import { Tooltip } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'

interface EyeDropperAPI {
  open: () => Promise<{ sRGBHex: string }>
}

declare global {
  interface Window {
    EyeDropper?: {
      new (): EyeDropperAPI
    }
  }
}

export interface EyedropperButtonProps {
  onPick: (hex: string) => void
  disabled?: boolean
}

export function EyedropperButton({ onPick, disabled = false }: EyedropperButtonProps) {
  const [isSupported] = useState(() => typeof window !== 'undefined' && 'EyeDropper' in window)

  const handlePick = async () => {
    if (!isSupported || !window.EyeDropper) return
    try {
      const dropper = new window.EyeDropper()
      const result = await dropper.open()
      if (result && result.sRGBHex) {
        onPick(result.sRGBHex)
      }
    } catch {
      // User cancelled pick or escape pressed
    }
  }

  const label = isSupported
    ? t('tools.color.studio.eyedropper')
    : t('tools.color.studio.eyedropper_unsupported')

  return (
    <Tooltip label={label}>
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled || !isSupported}
        onClick={handlePick}
        aria-label={label}
      >
        <Pipette size={14} />
        <span>{t('tools.color.studio.eyedropper')}</span>
      </Button>
    </Tooltip>
  )
}
