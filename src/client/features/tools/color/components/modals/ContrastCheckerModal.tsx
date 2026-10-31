import { useEffect, useState } from 'react'
import { ArrowLeftRight, CheckCircle2, XCircle } from 'lucide-react'
import { evaluateWcagContrast } from '@shared/tools/color/a11y'
import { DEFAULT_SEED_HEX } from '@shared/tools/color/contract'
import { Modal } from '../../../../../components/overlay'
import { Button } from '../../../../../components/primitives'
import { Field, Input } from '../../../../../components/form'
import { ColorWellField } from '../../../../../components/color-field'
import { t } from '../../../../../lib/i18n'
import { useColorStudioStore } from '../../store'
import { parseHexInput } from '../../lib/hex-input'

/**
 * One of the two color slots.
 *
 * The box keeps what the reader typed rather than a normalized color, because the old version fed every
 * keystroke through `normalizeHex`, which answers an unreadable value with `#000000` — so a typo was
 * scored as a 21:1 pass and reported as WCAG AAA.
 */
function ColorSlot({
  label,
  value,
  onChange,
  presets,
  onUseCurrent,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  presets: Array<{ key: string; label: string; hex: string }>
  onUseCurrent: () => void
}) {
  const parsed = parseHexInput(value)

  return (
    <Field label={label} hint={parsed === null ? t('tools.color.contrast.invalid') : undefined}>
      <div className="flex items-center gap-2">
        <ColorWellField value={parsed} label={label} onChange={onChange} />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          aria-invalid={parsed === null || undefined}
          maxLength={7}
          className="min-w-0 flex-1 font-mono text-[length:var(--text-13)] uppercase"
        />
      </div>
      <div className="mt-2 flex gap-1.5">
        {presets.map((preset) => (
          <button
            key={preset.key}
            type="button"
            onClick={() => onChange(preset.hex)}
            className="rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 text-[length:var(--text-11)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          onClick={onUseCurrent}
          className="rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 text-[length:var(--text-11)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        >
          {t('tools.color.common.current_hex')}
        </button>
      </div>
    </Field>
  )
}

export function ContrastCheckerModal() {
  const isOpen = useColorStudioStore((s) => s.isContrastModalOpen)
  const onClose = useColorStudioStore((s) => s.closeContrastModal)
  const currentHex = useColorStudioStore((s) => s.currentHex)

  const [fg, setFg] = useState('#ffffff')
  const [bg, setBg] = useState(DEFAULT_SEED_HEX)

  // The modal is mounted for the life of the app, so a value taken once at mount was the color the studio
  // booted with — opening the checker after picking something compared that earlier color instead.
  useEffect(() => {
    if (!isOpen) return
    setBg(currentHex)
  }, [isOpen, currentHex])

  // Every hook above still has to run, but the WCAG evaluation below is pure waste while closed.
  if (!isOpen) return null

  const fgParsed = parseHexInput(fg)
  const bgParsed = parseHexInput(bg)
  const bothValid = fgParsed !== null && bgParsed !== null
  const result = bothValid ? evaluateWcagContrast(fgParsed ?? '#000000', bgParsed ?? '#000000') : null

  const handleSwap = () => {
    setFg(bg)
    setBg(fg)
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={t('tools.color.contrast.title')}
      width={640}
      footer={
        <div className="flex w-full items-center justify-end">
          <Button size="sm" variant="primary" onClick={onClose}>
            {t('tools.color.common.done')}
          </Button>
        </div>
      }
    >
      <div className="space-y-6">
        <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-[1fr_auto_1fr]">
          <ColorSlot
            label={t('tools.color.contrast.foreground')}
            value={fg}
            onChange={setFg}
            presets={[
              { key: 'white', label: t('tools.color.common.white'), hex: '#ffffff' },
              { key: 'black', label: t('tools.color.common.black'), hex: '#000000' },
            ]}
            onUseCurrent={() => setFg(currentHex)}
          />

          <button
            type="button"
            onClick={handleSwap}
            className="mt-6 flex h-9 w-9 items-center justify-center self-start rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
            title={t('tools.color.contrast.swap_tooltip')}
            aria-label={t('tools.color.contrast.swap_aria')}
          >
            <ArrowLeftRight size={14} />
          </button>

          <ColorSlot
            label={t('tools.color.contrast.background')}
            value={bg}
            onChange={setBg}
            presets={[
              { key: 'white', label: t('tools.color.common.white'), hex: '#ffffff' },
              { key: 'dark', label: t('tools.color.common.dark'), hex: '#18181b' },
            ]}
            onUseCurrent={() => setBg(currentHex)}
          />
        </div>

        {!result ? (
          <p
            role="status"
            className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4 text-center text-[length:var(--text-13)] text-[var(--text-secondary)]"
          >
            {t('tools.color.contrast.need_both')}
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 shadow-xs">
              <div>
                <span className="text-[length:var(--text-12)] font-semibold uppercase text-[var(--text-secondary)]">
                  {t('tools.color.contrast.ratio')}
                </span>
                <p
                  data-testid="contrast-ratio"
                  className="font-mono text-[length:var(--text-30)] font-bold text-[var(--text-primary)]"
                >
                  {result.ratio} {': 1'}
                </p>
              </div>
              <div
                className={`flex items-center rounded-full border px-4 py-2 text-[length:var(--text-16)] font-bold ${
                  result.score === 'AAA'
                    ? 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--success)]'
                    : result.score === 'AA'
                      ? 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--warning)]'
                      : 'border-[var(--danger-soft)] bg-[var(--danger-soft)] text-[var(--danger)]'
                }`}
              >
                {result.score === 'Fail' ? 'Fail' : `WCAG ${result.score}`}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2.5">
              <Criterion
                title={t('tools.color.contrast.normal_text')}
                rows={[
                  ['AA (≥ 4.5:1)', result.normalAa],
                  ['AAA (≥ 7.0:1)', result.normalAaa],
                ]}
              />
              <Criterion
                title={t('tools.color.contrast.large_text')}
                rows={[
                  ['AA (≥ 3.0:1)', result.largeAa],
                  ['AAA (≥ 4.5:1)', result.largeAaa],
                ]}
              />
              <Criterion
                title={t('tools.color.contrast.ui_components')}
                rows={[['AA (≥ 3.0:1)', result.uiComponents]]}
              />
            </div>

            <div
              className="rounded-[var(--r-lg)] border border-black/10 p-5 shadow-inner"
              style={{ backgroundColor: bgParsed ?? '#000000', color: fgParsed ?? '#000000' }}
            >
              <h4 className="text-[length:var(--text-18)] font-bold">
                {t('tools.color.contrast.heading_preview')}
              </h4>
              <p className="mt-2 text-[length:var(--text-14)] leading-relaxed opacity-95">
                {t('tools.color.contrast.body_preview')}
              </p>
              <span
                aria-hidden="true"
                className="mt-4 inline-block rounded-[var(--r-sm)] border px-3.5 py-1.5 text-[length:var(--text-13)] font-semibold"
                style={{ borderColor: fgParsed ?? '#000000' }}
              >
                {t('tools.color.contrast.button_preview')}
              </span>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

/** One WCAG band, with the thresholds quoted because they are notation rather than interface copy. */
function Criterion({ title, rows }: { title: string; rows: Array<[string, boolean]> }) {
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
      <span className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">{title}</span>
      <div className="mt-2 space-y-1 text-[length:var(--text-11)]">
        {rows.map(([label, passes]) => (
          <div key={label} className="flex items-center justify-between">
            <span>{label}</span>
            {passes ? (
              <CheckCircle2 size={14} className="text-[var(--success)]" aria-label={t('tools.color.contrast.pass')} />
            ) : (
              <XCircle size={14} className="text-[var(--danger)]" aria-label={t('tools.color.contrast.fail')} />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
