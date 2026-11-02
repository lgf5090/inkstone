import { useEffect, useMemo, useState } from 'react'
import { ArrowLeftRight, Copy, Delete } from 'lucide-react'
import { UNIT_CATEGORIES } from '@shared/tools/calculator/converters/units'
import {
  convertUnitValue,
  formatConverterValue,
  getUnitCategory,
  getUnitsForCategory,
  supplementaryResults,
} from '@shared/tools/calculator/converters/unit-converter'
import type { UnitPreference } from '@shared/tools/calculator/types'
import { UNIT_MAX_DIGITS } from '@shared/tools/calculator/contract'
import { SelectMenu } from '../../../../components/select-menu'
import { IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { calcT } from '../lib/calc-i18n'
import { useCalculatorStore } from '../store'
import { useUi } from '../../../../store/ui'
import { copyToClipboard } from '../lib/clipboard'
import { CalcKey } from '../components/CalcKey'

const categories = UNIT_CATEGORIES.filter((category) => category.id !== 'currency')

function defaultUnits(categoryId: string, prefs: UnitPreference[]) {
  const units = getUnitsForCategory(categoryId)
  const pref = prefs.find((entry) => entry.categoryId === categoryId)
  const valid = (id?: number) => units.some((unit) => unit.id === id)
  const from = valid(pref?.fromUnitId) ? pref!.fromUnitId : (units.find((unit) => unit.isConversionSource) ?? units[0])?.id ?? 0
  const to = valid(pref?.toUnitId) ? pref!.toUnitId : (units.find((unit) => unit.isConversionTarget) ?? units.find((unit) => unit.id !== from))?.id ?? 0
  return { from, to }
}

export function UnitView() {
  const prefs = useCalculatorStore((state) => state.unitPreferences)
  const setUnitPreferences = useCalculatorStore((state) => state.setUnitPreferences)
  const [categoryId, setCategoryId] = useState('length')
  const [fromId, setFromId] = useState(() => defaultUnits('length', prefs).from)
  const [toId, setToId] = useState(() => defaultUnits('length', prefs).to)
  const [input, setInput] = useState('')
  useEffect(() => {
    const next = defaultUnits(categoryId, prefs)
    setFromId(next.from)
    setToId(next.to)
  }, [categoryId, prefs])

  const category = getUnitCategory(categoryId)
  const units = getUnitsForCategory(categoryId)
  const unitLabel = (unit: (typeof units)[number]) => {
    const name = calcT(unit.nameKey)
    const abbr = calcT(unit.abbrKey)
    return name === abbr ? name : `${name} (${abbr})`
  }
  const value = Number(input || '0') || 0
  const converted = useMemo(() => convertUnitValue(value, fromId, toId), [value, fromId, toId])

  const resultText = formatConverterValue(converted, input || '0', false)
  const supplementary = useMemo(
    () => supplementaryResults(value, categoryId, fromId, category?.supportsNegative ?? false),
    [value, categoryId, fromId, category?.supportsNegative],
  )

  const save = (nextFrom: number, nextTo: number) => {
    setUnitPreferences([
      ...prefs.filter((entry) => entry.categoryId !== categoryId),
      { categoryId, fromUnitId: nextFrom, toUnitId: nextTo },
    ])
  }

  const changeCategory = (nextCategoryId: string) => {
    const next = defaultUnits(nextCategoryId, prefs)
    setCategoryId(nextCategoryId)
    setFromId(next.from)
    setToId(next.to)
    setInput('')
    save(next.from, next.to)
  }

  const changeUnit = (side: 'from' | 'to', valueId: string) => {
    const id = Number(valueId)
    if (side === 'from') {
      setFromId(id)
      save(id, toId)
    } else {
      setToId(id)
      save(fromId, id)
    }
  }

  const pressDigit = (digit: string) => {
    if (input.replace('-', '').replace('.', '').length >= UNIT_MAX_DIGITS) return
    setInput((current) => (current === '0' ? digit : `${current}${digit}`))
  }

  return (
    <div className="flex h-full min-h-0 w-full justify-center overflow-y-auto p-3 sm:p-6">
      <div className="w-full max-w-[680px] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">{calcT('tools.calculator.unit.title')}</h1>
          <div className="w-full sm:w-56">
            <SelectMenu
              label={calcT('tools.calculator.unit.category')}
              value={categoryId}
              searchable
              onChange={changeCategory}
              options={categories.map((entry) => ({ value: entry.id, label: calcT(entry.nameKey) }))}
            />
          </div>
        </div>

        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3 sm:p-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
            <div className="space-y-2">
              <SelectMenu
                label={calcT('tools.calculator.unit.from')}
                value={String(fromId)}
                searchable
                onChange={(value) => changeUnit('from', value)}
                options={units.map((unit) => ({ value: String(unit.id), label: unitLabel(unit) }))}
              />
              <div className="rounded-[var(--r-md)] bg-[var(--bg-surface)] px-3 py-2 text-right text-[length:var(--text-20)] font-semibold tabular-nums text-[var(--text-primary)]">
                {input || '0'}
              </div>
            </div>
            <Tooltip label={calcT('tools.calculator.common.swap')}>
              <IconButton
                label={calcT('tools.calculator.common.swap')}
                size="lg"
                onClick={() => {
                  const nextFrom = toId
                  const nextTo = fromId
                  setFromId(nextFrom)
                  setToId(nextTo)
                  save(nextFrom, nextTo)
                }}
              >
                <ArrowLeftRight size={16} />
              </IconButton>
            </Tooltip>
            <div className="space-y-2">
              <SelectMenu
                label={calcT('tools.calculator.unit.to')}
                value={String(toId)}
                searchable
                onChange={(value) => changeUnit('to', value)}
                options={units.map((unit) => ({ value: String(unit.id), label: unitLabel(unit) }))}
              />
              <div className="flex items-center gap-1 rounded-[var(--r-md)] bg-[var(--bg-surface)] px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-right text-[length:var(--text-20)] font-semibold tabular-nums text-[var(--text-primary)]">{resultText}</span>
                <Tooltip label={calcT('tools.calculator.common.copy_result')}>
                  <IconButton label={calcT('tools.calculator.common.copy_result')} size="sm" onClick={() => { void copyToClipboard(resultText).then((ok) => { if (!ok) useUi.getState().toast({ title: calcT('tools.calculator.error.invalid_input'), tone: 'danger' }) }) }}>
                    <Copy size={13} />
                  </IconButton>
                </Tooltip>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-1.5">
          {['7', '8', '9'].map((digit) => <CalcKey key={digit} glyph={digit} ariaLabel={digit} onPress={() => pressDigit(digit)} />)}
          <CalcKey glyph={<Delete size={15} />} ariaLabel={calcT('tools.calculator.common.backspace')} variant="function" onPress={() => setInput((current) => current.slice(0, -1))} />
          {['4', '5', '6'].map((digit) => <CalcKey key={digit} glyph={digit} ariaLabel={digit} onPress={() => pressDigit(digit)} />)}
          <CalcKey glyph="C" ariaLabel={calcT('tools.calculator.common.clear')} variant="function" onPress={() => setInput('')} />
          {['1', '2', '3'].map((digit) => <CalcKey key={digit} glyph={digit} ariaLabel={digit} onPress={() => pressDigit(digit)} />)}
          <CalcKey
            glyph="±"
            ariaLabel={calcT('tools.calculator.common.negate')}
            variant="function"
            disabled={!category?.supportsNegative}
            onPress={() => setInput((current) => current.startsWith('-') ? current.slice(1) : `-${current}`)}
          />
          <CalcKey glyph="0" ariaLabel="0" className="col-span-2" onPress={() => pressDigit('0')} />
          <CalcKey glyph="." ariaLabel={calcT('tools.calculator.common.decimal')} onPress={() => setInput((current) => current.includes('.') ? current : current ? `${current}.` : '0.')} />
          <CalcKey glyph="=" ariaLabel={calcT('tools.calculator.common.equals')} variant="equals" onPress={() => setInput(resultText)} />
        </div>

        {supplementary.length > 0 && (
          <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] p-3">
            <h2 className="mb-2 text-[length:var(--text-12)] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{calcT('tools.calculator.unit.supplementary')}</h2>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {supplementary.map((entry) => {
                const unit = units.find((candidate) => candidate.id === entry.unitId)
                if (!unit) return null
                return (
                  <div key={entry.unitId} className="flex items-center justify-between gap-2 rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-2 py-1.5 text-[length:var(--text-12)]">
                    <span className="truncate text-[var(--text-tertiary)]">{calcT(unit.nameKey)}</span>
                    <span className="shrink-0 font-semibold tabular-nums text-[var(--text-primary)]">{entry.value} {calcT(unit.abbrKey)}</span>
                  </div>
                )
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
