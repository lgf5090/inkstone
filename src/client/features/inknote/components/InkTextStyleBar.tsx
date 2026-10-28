/** The style bar over the open text box: every field the page model stores for a TextBox. */
import { useState } from 'react'
import { AlignCenter, AlignLeft, AlignRight, Bold, Highlighter, Italic, List, ListOrdered, Save, Underline } from 'lucide-react'
import type { InknoteTextPreset, InknoteTextBox } from '@shared/inknote/types'
import { HIGHLIGHTER_COLORS, PEN_COLORS } from '@shared/inknote/constants'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { IconButton } from '../../../components/primitives'
import { prompt } from '../../../components/overlay'
import { Select } from '../../../components/form'

const SIZES = [18, 26, 34] as const
const LINE_HEIGHTS = [1.1, 1.3, 1.6] as const

interface Props {
  item: InknoteTextBox
  presets: InknoteTextPreset[]
  onChange: (patch: Partial<InknoteTextBox>) => void
  onSavePreset: (name: string) => void
}

/** A swatch row the bar scrolls sideways on a narrow page rather than growing tall. */
function Swatches({ colors, value, label, onPick }: { colors: readonly string[]; value: string | null; label: string; onPick: (color: string | null) => void }) {
  return (
    <div className="flex shrink-0 items-center gap-1" role="group" aria-label={label}>
      {colors.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={color}
          aria-pressed={(value ?? '').toLowerCase() === color.toLowerCase()}
          onClick={() => onPick(value?.toLowerCase() === color.toLowerCase() ? null : color)}
          className={cn('size-5 rounded-full ring-1 ring-[var(--border-default)]', (value ?? '').toLowerCase() === color.toLowerCase() && 'ring-2 ring-[var(--accent)]')}
          style={{ background: color }}
        />
      ))}
      <button type="button" aria-label={t('inknote.text.no_color')} aria-pressed={value === null} onClick={() => onPick(null)} className={cn('size-5 rounded-full border border-dashed border-[var(--border-default)] text-[length:var(--text-10)] text-[var(--text-tertiary)]', value === null && 'border-[var(--accent)] text-[var(--accent)]')}>×</button>
    </div>
  )
}

export function InkTextStyleBar({ item, presets, onChange, onSavePreset }: Props) {
  const [palette, setPalette] = useState<'text' | 'highlight' | null>(null)
  return (
    <div data-ink-text-style="" onMouseDown={(event) => {
      // A pressed button must not take focus from the textarea: blur would commit the edit before
      // the style is applied. The preset select is the one control that needs the focus itself.
      if (!(event.target as HTMLElement).closest('select, input')) event.preventDefault()
    }} className="absolute left-1/2 top-2 z-[calc(var(--z-float)+2)] flex max-w-[calc(100%-16px)] -translate-x-1/2 flex-wrap items-center gap-0.5 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 shadow-[var(--shadow-pop)]" role="toolbar" aria-label={t('inknote.text.style')}>
      <IconButton label={t('inknote.text.bold')} size="sm" active={item.bold} onClick={() => onChange({ bold: !item.bold })}><Bold size={14}/></IconButton>
      <IconButton label={t('inknote.text.italic')} size="sm" active={item.italic} onClick={() => onChange({ italic: !item.italic })}><Italic size={14}/></IconButton>
      <IconButton label={t('inknote.text.underline')} size="sm" active={item.underline} onClick={() => onChange({ underline: !item.underline })}><Underline size={14}/></IconButton>
      <span className="mx-0.5 h-5 w-px shrink-0 bg-[var(--border-subtle)]" />
      {SIZES.map((size) => (
        <button key={size} type="button" aria-label={`${size}`} aria-pressed={item.fontSize === size} onClick={() => onChange({ fontSize: size })} className={cn('h-7 min-w-7 shrink-0 rounded-[var(--r-xs)] px-1 text-[length:var(--text-11)]', item.fontSize === size ? 'bg-[var(--bg-active)] text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]')}>{size}</button>
      ))}
      <span className="mx-0.5 h-5 w-px shrink-0 bg-[var(--border-subtle)]" />
      <button type="button" aria-label={t('inknote.text.color')} aria-pressed={palette === 'text'} onClick={() => setPalette(palette === 'text' ? null : 'text')} className="flex size-7 shrink-0 items-center justify-center rounded-[var(--r-xs)] hover:bg-[var(--bg-hover)]">
        <span className="size-4 rounded-full ring-1 ring-[var(--border-default)]" style={{ background: item.color }}/>
      </button>
      <IconButton label={t('inknote.text.highlight')} size="sm" active={palette === 'highlight'} onClick={() => setPalette(palette === 'highlight' ? null : 'highlight')}><Highlighter size={14}/></IconButton>
      <span className="mx-0.5 h-5 w-px shrink-0 bg-[var(--border-subtle)]" />
      <IconButton label={t('inknote.text.align_left')} size="sm" active={item.align === 'left'} onClick={() => onChange({ align: 'left' })}><AlignLeft size={14}/></IconButton>
      <IconButton label={t('inknote.text.align_center')} size="sm" active={item.align === 'center'} onClick={() => onChange({ align: 'center' })}><AlignCenter size={14}/></IconButton>
      <IconButton label={t('inknote.text.align_right')} size="sm" active={item.align === 'right'} onClick={() => onChange({ align: 'right' })}><AlignRight size={14}/></IconButton>
      {LINE_HEIGHTS.map((lh) => (
        <button key={lh} type="button" aria-label={t('inknote.text.line_height', { value: String(lh) })} aria-pressed={item.lh === lh} onClick={() => onChange({ lh })} className={cn('h-7 shrink-0 rounded-[var(--r-xs)] px-1 text-[length:var(--text-10-5)]', item.lh === lh ? 'bg-[var(--bg-active)] text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]')}>{lh}</button>
      ))}
      <IconButton label={t('inknote.text.bullet')} size="sm" active={item.list === 'bullet'} onClick={() => onChange({ list: item.list === 'bullet' ? null : 'bullet' })}><List size={14}/></IconButton>
      <IconButton label={t('inknote.text.numbered')} size="sm" active={item.list === 'number'} onClick={() => onChange({ list: item.list === 'number' ? null : 'number' })}><ListOrdered size={14}/></IconButton>
      {presets.length > 0 && (
        <Select aria-label={t('inknote.text.presets')} value="" onChange={(event) => {
          const preset = presets.find((entry) => entry.name === event.target.value)
          if (preset) onChange({ fontSize: preset.fontSize, bold: preset.bold, italic: preset.italic, underline: preset.underline })
        }} className="h-7 w-28 shrink-0 text-[length:var(--text-11)]">
          <option value="">{t('inknote.text.presets')}</option>
          {presets.map((preset) => <option key={preset.name} value={preset.name}>{preset.name}</option>)}
        </Select>
      )}
      <IconButton label={t('inknote.text.save_preset')} size="sm" onClick={() => void prompt({ title: t('inknote.text.preset_name') }).then((name) => {
        if (name?.trim()) onSavePreset(name.trim().slice(0, 40))
      })}><Save size={14}/></IconButton>
      {palette === 'text' && (
        <div className="absolute left-2 top-full mt-1 flex items-center gap-1 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1.5 shadow-[var(--shadow-pop)]">
          <Swatches colors={PEN_COLORS.slice(0, 8)} value={item.color} label={t('inknote.text.color')} onPick={(color) => { if (color) onChange({ color }) }}/>
        </div>
      )}
      {palette === 'highlight' && (
        <div className="absolute left-2 top-full mt-1 flex items-center gap-1 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1.5 shadow-[var(--shadow-pop)]">
          <Swatches colors={HIGHLIGHTER_COLORS.slice(0, 8)} value={item.hl} label={t('inknote.text.highlight')} onPick={(color) => onChange({ hl: color })}/>
        </div>
      )}
    </div>
  )
}
