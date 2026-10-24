import { useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { MenuItem } from '../../../components/overlay'
import { IconButton } from '../../../components/primitives'
import { Menu, Tooltip } from '../../../components/overlay'
import { cn } from '../../../lib/cn'

/**
 * A row's actions behind a real menu button.
 *
 * Shared by the rail's folder rows and the hub's link rows so a row's overflow is one control in one
 * place: `Menu` already owns focus trapping, Escape, the backdrop and the `role="menu"` semantics, and
 * a second hand-rolled popover in the same panel is how two rows end up behaving differently.
 *
 * The trigger is always drawn below `md` — a touch screen has no hover to reveal it — and on the wide
 * layout hover and keyboard focus both bring it up, so it is never the only way to reach an action.
 */
export function RowMenu(props: {
  label: string
  items: MenuItem[]
  className?: string
}) {
  const anchor = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  return (
    <div className={cn('flex shrink-0 items-center', props.className)}>
      <Tooltip label={props.label} side="left">
        <IconButton
          ref={anchor}
          label={props.label}
          size="sm"
          aria-haspopup="menu"
          aria-expanded={open}
          className={cn(
            'size-11 opacity-100 transition-opacity md:size-6 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100',
            open && 'md:opacity-100',
          )}
          onClick={() => setOpen((value) => !value)}
        >
          <MoreHorizontal size={15}/>
        </IconButton>
      </Tooltip>
      <Menu anchor={anchor} open={open} onClose={() => setOpen(false)} items={props.items} align="end"/>
    </div>
  )
}
