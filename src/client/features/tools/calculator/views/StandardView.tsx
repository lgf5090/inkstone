import { useCalculatorStore } from '../store'
import { useBreakpoint } from '../../../../lib/hooks'
import { Drawer } from '../../../../components/overlay'
import { useUi } from '../../../../store/ui'
import { calcT } from '../lib/calc-i18n'
import { copyToClipboard, pasteIntoCalculator } from '../lib/clipboard'
import { CalcDisplay } from '../components/CalcDisplay'
import { HistoryPanel } from '../components/HistoryPanel'
import { MemoryPanel } from '../components/MemoryPanel'
import { NumberPad } from '../components/NumberPad'

export function StandardView() {
  const display = useCalculatorStore((state) => state.display)
  const historyOpen = useCalculatorStore((state) => state.historyOpen)
  const memoryOpen = useCalculatorStore((state) => state.memoryOpen)
  const send = useCalculatorStore((state) => state.send)
  const toggleHistory = useCalculatorStore((state) => state.toggleHistory)
  const toggleMemory = useCalculatorStore((state) => state.toggleMemory)
  const remember = useCalculatorStore((state) => state.remember)
  const recallMemory = useCalculatorStore((state) => state.recallMemory)
  const addMemory = useCalculatorStore((state) => state.addMemory)
  const subtractMemory = useCalculatorStore((state) => state.subtractMemory)
  const clearMemory = useCalculatorStore((state) => state.clearMemory)
  const clearHistory = useCalculatorStore((state) => state.clearHistory)
  const deleteHistory = useCalculatorStore((state) => state.deleteHistory)
  const recallHistory = useCalculatorStore((state) => state.recallHistory)
  const breakpoint = useBreakpoint()
  const desktop = breakpoint === 'desktop'

  const historyRows = display.history
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.mode === 'standard')

  const historyPanel = (
    <HistoryPanel
      entries={historyRows.map(({ entry }) => entry)}
      onRecall={(index) => recallHistory(historyRows[index]?.index ?? 0)}
      onDelete={(id) => { void deleteHistory(id) }}
      onClear={() => { void clearHistory('standard') }}
      onClose={desktop ? undefined : () => toggleHistory(false)}
    />
  )
  const memoryPanel = (
    <MemoryPanel
      values={display.memory}
      onRecall={recallMemory}
      onAdd={addMemory}
      onSubtract={subtractMemory}
      onClearItem={clearMemory}
      onClearAll={() => clearMemory()}
      onClose={desktop ? undefined : () => toggleMemory(false)}
    />
  )

  return (
    <div className="flex h-full min-h-0 w-full">
      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-3">
          <CalcDisplay
            display={display}
            historyOpen={historyOpen}
            memoryOpen={memoryOpen}
            onToggleHistory={() => toggleHistory()}
            onToggleMemory={() => toggleMemory()}
            onCopy={() => { void copyToClipboard(display.primary).then((ok) => { if (!ok) useUi.getState().toast({ title: calcT('tools.calculator.error.invalid_input'), tone: 'danger' }) }) }}
            onPaste={() => { void pasteIntoCalculator('standard', 10, send).then((result) => { if (!result.ok && result.message) useUi.getState().toast({ title: result.message, tone: 'danger' }) }) }}
            onMemoryClear={() => clearMemory()}
            onMemoryRecall={() => recallMemory(0)}
            onMemoryAdd={() => addMemory(0)}
            onMemorySubtract={() => subtractMemory(0)}
            onMemoryStore={remember}
          />
          <NumberPad onCommand={send} />
        </div>
      </div>
      {desktop && (historyOpen || memoryOpen) && (
        <aside className="w-[320px] shrink-0 border-l border-[var(--border-subtle)] bg-[var(--bg-base)]">
          {historyOpen ? historyPanel : memoryPanel}
        </aside>
      )}
      {!desktop && (
        <Drawer open={historyOpen} onClose={() => toggleHistory(false)} side="right" width={340} title={calcT('tools.calculator.common.history')}>
          {historyPanel}
        </Drawer>
      )}
      {!desktop && (
        <Drawer open={memoryOpen} onClose={() => toggleMemory(false)} side="right" width={340} title={calcT('tools.calculator.common.memory')}>
          {memoryPanel}
        </Drawer>
      )}
    </div>
  )
}
