import { useState } from 'react'
import { useCalculatorStore } from '../store'
import { useBreakpoint } from '../../../../lib/hooks'
import { Drawer } from '../../../../components/overlay'
import { Segmented } from '../../../../components/form'
import { useUi } from '../../../../store/ui'
import { CMD } from '@shared/tools/calculator/contract'
import { calcT } from '../lib/calc-i18n'
import { copyToClipboard, pasteIntoCalculator } from '../lib/clipboard'
import { CalcDisplay } from '../components/CalcDisplay'
import { MemoryPanel } from '../components/MemoryPanel'
import { CalcKey } from '../components/CalcKey'

const DIGIT_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F'] as const

export function ProgrammerView() {
  const display = useCalculatorStore((state) => state.display)
  const memoryOpen = useCalculatorStore((state) => state.memoryOpen)
  const send = useCalculatorStore((state) => state.send)
  const toggleMemory = useCalculatorStore((state) => state.toggleMemory)
  const remember = useCalculatorStore((state) => state.remember)
  const recallMemory = useCalculatorStore((state) => state.recallMemory)
  const addMemory = useCalculatorStore((state) => state.addMemory)
  const subtractMemory = useCalculatorStore((state) => state.subtractMemory)
  const clearMemory = useCalculatorStore((state) => state.clearMemory)
  const breakpoint = useBreakpoint()
  const desktop = breakpoint === 'desktop'
  const [bitFlipOpen, setBitFlipOpen] = useState(false)

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

  const digitCommand = (key: string): number => {
    if (key >= '0' && key <= '9') return CMD.digit0 + Number(key)
    return CMD.a + (key.charCodeAt(0) - 65)
  }
  const digitEnabled = (key: string): boolean => {
    const value = Number.parseInt(key, 16)
    return value < display.radix
  }

  return (
    <div className="flex h-full min-h-0 w-full">
      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
        <div className="mx-auto flex w-full max-w-[640px] flex-col gap-3">
          <div className="grid grid-cols-2 gap-1.5 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2 sm:grid-cols-4">
            {[
              ['HEX', display.programmer.hex],
              ['DEC', display.programmer.dec],
              ['OCT', display.programmer.oct],
              ['BIN', display.programmer.bin],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0 rounded-[var(--r-sm)] bg-[var(--bg-surface)] px-2 py-1.5">
                <div className="text-[length:var(--text-10-5)] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">{label}</div>
                <div className="truncate text-right text-[length:var(--text-14)] font-semibold tabular-nums text-[var(--text-primary)]">{value}</div>
              </div>
            ))}
          </div>

          <CalcDisplay
            display={display}
            historyOpen={false}
            memoryOpen={memoryOpen}
            allowHistory={false}
            onToggleHistory={() => undefined}
            onToggleMemory={() => toggleMemory()}
            onCopy={() => { void copyToClipboard(display.primary).then((ok) => { if (!ok) useUi.getState().toast({ title: calcT('tools.calculator.error.invalid_input'), tone: 'danger' }) }) }}
            onPaste={() => { void pasteIntoCalculator('programmer', display.radix, send).then((result) => { if (!result.ok && result.message) useUi.getState().toast({ title: result.message, tone: 'danger' }) }) }}
            onMemoryClear={() => clearMemory()}
            onMemoryRecall={() => recallMemory(0)}
            onMemoryAdd={() => addMemory(0)}
            onMemorySubtract={() => subtractMemory(0)}
            onMemoryStore={remember}
          />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented
              value={String(display.radix)}
              onChange={(value) => send(Number(value) === 16 ? CMD.hex : Number(value) === 8 ? CMD.oct : Number(value) === 2 ? CMD.bin : CMD.dec)}
              size="sm"
              label={calcT('tools.calculator.programmer.radix')}
              options={[
                { value: '16', label: 'HEX' },
                { value: '10', label: 'DEC' },
                { value: '8', label: 'OCT' },
                { value: '2', label: 'BIN' },
              ]}
            />
            <Segmented
              value={String(display.wordSize)}
              onChange={(value) => send(Number(value) === 64 ? CMD.qword : Number(value) === 32 ? CMD.dword : Number(value) === 16 ? CMD.word : CMD.byte)}
              size="sm"
              label={calcT('tools.calculator.programmer.word_size')}
              options={[
                { value: '64', label: '64' },
                { value: '32', label: '32' },
                { value: '16', label: '16' },
                { value: '8', label: '8' },
              ]}
            />
            <button
              type="button"
              aria-pressed={bitFlipOpen}
              onClick={() => setBitFlipOpen((open) => !open)}
              className="rounded-[var(--r-sm)] border border-[var(--border-default)] px-2 py-1 text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] aria-pressed:bg-[var(--accent-soft)] aria-pressed:text-[var(--accent-on-soft)]"
            >
              {calcT('tools.calculator.programmer.bit_flip')}
            </button>
          </div>

          {bitFlipOpen ? (
            <div className="grid grid-cols-8 gap-1 rounded-[var(--r-lg)] border border-[var(--border-subtle)] p-2">
              {Array.from({ length: 64 }, (_, index) => 63 - index).map((bit) => (
                <CalcKey
                  key={bit}
                  glyph={display.binaryDigits[bit] ? '1' : '0'}
                  ariaLabel={calcT('tools.calculator.programmer.bit_index', { index: bit })}
                  title={calcT('tools.calculator.programmer.bit_index', { index: bit })}
                  variant="function"
                  active={display.binaryDigits[bit]}
                  disabled={bit >= display.wordSize}
                  className="min-h-11 text-[length:var(--text-12)] md:min-h-8"
                  onPress={() => send(CMD.bitFlipStart + bit)}
                />
              ))}
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                {(['and', 'or', 'xor', 'not', 'nand', 'nor'] as const).map((key) => (
                  <CalcKey
                    key={key}
                    glyph={key.toUpperCase()}
                    ariaLabel={calcT(`tools.calculator.programmer.${key}`)}
                    variant="function"
                    className="text-[length:var(--text-12)]"
                    onPress={() => send(key === 'and' ? CMD.and : key === 'or' ? CMD.or : key === 'xor' ? CMD.xor : key === 'not' ? CMD.not : key === 'nand' ? CMD.nand : CMD.nor)}
                  />
                ))}
              </div>
              <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                {(['lsh', 'rsh', 'rol', 'ror', 'rol_carry', 'ror_carry'] as const).map((key) => (
                  <CalcKey
                    key={key}
                    glyph={key === 'rol_carry' ? 'ROLC' : key === 'ror_carry' ? 'RORC' : key.toUpperCase()}
                    ariaLabel={calcT(`tools.calculator.programmer.${key}`)}
                    variant="function"
                    className="text-[length:var(--text-12)]"
                    onPress={() => send(key === 'lsh' ? CMD.leftShift : key === 'rsh' ? CMD.rightShift : key === 'rol' ? CMD.rotateLeft : key === 'ror' ? CMD.rotateRight : key === 'rol_carry' ? CMD.rotateLeftCarry : CMD.rotateRightCarry)}
                  />
                ))}
              </div>
              <div className="grid grid-cols-6 gap-1.5">
                {DIGIT_KEYS.map((key) => (
                  <CalcKey
                    key={key}
                    glyph={key}
                    ariaLabel={key}
                    disabled={!digitEnabled(key)}
                    variant={Number.parseInt(key, 16) < 10 ? 'digit' : 'operator'}
                    onPress={() => send(digitCommand(key))}
                  />
                ))}
                <CalcKey glyph="(" ariaLabel={calcT('tools.calculator.scientific.open_paren')} variant="function" onPress={() => send(CMD.openParen)} />
                <CalcKey glyph=")" ariaLabel={calcT('tools.calculator.scientific.close_paren')} variant="function" onPress={() => send(CMD.closeParen)} />
                <CalcKey glyph="mod" ariaLabel={calcT('tools.calculator.scientific.mod')} variant="function" className="px-1 text-[length:var(--text-13)]" onPress={() => send(CMD.mod)} />
                <CalcKey glyph="÷" ariaLabel={calcT('tools.calculator.standard.divide')} variant="operator" onPress={() => send(CMD.divide)} />
                <CalcKey glyph="×" ariaLabel={calcT('tools.calculator.standard.multiply')} variant="operator" onPress={() => send(CMD.multiply)} />
                <CalcKey glyph="−" ariaLabel={calcT('tools.calculator.standard.subtract')} variant="operator" onPress={() => send(CMD.subtract)} />
                <CalcKey glyph="+" ariaLabel={calcT('tools.calculator.standard.add')} variant="operator" onPress={() => send(CMD.add)} />
                <CalcKey glyph="±" ariaLabel={calcT('tools.calculator.common.negate')} variant="function" onPress={() => send(CMD.sign)} />
                <CalcKey glyph="=" ariaLabel={calcT('tools.calculator.common.equals')} variant="equals" className="col-span-3" onPress={() => send(CMD.equals)} />
                <CalcKey glyph="⌫" ariaLabel={calcT('tools.calculator.common.backspace')} variant="function" onPress={() => send(CMD.back)} />
                <CalcKey glyph="C" ariaLabel={calcT('tools.calculator.common.clear')} variant="function" onPress={() => send(CMD.clear)} />
                <CalcKey glyph="CE" ariaLabel={calcT('tools.calculator.common.clear_entry')} variant="function" onPress={() => send(CMD.clearEntry)} />
              </div>
            </div>
          )}
        </div>
      </div>
      {desktop && memoryOpen && (
        <aside className="w-[320px] shrink-0 border-l border-[var(--border-subtle)] bg-[var(--bg-base)]">{memoryPanel}</aside>
      )}
      {!desktop && (
        <Drawer open={memoryOpen} onClose={() => toggleMemory(false)} side="right" width={340} title={calcT('tools.calculator.common.memory')}>
          {memoryPanel}
        </Drawer>
      )}
    </div>
  )
}
