import { Pipette } from 'lucide-react'
import { useState } from 'react'
import { t } from '../../../../lib/i18n'
import { Tooltip } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { canPickFromScreen, pickColorFromScreen } from '../lib/screen-pick'

export interface EyedropperButtonProps {
  onPick: (hex: string) => void
  disabled?: boolean
}

export function EyedropperButton({ onPick, disabled = false }: EyedropperButtonProps) {
  const [isSupported] = useState(canPickFromScreen)

  const handlePick = async () => {
    const hex = await pickColorFromScreen()
    if (hex) onPick(hex)
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
