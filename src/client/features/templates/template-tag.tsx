import { cn } from '../../lib/cn'

/**
 * One tag written on a template.
 *
 * The card, the community row, the preview modal and the publish sheet each drew the same span, and
 * four copies of one literal class string is how four surfaces end up with four pills that only look
 * the same today.
 *
 * It is a label rather than the shared `TagChip`, because it is not a control: a template card is
 * already a button with its own hit target, and a pressable chip inside it would nest one control in
 * another. What a chip owns — the pressed state, the count, the keyboard — this has no use for.
 */
export function TemplateTag({ tag, className }: {
  /** The tag as written on the template; the `#` is drawn here, so no call site restates it. */
  tag: string
  className?: string
}) {
  return (<span className={cn('rounded-[var(--r-full)] bg-[var(--bg-raised)] px-[var(--sp-1-5)] py-px', 'text-[length:var(--text-10)] text-[var(--text-tertiary)]', className)}>
    {/* Read as a name, not as "hash sprint": the sigil is decoration, the same way `TagChip` keeps it. */}
    <span aria-hidden="true">#</span>{tag}
  </span>)
}
