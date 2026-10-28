import { useState } from 'react'
import { ORGANIZER_COLORS } from '@shared/organizer-colors'
import { t } from '../../../../lib/i18n'
import { Input } from '../../../../components/form'
import { Swatch } from '../../../../components/color-swatch'
import { ColorWellField } from '../../../../components/color-field'
import { Button } from '../../../../components/primitives'

const HEX = /^#[0-9a-fA-F]{6}$/

export function TagColorPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState(false)
  const commit = (next: string) => {
    setDraft(next)
    const valid = HEX.test(next)
    setError(!valid)
    if (valid) onChange(next.toLowerCase())
  }
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-8 gap-1.5" role="group" aria-label={t('development.github.tags.built_in_colors')}>
        {ORGANIZER_COLORS.map((color) => (
          <Swatch
            key={color}
            color={color}
            label={color}
            active={value.toLowerCase() === color}
            onPick={() => {
              setDraft(color)
              onChange(color)
            }}
            size="sm"
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <ColorWellField
          value={value}
          label={t('development.github.tags.custom_color_value')}
          onChange={(next) => {
            setDraft(next)
            onChange(next)
          }}
        />
        <Input
          value={draft}
          onChange={(event) => commit(event.target.value)}
          placeholder="#rrggbb"
          aria-label={t('development.github.tags.custom_color_value')}
          className="h-8 font-mono text-[length:var(--text-12)]"
        />
        <Button variant="ghost" size="sm" onClick={() => { setDraft('#64748b'); setError(false); onChange('#64748b') }}>
          {t('common.clear')}
        </Button>
      </div>
      {error && <p role="alert" className="text-[length:var(--text-10-5)] text-[var(--danger)]">{t('development.github.tags.invalid_color')}</p>}
    </div>
  )
}
