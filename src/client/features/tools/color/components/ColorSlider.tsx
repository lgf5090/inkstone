import { useId } from 'react'
import { cn } from '../../../../lib/cn'

export interface ColorSliderProps {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  unit?: string
  gradient: string
  onChange: (val: number) => void
  disabled?: boolean
  className?: string
}

export function ColorSlider({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  unit = '',
  gradient,
  onChange,
  disabled = false,
  className,
}: ColorSliderProps) {
  const id = useId()

  return (
    <div className={cn('flex flex-col gap-1 w-full', className)}>
      <div className="flex items-center justify-between text-[length:var(--text-12)] text-[var(--text-secondary)]">
        <label htmlFor={id} className="font-medium select-none">
          {label}
        </label>
        <span className="font-mono text-[var(--text-primary)] font-medium">
          {Math.round(value)}
          {unit}
        </span>
      </div>
      <div className="relative flex items-center h-6 w-full">
        {/* Track with custom gradient */}
        <div
          style={{ background: gradient }}
          className="absolute inset-x-0 h-3 rounded-full border border-[var(--border-subtle)] shadow-inner pointer-events-none"
        />
        {/* Semantic range input */}
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          className={cn(
            'relative z-10 w-full h-6 appearance-none bg-transparent cursor-pointer',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded-full',
            '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5',
            '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white',
            '[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[var(--border-strong)]',
            '[&::-webkit-slider-thumb]:shadow-[0_1px_4px_rgba(0,0,0,0.3)]',
            '[&::-webkit-slider-thumb]:hover:scale-110 [&::-webkit-slider-thumb]:transition-transform',
            '[&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:rounded-full',
            '[&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-[var(--border-strong)]',
            '[&::-moz-range-thumb]:shadow-[0_1px_4px_rgba(0,0,0,0.3)]',
          )}
        />
      </div>
    </div>
  )
}
