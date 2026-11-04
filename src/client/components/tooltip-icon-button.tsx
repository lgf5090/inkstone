import { forwardRef, type ComponentProps } from 'react'
import { IconButton } from './primitives'
import { Tooltip } from './overlay'

type IconButtonProps = ComponentProps<typeof IconButton>

export interface TooltipIconButtonProps extends IconButtonProps {
  /**
   * What the tooltip says while the button is disabled. Disabled buttons drop pointer events of their
   * own, so the wrapper below is the element that actually receives hover; without this hint a
   * greyed-out control would be silent exactly when the reader needs to know why.
   */
  disabledHint?: string
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right'
}

/**
 * The IconButton with its `label` also shown as a tooltip.
 *
 * IconButton only paints an `aria-label`, which leaves a mouse reader guessing at a row of unlabelled
 * glyphs. The wrapper is a real inline box rather than `display: contents` because the tooltip
 * measures its first element child: a box-less wrapper reports a zero rect and the tooltip never
 * appears.
 */
export const TooltipIconButton = forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
  function TooltipIconButton({ disabledHint, tooltipSide = 'bottom', label, ...rest }, ref) {
    const text = rest.disabled && disabledHint ? disabledHint : label
    return (
      <Tooltip label={text} side={tooltipSide}>
        <span className="inline-flex shrink-0" data-tooltip-button="">
          <IconButton ref={ref} label={label} {...rest} />
        </span>
      </Tooltip>
    )
  },
)
