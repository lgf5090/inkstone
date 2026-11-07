/**
 * Appearance is one dialog because every field writes the same localStorage record: a site label,
 * the paper behind the terminal, how far the surface is inset, and a colour overlay for the palette the
 * reader already chose. The colour file carries only that overlay, so importing it cannot replace a
 * background image or a site name.
 */
import { useRef, type ChangeEvent } from 'react'
import { Download, ImagePlus, RotateCcw, Trash2, Upload } from 'lucide-react'
import { Button, IconButton } from '../../components/primitives'
import { Field, Input, Slider } from '../../components/form'
import { ColorWellField } from '../../components/color-field'
import { Modal, confirm } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { downloadTextFile } from '../../lib/export-note'
import {
  DEFAULT_APPEARANCE,
  LAYOUT_SPACING_MAX,
  MAX_BACKGROUND_BYTES,
  SITE_NAME_MAX_LENGTH,
  SURFACE_OPACITY_MIN,
  exportTerminalColors,
  isValidBackground,
  parseTerminalColorsFile,
  type TerminalColorKey,
  type WebsshAppearance,
} from './appearance'

const COLOR_LABEL: Record<TerminalColorKey, 'webssh.appearance.color_background' | 'webssh.appearance.color_foreground' | 'webssh.appearance.color_cursor' | 'webssh.appearance.color_selection'> = {
  background: 'webssh.appearance.color_background',
  foreground: 'webssh.appearance.color_foreground',
  cursor: 'webssh.appearance.color_cursor',
  selectionBackground: 'webssh.appearance.color_selection',
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsText(file)
  })
}

function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

export function AppearanceSettingsDialog({
  open,
  onClose,
  settings,
  onChange,
}: {
  open: boolean
  onClose: () => void
  settings: WebsshAppearance
  onChange: (next: WebsshAppearance) => void
}) {
  const backgroundRef = useRef<HTMLInputElement | null>(null)
  const colorsRef = useRef<HTMLInputElement | null>(null)
  const toast = (title: string, tone: 'success' | 'warning' | 'danger' = 'success') => {
    useUi.getState().toast({ title, tone })
  }

  const takeBackground = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!IMAGE_TYPES.includes(file.type) || file.size > MAX_BACKGROUND_BYTES) {
      toast(t('webssh.appearance.background_invalid'), 'warning')
      return
    }
    try {
      const background = await readImageFile(file)
      if (!isValidBackground(background)) {
        toast(t('webssh.appearance.background_invalid'), 'warning')
        return
      }
      onChange({
        ...settings,
        background,
        surfaceOpacity: settings.surfaceOpacity >= 1 ? 0.85 : settings.surfaceOpacity,
      })
    } catch {
      toast(t('webssh.appearance.background_failed'), 'danger')
    }
  }

  const takeColors = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const colors = parseTerminalColorsFile(await readTextFile(file))
      if (!colors) {
        toast(t('webssh.appearance.colors_invalid'), 'warning')
        return
      }
      onChange({ ...settings, terminalColors: colors })
      toast(t('webssh.appearance.colors_imported'), 'success')
    } catch {
      toast(t('webssh.appearance.colors_invalid'), 'warning')
    }
  }

  const resetAll = async () => {
    const approved = await confirm({
      title: t('webssh.appearance.reset_title'),
      description: t('webssh.appearance.reset_description'),
      confirmLabel: t('webssh.appearance.reset'),
      tone: 'danger',
    })
    if (!approved) return
    onChange({ ...DEFAULT_APPEARANCE })
  }

  const setColor = (key: TerminalColorKey, value: string | null) => {
    const next = { ...settings.terminalColors }
    if (value) next[key] = value
    else delete next[key]
    onChange({ ...settings, terminalColors: next })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('webssh.appearance.title')}
      description={t('webssh.appearance.description')}
      width={520}
      footer={
        <>
          <Button variant="ghost" icon={<RotateCcw size={13} aria-hidden="true" />} onClick={() => void resetAll()}>
            {t('webssh.appearance.reset')}
          </Button>
          <Button onClick={onClose}>{t('common.close')}</Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label={t('webssh.appearance.site_name')} hint={t('webssh.appearance.site_name_hint')}>
          <Input
            value={settings.siteName}
            maxLength={SITE_NAME_MAX_LENGTH}
            placeholder={t('webssh.app.title')}
            onChange={(event) => onChange({ ...settings, siteName: event.target.value })}
          />
        </Field>

        <Field label={t('webssh.appearance.background')} hint={t('webssh.appearance.background_hint')}>
          <div className="space-y-2">
            {settings.background && (
              <div
                className="h-20 w-full rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] bg-cover bg-center"
                style={{ backgroundImage: `url("${settings.background}")` }}
                role="img"
                aria-label={t('webssh.appearance.background_preview')}
              />
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" icon={<ImagePlus size={13} aria-hidden="true" />} onClick={() => backgroundRef.current?.click()}>
                {settings.background ? t('webssh.appearance.background_replace') : t('webssh.appearance.background_choose')}
              </Button>
              {settings.background && (
                <Button size="sm" variant="ghost" icon={<Trash2 size={13} aria-hidden="true" />} onClick={() => onChange({ ...settings, background: null })}>
                  {t('webssh.appearance.background_remove')}
                </Button>
              )}
            </div>
            <input ref={backgroundRef} type="file" accept={IMAGE_TYPES.join(',')} hidden onChange={(event) => void takeBackground(event)} />
          </div>
        </Field>

        <Field label={t('webssh.appearance.opacity')} hint={t('webssh.appearance.opacity_hint')}>
          <Slider
            value={Math.round(settings.surfaceOpacity * 100)}
            min={Math.round(SURFACE_OPACITY_MIN * 100)}
            max={100}
            onChange={(value) => onChange({ ...settings, surfaceOpacity: value / 100 })}
            label={t('webssh.appearance.opacity')}
            suffix="%"
            immediate
          />
        </Field>

        <Field label={t('webssh.appearance.spacing')} hint={t('webssh.appearance.spacing_hint')}>
          <Slider
            value={settings.spacing}
            min={0}
            max={LAYOUT_SPACING_MAX}
            onChange={(spacing) => onChange({ ...settings, spacing })}
            label={t('webssh.appearance.spacing')}
            suffix="px"
            immediate
          />
        </Field>

        <div className="space-y-2">
          <h3 className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('webssh.appearance.colors')}</h3>
          {(Object.keys(COLOR_LABEL) as TerminalColorKey[]).map((key) => (
            <div key={key} className="flex items-center justify-between gap-3">
              <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t(COLOR_LABEL[key])}</span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
                  {settings.terminalColors[key] ?? t('webssh.appearance.color_unset')}
                </span>
                <ColorWellField value={settings.terminalColors[key] ?? null} label={t(COLOR_LABEL[key])} onChange={(value) => setColor(key, value)} />
                {settings.terminalColors[key] && (
                  <IconButton label={t('webssh.appearance.color_reset')} size="xs" onClick={() => setColor(key, null)}>
                    <RotateCcw size={12} aria-hidden="true" />
                  </IconButton>
                )}
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              size="sm"
              variant="secondary"
              icon={<Download size={13} aria-hidden="true" />}
              disabled={Object.keys(settings.terminalColors).length === 0}
              onClick={() => downloadTextFile('inkstone-terminal-colors.json', exportTerminalColors(settings.terminalColors), 'application/json')}
            >
              {t('webssh.appearance.colors_export')}
            </Button>
            <Button size="sm" variant="secondary" icon={<Upload size={13} aria-hidden="true" />} onClick={() => colorsRef.current?.click()}>
              {t('webssh.appearance.colors_import')}
            </Button>
            <input ref={colorsRef} type="file" accept="application/json,.json" hidden onChange={(event) => void takeColors(event)} />
          </div>
        </div>
      </div>
    </Modal>
  )
}
