import { useRef } from 'react'
import { ClipboardPaste, Copy, Redo2, Scissors, Undo2, type LucideIcon } from 'lucide-react'
import type { MenuSearchAction } from '../../../components/overlay'
import { t, type MessageKey } from '../../../lib/i18n'
import { prettyCombo } from '../../../lib/hotkeys'
import type { MenuCtx } from './types'

/**
 * The strip of clipboard and history buttons the context menu opens with.
 *
 * These are the actions a right-click is most often asked for and which no block kind owns, so they
 * sit above the list rather than repeating inside every branch of it. The same list is handed to the
 * search box separately: a row that only exists as a button would otherwise be unfindable by typing.
 */
export interface ContextToolbarState {
  canCut: boolean
  canCopy: boolean
  canPaste: boolean
  canUndo: boolean
  canRedo: boolean
  onCut: () => void
  onCopy: () => void
  onPaste: () => void
  onUndo: () => void
  onRedo: () => void
  onClose: () => void
}

export function toolbarState(ctx: MenuCtx, copyText: () => string, onClose: () => void): ContextToolbarState {
  const text = copyText()
  return {
    canCut: Boolean(ctx.editorView && ctx.editor?.selectedText),
    canCopy: text.length > 0,
    canPaste: Boolean(ctx.editorView),
    canUndo: ctx.canUndo,
    canRedo: ctx.canRedo,
    onCut: ctx.onCut,
    onCopy: () => ctx.onCopyText(text),
    onPaste: ctx.onPaste,
    onUndo: ctx.onUndo,
    onRedo: ctx.onRedo,
    onClose,
  }
}

const BUTTONS: Array<{ key: string; label: MessageKey; combo: string; icon: LucideIcon }> = [
  { key: 'cut', label: 'contextmenu.cut', combo: 'mod+x', icon: Scissors },
  { key: 'copy', label: 'contextmenu.copy', combo: 'mod+c', icon: Copy },
  { key: 'paste', label: 'contextmenu.paste', combo: 'mod+v', icon: ClipboardPaste },
  { key: 'undo', label: 'contextmenu.undo', combo: 'mod+z', icon: Undo2 },
  { key: 'redo', label: 'contextmenu.redo', combo: 'mod+shift+z', icon: Redo2 },
] as const

type ButtonKey = (typeof BUTTONS)[number]['key']

const isEnabled = (state: ContextToolbarState, key: ButtonKey): boolean =>
  key === 'cut' ? state.canCut
    : key === 'copy' ? state.canCopy
      : key === 'paste' ? state.canPaste
        : key === 'undo' ? state.canUndo
          : state.canRedo

const handlerOf = (state: ContextToolbarState, key: ButtonKey): (() => void) =>
  key === 'cut' ? state.onCut
    : key === 'copy' ? state.onCopy
      : key === 'paste' ? state.onPaste
        : key === 'undo' ? state.onUndo
          : state.onRedo

/** The five buttons as searchable rows, so a query can find what only a button offers. */
export function toolbarSearchActions(state: ContextToolbarState): MenuSearchAction[] {
  const actions: MenuSearchAction[] = []
  for (const button of BUTTONS) {
    if (button.key === 'undo' || button.key === 'redo') {
      if (!isEnabled(state, button.key)) continue
    }
    const Icon = button.icon
    actions.push({
      id: `toolbar-${button.key}`,
      label: t(button.label),
      icon: <Icon size={14} />,
      combo: button.combo,
      disabled: button.key === 'cut' || button.key === 'copy' || button.key === 'paste' ? !isEnabled(state, button.key) : false,
      onSelect: () => {
        handlerOf(state, button.key)()
        state.onClose()
      },
    })
  }
  return actions
}

export function ContextMenuToolbar(state: ContextToolbarState) {
  const container = useRef<HTMLDivElement>(null)

  /** Left and right walk the strip; down leaves it for the filter box or the first row. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const box = container.current
    if (!box) return
    const buttons = [...box.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const at = buttons.indexOf(event.currentTarget)
    if (at < 0) return
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      event.stopPropagation()
      const step = event.key === 'ArrowRight' ? 1 : -1
      buttons[(at + step + buttons.length) % buttons.length]?.focus()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'Tab') return
    event.preventDefault()
    event.stopPropagation()
    const panel = box.closest('[role="menu"]')
    const field = panel?.querySelector<HTMLInputElement>('input')
    if (field && (event.key === 'ArrowDown' || !event.shiftKey)) {
      field.focus()
      return
    }
    const rows = [...(panel?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [])]
    ;(event.shiftKey ? rows[rows.length - 1] : rows[0])?.focus()
  }

  return (
    <div
      ref={container}
      role='toolbar'
      aria-label={t('contextmenu.quick_actions')}
      className='mb-1 flex items-center rounded-[calc(var(--r-lg)-2px)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-1 py-1'
    >
      <div className='flex w-full items-center justify-around'>
        {BUTTONS.map((button, index) => {
          const Icon = button.icon
          const disabled = !isEnabled(state, button.key)
          const label = t(button.label)
          return (
            <span key={button.key} className='contents'>
              {index === 2 && <span aria-hidden='true' className='mx-0.5 h-4 w-px shrink-0 bg-[var(--border-subtle)]' />}
              <button
                type='button'
                disabled={disabled}
                title={`${label} (${prettyCombo(button.combo).join('+')})`}
                aria-label={label}
                onClick={(event) => {
                  event.stopPropagation()
                  if (disabled) return
                  handlerOf(state, button.key)()
                  state.onClose()
                }}
                onKeyDown={onKeyDown}
                className='flex size-7 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-secondary)] transition-[background-color,color,transform] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-35'
              >
                <Icon size={14} />
              </button>
            </span>
          )
        })}
      </div>
    </div>
  )
}
