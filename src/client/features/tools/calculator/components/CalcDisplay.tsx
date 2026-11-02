import { ClipboardPaste, Copy, History, List } from 'lucide-react'
import type { CalculatorDisplayState } from '@shared/tools/calculator/types'
import { cn } from '../../../../lib/cn'
import { IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { calcT } from '../lib/calc-i18n'
import { CalcKey } from './CalcKey'

function errorText(key: string): string {
  return calcT(`tools.calculator.error.${key}`)
}

export function CalcDisplay({
  display,
  historyOpen,
  memoryOpen,
  onToggleHistory,
  onToggleMemory,
  onCopy,
  onPaste,
  onMemoryClear,
  onMemoryRecall,
  onMemoryAdd,
  onMemorySubtract,
  onMemoryStore,
  onTokenClick,
  compact = false,
  allowHistory = true,
}: {
  display: CalculatorDisplayState
  historyOpen: boolean
  memoryOpen: boolean
  onToggleHistory: () => void
  onToggleMemory: () => void
  onCopy: () => void
  onPaste: () => void
  onMemoryClear: () => void
  onMemoryRecall: () => void
  onMemoryAdd: () => void
  onMemorySubtract: () => void
  onMemoryStore: () => void
  onTokenClick?: (index: number) => void
  compact?: boolean
  allowHistory?: boolean
}) {
  const primary = display.isError ? errorText(display.primary) : display.primary
  return (
    <section
      aria-label={calcT('tools.calculator.a11y.display')}
      className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2.5 md:px-4"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <span className="rounded-[var(--r-xs)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[length:var(--text-11)] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
            {calcT(`tools.calculator.nav.${display.mode}`)}
          </span>
          {display.mode === 'scientific' && (
            <span className="rounded-[var(--r-xs)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {display.angleMode.toUpperCase()}
            </span>
          )}
          {display.isFToEEnabled && display.mode !== 'programmer' && (
            <span className="rounded-[var(--r-xs)] bg-[var(--accent-soft)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--accent-on-soft)]">
              {'FE'}
            </span>
          )}
          {display.mode === 'programmer' && (
            <span className="rounded-[var(--r-xs)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {display.radix === 16 ? 'HEX' : display.radix === 8 ? 'OCT' : display.radix === 2 ? 'BIN' : 'DEC'} · {display.wordSize}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <Tooltip label={calcT('tools.calculator.common.copy_result')}>
            <IconButton label={calcT('tools.calculator.common.copy_result')} size="sm" onClick={onCopy}>
              <Copy size={14} />
            </IconButton>
          </Tooltip>
          <Tooltip label={calcT('tools.calculator.common.paste')}>
            <IconButton label={calcT('tools.calculator.common.paste')} size="sm" onClick={onPaste}>
              <ClipboardPaste size={14} />
            </IconButton>
          </Tooltip>
          {allowHistory && (
            <Tooltip label={calcT('tools.calculator.common.history')}>
              <IconButton label={calcT('tools.calculator.common.history')} size="sm" active={historyOpen} onClick={onToggleHistory}>
                <History size={14} />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip label={calcT('tools.calculator.common.memory')}>
            <IconButton label={calcT('tools.calculator.common.memory')} size="sm" active={memoryOpen} onClick={onToggleMemory}>
              <List size={14} />
            </IconButton>
          </Tooltip>
        </div>
      </div>

      {display.expressionTokens.length > 0 && (
        <div className="flex min-h-5 items-center justify-end gap-1 overflow-x-auto text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">
          {display.expressionTokens.map((token, index) => (
            <button
              key={`${token.commandIndex}-${index}`}
              type="button"
              disabled={!token.editable || !onTokenClick}
              onClick={() => onTokenClick?.(index)}
              className={cn(
                'shrink-0 rounded-[var(--r-xs)] px-0.5 tabular-nums',
                token.type === 'operand' && token.editable
                  ? 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                  : 'cursor-default',
              )}
            >
              {token.text}
            </button>
          ))}
          {display.parenthesisCount > 0 && <span aria-hidden="true">(</span>}
        </div>
      )}

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={cn(
          'min-h-[2.4em] overflow-x-auto text-right font-semibold tabular-nums text-[var(--text-primary)]',
          'transition-colors duration-[var(--dur-fast)]',
          compact ? 'text-[length:var(--text-26)]' : 'text-[length:var(--text-30)] md:text-[length:var(--text-30)]',
          display.isError && 'text-[var(--danger)]',
        )}
      >
        {primary}
      </div>

      <div className="mt-1 grid grid-cols-6 gap-1">
        <CalcKey glyph="MC" ariaLabel={calcT('tools.calculator.common.memory_clear')} variant="memory" onPress={onMemoryClear} className="min-h-11 px-0.5 text-[length:var(--text-12)] md:px-2" />
        <CalcKey glyph="MR" ariaLabel={calcT('tools.calculator.common.memory_recall')} variant="memory" onPress={onMemoryRecall} className="min-h-11 px-0.5 text-[length:var(--text-12)] md:px-2" />
        <CalcKey glyph="M+" ariaLabel={calcT('tools.calculator.common.memory_add')} variant="memory" onPress={onMemoryAdd} className="min-h-11 px-0.5 text-[length:var(--text-12)] md:px-2" />
        <CalcKey glyph="M−" ariaLabel={calcT('tools.calculator.common.memory_subtract')} variant="memory" onPress={onMemorySubtract} className="min-h-11 px-0.5 text-[length:var(--text-12)] md:px-2" />
        <CalcKey glyph="MS" ariaLabel={calcT('tools.calculator.common.memory_store')} variant="memory" onPress={onMemoryStore} className="min-h-11 px-0.5 text-[length:var(--text-12)] md:px-2" />
        <CalcKey glyph="M∨" ariaLabel={calcT('tools.calculator.common.memory_list')} variant="memory" active={memoryOpen} onPress={onToggleMemory} className="min-h-11 px-0.5 text-[length:var(--text-12)] md:px-2" />
      </div>
    </section>
  )
}
