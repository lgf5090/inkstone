/**
 * The row of keys a phone keyboard cannot give a terminal: Ctrl, Esc, Tab, arrows and the editing
 * keys. It sends bytes through xterm's own `input()` so the transport sees exactly what a hardware
 * keypress would have produced.
 */
import { useState } from 'react'
import { t } from '../../lib/i18n'
import type { MessageKey } from '@shared/locales/en-US'
import { Button } from '../../components/primitives'
import { cn } from '../../lib/cn'

interface MobileKey {
  id: string
  /** Drawn on the key. */
  label: string
  /** Bytes sent when the key is pressed without a modifier. */
  sequence: string
  /** Accessible name, kept as a key so it is translated with the rest of the interface. */
  nameKey: MessageKey
}

const KEYS: readonly MobileKey[] = [
  { id: 'esc', label: 'Esc', sequence: '\x1b', nameKey: 'webssh.mobile.esc' },
  { id: 'tab', label: 'Tab', sequence: '\t', nameKey: 'webssh.mobile.tab' },
  { id: 'c', label: 'C', sequence: 'c', nameKey: 'webssh.mobile.c' },
  { id: 'd', label: 'D', sequence: 'd', nameKey: 'webssh.mobile.d' },
  { id: 'r', label: 'R', sequence: 'r', nameKey: 'webssh.mobile.r' },
  { id: 'l', label: 'L', sequence: 'l', nameKey: 'webssh.mobile.l' },
  { id: 'z', label: 'Z', sequence: 'z', nameKey: 'webssh.mobile.z' },
  { id: 'up', label: '↑', sequence: '\x1b[A', nameKey: 'webssh.mobile.up' },
  { id: 'down', label: '↓', sequence: '\x1b[B', nameKey: 'webssh.mobile.down' },
  { id: 'left', label: '←', sequence: '\x1b[D', nameKey: 'webssh.mobile.left' },
  { id: 'right', label: '→', sequence: '\x1b[C', nameKey: 'webssh.mobile.right' },
  { id: 'home', label: 'Home', sequence: '\x1b[H', nameKey: 'webssh.mobile.home' },
  { id: 'end', label: 'End', sequence: '\x1b[F', nameKey: 'webssh.mobile.end' },
  { id: 'pageup', label: 'PgUp', sequence: '\x1b[5~', nameKey: 'webssh.mobile.page_up' },
  { id: 'pagedown', label: 'PgDn', sequence: '\x1b[6~', nameKey: 'webssh.mobile.page_down' },
  { id: 'delete', label: 'Del', sequence: '\x1b[3~', nameKey: 'webssh.mobile.delete' },
  { id: 'enter', label: '↵', sequence: '\r', nameKey: 'webssh.mobile.enter' },
  { id: 'backspace', label: '⌫', sequence: '\x7f', nameKey: 'webssh.mobile.backspace' },
  { id: 'pipe', label: '|', sequence: '|', nameKey: 'webssh.mobile.pipe' },
  { id: 'dash', label: '-', sequence: '-', nameKey: 'webssh.mobile.dash' },
  { id: 'slash', label: '/', sequence: '/', nameKey: 'webssh.mobile.slash' },
  { id: 'tilde', label: '~', sequence: '~', nameKey: 'webssh.mobile.tilde' },
]

/** Ctrl is a one-shot modifier: the letter it prefixes becomes the control byte, then it clears. */
export function applyControlModifier(sequence: string): string {
  const letter = sequence.length === 1 ? sequence.toUpperCase() : ''
  const code = letter.charCodeAt(0)
  if (code >= 65 && code <= 90) return String.fromCharCode(code - 64)
  return sequence
}

const CTRL_ALT_ARROWS: Record<string, string> = {
  '\x1b[A': '\x1b[1;7A',
  '\x1b[B': '\x1b[1;7B',
  '\x1b[C': '\x1b[1;7C',
  '\x1b[D': '\x1b[1;7D',
  '\x1b[H': '\x1b[1;7H',
  '\x1b[F': '\x1b[1;7F',
}

/** Alt is one-shot too: a terminal reads it as the ESC prefix, and Ctrl+Alt has its own arrow form. */
export function applyAltModifier(sequence: string): string {
  return `\x1b${sequence}`
}

export function applyModifiers(sequence: string, ctrl: boolean, alt: boolean): string {
  if (ctrl && alt) {
    const arrow = CTRL_ALT_ARROWS[sequence]
    if (arrow) return arrow
    return `\x1b${applyControlModifier(sequence)}`
  }
  if (ctrl) return applyControlModifier(sequence)
  if (alt) return applyAltModifier(sequence)
  return sequence
}

export function MobileKeyBar({
  onKey,
  disabled,
  className,
}: {
  onKey: (data: string) => void
  disabled?: boolean
  className?: string
}) {
  const [ctrl, setCtrl] = useState(false)
  const [alt, setAlt] = useState(false)
  const press = (key: MobileKey) => {
    onKey(applyModifiers(key.sequence, ctrl, alt))
    setCtrl(false)
    setAlt(false)
  }
  return (
    <div
      role="group"
      aria-label={t('webssh.mobile.label')}
      className={cn(
        'flex max-w-full shrink-0 flex-wrap items-center gap-1 border-t border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1.5',
        className,
      )}
    >
      <Button
        size="sm"
        variant={ctrl ? 'primary' : 'subtle'}
        aria-pressed={ctrl}
        onClick={() => setCtrl((value) => !value)}
        disabled={disabled}
        className="min-w-11 md:min-w-0 [@media(pointer:coarse)]:min-h-[var(--tap-target)]"
      >
        {t('webssh.mobile.ctrl')}
      </Button>
      <Button
        size="sm"
        variant={alt ? 'primary' : 'subtle'}
        aria-pressed={alt}
        onClick={() => setAlt((value) => !value)}
        disabled={disabled}
        className="min-w-11 md:min-w-0 [@media(pointer:coarse)]:min-h-[var(--tap-target)]"
      >
        {t('webssh.mobile.alt')}
      </Button>
      {KEYS.map((key) => (
        <Button
          key={key.id}
          size="sm"
          variant="subtle"
          aria-label={t(key.nameKey)}
          disabled={disabled}
          onClick={() => press(key)}
          className="min-w-9 px-1.5 md:min-w-0 [@media(pointer:coarse)]:min-h-[var(--tap-target)]"
        >
          {key.label}
        </Button>
      ))}
    </div>
  )
}
