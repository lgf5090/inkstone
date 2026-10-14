import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { Check } from 'lucide-react'
import { cn } from '../lib/cn'
import { Tooltip } from './overlay'

/** The box every text field in a dialog wears; `overlay`'s prompt reads it rather than importing
 * `Input`, because form already imports overlay and a component cycle would resolve at render. */
export const FIELD_BASE = cn(
  'w-full rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)]',
  'px-2.5 text-[length:var(--text-13)] text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)]',
  'transition-[border-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
  'focus:border-[var(--accent)] focus:shadow-[var(--shadow-ring-focus)] focus:outline-none',
  'disabled:opacity-50',
)

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>
  leading?: ReactNode
  trailing?: ReactNode
  invalid?: boolean
}

/**
 * Enter inside a text field has to be cancelled before it commits. Committing can mount a confirm
 * dialog, and the browser runs the keydown's default action after our handler returns, so the very
 * keystroke that asked would otherwise press the dialog's own button and answer it.
 */
export function commitOnEnter(event: ReactKeyboardEvent, commit: () => void): boolean {
  if (event.key !== 'Enter')
    return false
  event.preventDefault()
  commit()
  return true
}

export function Input({
  className,
  leading,
  trailing,
  invalid,
  'aria-invalid': ariaInvalid,
  ...rest
}: InputProps) {
  const accessibleInvalid = invalid ? true : ariaInvalid
  if (leading || trailing) {
    return (
      <div className="relative flex items-center">
        {leading && (
          <span className="pointer-events-none absolute left-2.5 text-[var(--text-quaternary)]">
            {leading}
          </span>
        )}
        <input
          {...rest}
          aria-invalid={accessibleInvalid}
          className={cn(
            FIELD_BASE,
            'h-11 md:h-[34px]',
            leading && 'pl-8',
            trailing && 'pr-8',
            invalid && 'border-[var(--danger)]',
            className,
          )}
        />
        {trailing && <span className="absolute right-2.5 flex items-center">{trailing}</span>}
      </div>
    )
  }
  return (
    <input
      {...rest}
      aria-invalid={accessibleInvalid}
      className={cn(FIELD_BASE, 'h-11 md:h-[34px]', invalid && 'border-[var(--danger)]', className)}
    />
  )
}

export function Textarea({
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea {...rest} className={cn(FIELD_BASE, 'py-2 leading-relaxed resize-y', className)} />
}

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> }) {
  return (
    <div className="relative">
      <select
        {...rest}
        className={cn(FIELD_BASE, 'h-11 cursor-pointer appearance-none pr-7 md:h-[34px]', className)}
      >
        {children}
      </select>
      <svg
        viewBox="0 0 12 12"
        width="11"
        height="11"
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
        aria-hidden="true"
      >
        <path
          d="M2.5 4.5 6 8l3.5-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}


export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-6 w-11 shrink-0 rounded-full transition-colors duration-[var(--dur-base)] ease-[var(--ease-out)] md:h-[20px] md:w-[34px]',
        'disabled:opacity-45',
        checked ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-[2px] top-[2px] size-5 rounded-full bg-white shadow-sm md:size-[16px]',
          'transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]',
          checked ? 'translate-x-5 md:translate-x-[14px]' : 'translate-x-0',
        )}
      />
    </button>
  )
}


/** What each key a roving radio group answers to does to the selection. */
const ROVING_RADIO_MOTIONS: Record<string, 'next' | 'previous' | 'first' | 'last'> = {
  ArrowRight: 'next',
  ArrowDown: 'next',
  ArrowLeft: 'previous',
  ArrowUp: 'previous',
  Home: 'first',
  End: 'last',
}

/**
 * The tab order and arrow-key behaviour a `role="radiogroup"` of hand-drawn radios has to provide for
 * itself: one stop in the tab sequence (the selected radio, or the first when nothing is selected),
 * and the arrows that move the selection while keeping focus on what was just selected.
 *
 * A native radio group gets all of this from the browser, but a native radio cannot be drawn as the
 * shapes these groups wear — the segmented control's pill and a settings card holding a badge, a
 * status line and a configuration panel. So the two implementations share this one rather than each
 * writing the same stepping again.
 *
 * `values` is the group's options in visual order, `value` the selected one, and `onSelect` what
 * applies a choice; the caller writes the returned handlers onto each radio element it renders.
 */
export function useRovingRadio<T extends string>(
  values: readonly T[],
  value: T,
  onSelect: (value: T) => void,
): {
  setItemRef: (index: number) => (element: HTMLButtonElement | null) => void
  tabIndexFor: (index: number) => 0 | -1
  keyHandlerFor: (index: number) => (event: ReactKeyboardEvent<HTMLButtonElement>) => void
} {
  const itemsRef = useRef<Array<HTMLButtonElement | null>>([])
  const hasSelection = values.includes(value)
  return {
    setItemRef: (index) => (element) => {
      itemsRef.current[index] = element
    },
    // Only the selected radio is a tab stop, so one Tab lands the user on the group's current answer
    // and the arrows take it from there — the pattern the radiogroup role tells a screen reader to expect.
    tabIndexFor: (index) => (values[index] === value || (!hasSelection && index === 0) ? 0 : -1),
    keyHandlerFor:
      (index) => (event) => {
        const motion = ROVING_RADIO_MOTIONS[event.key]
        if (!motion || values.length === 0) return
        event.preventDefault()
        const last = values.length - 1
        let next = index
        if (motion === 'next') next = index >= last ? 0 : index + 1
        else if (motion === 'previous') next = index <= 0 ? last : index - 1
        else if (motion === 'first') next = 0
        else next = last
        const selected = values[next]!
        onSelect(selected)
        itemsRef.current[next]?.focus()
      },
  }
}

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  title?: string
  combo?: string
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  disabled = false,
  className,
  label,
  id,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-required': ariaRequired,
}: {
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  size?: 'sm' | 'md'
  disabled?: boolean
  className?: string
  label?: string
  id?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
  'aria-required'?: boolean
}) {
  const roving = useRovingRadio<T>(
    options.map((option) => option.value),
    value,
    onChange,
  )
  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={label}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      aria-required={ariaRequired}
      aria-disabled={disabled || undefined}
      className={cn(
        'relative inline-flex items-center gap-0.5 rounded-[var(--r-md)] bg-[var(--bg-inset)] p-[3px]',
        'border border-[var(--border-subtle)]',
        className,
      )}
    >
      {options.map((option, index) => {
        const active = option.value === value
        const button = (
          <button
            ref={roving.setItemRef(index)}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.title}
            disabled={disabled}
            tabIndex={roving.tabIndexFor(index)}
            onClick={() => onChange(option.value)}
            onKeyDown={roving.keyHandlerFor(index)}
            className={cn(
              'relative z-10 inline-flex items-center justify-center gap-1.5 rounded-[var(--r-sm)] font-medium',
              'transition-[color,background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
              'disabled:pointer-events-none disabled:opacity-45',
              size === 'sm' ? 'h-8 px-2.5 text-[length:var(--text-11-5)] md:h-[22px] md:px-2' : 'h-9 px-3 text-[length:var(--text-12-5)] md:h-[26px] md:px-2.5',
              active
                ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-[0_1px_2px_rgba(0,0,0,.10)]'
                : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
            )}
          >
            {option.label}
          </button>
        )
        return option.title ? (
          <Tooltip key={option.value} label={option.title} combo={option.combo}>
            {button}
          </Tooltip>
        ) : (
          <span key={option.value} className="contents">{button}</span>
        )
      })}
    </div>
  )
}


export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
  className,
  label,
  id,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-required': ariaRequired,
  immediate = false,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  suffix?: string
  className?: string
  label?: string
  id?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
  'aria-required'?: boolean
  /**
   * Hand every step straight to the caller instead of coalescing to one write per frame. For a caller
   * that batches on its own — the gantt's progress bar holds a draft and commits one undo step on
   * release — the coalescing would swallow the last value, because its own commit runs in the same
   * event, before the frame that would have delivered it.
   */
  immediate?: boolean
}) {
  const [draft, setDraft] = useState<number | null>(null)
  const pending = useRef(value)
  const frame = useRef(0)
  // An immediate slider has no draft of its own: the caller's `value` is the only answer, and a local
  // copy would go stale the moment the caller batches and settles on something else.
  const shown = immediate ? value : draft ?? value
  const range = max - min
  const rawPct = range > 0 && Number.isFinite(shown) ? ((shown - min) / range) * 100 : 0
  const pct = Math.min(100, Math.max(0, rawPct))
  const commit = () => {
    if (!frame.current) return
    cancelAnimationFrame(frame.current)
    frame.current = 0
    onChange(pending.current)
    setDraft(null)
  }
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <input
        id={id}
        type="range"
        aria-label={label}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        aria-required={ariaRequired}
        aria-valuetext={`${shown}${suffix ?? ''}`}
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(e) => {
          const next = Number(e.target.value)
          if (immediate) {
            onChange(next)
            return
          }
          pending.current = next
          setDraft(next)
          if (frame.current) return
          frame.current = requestAnimationFrame(() => {
            frame.current = 0
            onChange(pending.current)
          })
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="ink-slider h-[18px] flex-1 cursor-pointer appearance-none bg-transparent"
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
      />
      <span className="w-11 shrink-0 text-right text-[length:var(--text-12)] tabular text-[var(--text-tertiary)]">
        {shown}
        {suffix}
      </span>
    </div>
  )
}


export function Field({
  label,
  hint,
  children,
  className,
  required,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
  className?: string
  required?: boolean
}) {
  const id = useId()
  const labelId = `${id}-label`
  const hintId = hint ? `${id}-hint` : undefined
  let controlId = `${id}-control`
  let control = children
  if (isValidElement<{
    id?: string
    'aria-labelledby'?: string
    'aria-describedby'?: string
    'aria-required'?: boolean
  }>(children)) {
    controlId = children.props.id ?? controlId
    const existingDescription = children.props['aria-describedby']
    control = cloneElement(children, {
      id: controlId,
      'aria-labelledby': children.props['aria-labelledby'] ?? labelId,
      'aria-describedby': [existingDescription, hintId].filter(Boolean).join(' ') || undefined,
      'aria-required': children.props['aria-required'] ?? (required || undefined),
    })
  }
  return (
    <div className={cn('space-y-1.5', className)}>
      <label id={labelId} htmlFor={controlId} className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
        {label}
        {required && <span aria-hidden="true" className="ml-0.5 text-[var(--danger)]">*</span>}
      </label>
      <div>{control}</div>
      {hint && <p id={hintId} className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">{hint}</p>}
    </div>
  )
}

export function SettingRow({
  title,
  description,
  children,
  className,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div
      data-setting-title={title}
      className={cn(
        'setting-row flex flex-col items-stretch justify-between gap-2 py-3 md:flex-row md:items-center md:gap-6',
        'border-b border-[var(--border-subtle)] last:border-b-0',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{title}</div>
        {description && (
          <div className="mt-0.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
            {description}
          </div>
        )}
      </div>
      <div className="min-w-0 shrink-0">{children}</div>
    </div>
  )
}


export function Checkbox({
  checked,
  onChange,
  label,
  className,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label?: ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn('inline-flex min-h-10 items-center gap-2 text-[length:var(--text-13)] md:min-h-0', className)}
    >
      <span
        className={cn(
          'inline-flex size-[15px] shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-[var(--dur-fast)]',
          checked
            ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]'
            : 'border-[var(--border-strong)] bg-[var(--bg-inset)]',
        )}
      >
        {checked && <Check size={11} strokeWidth={3} />}
      </span>
      {label && <span className="text-[var(--text-secondary)]">{label}</span>}
    </button>
  )
}
