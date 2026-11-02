import { useEffect, useState } from 'react'
import { ArrowLeftRight, Copy, Delete, RefreshCw } from 'lucide-react'
import {
  CURRENCY_BY_ID,
  CURRENCY_DEFINITIONS,
  convertCurrencyValue,
  currencyFractionDigits,
  currencyLabel,
  currencyRatioText,
  currencySymbol,
  formatCurrencyValue,
  truncateCurrencyInput,
} from '@shared/tools/calculator/converters/currency'
import { SelectMenu } from '../../../../components/select-menu'
import { Button, IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { useLocale } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { calcT } from '../lib/calc-i18n'
import { copyToClipboard } from '../lib/clipboard'
import { useCalculatorStore } from '../store'
import { CalcKey } from '../components/CalcKey'

export function CurrencyView() {
  const locale = useLocale()
  const setUnitPreferences = useCalculatorStore((state) => state.setUnitPreferences)
  const preferences = useCalculatorStore((state) => state.unitPreferences)
  const rates = useCalculatorStore((state) => state.currencyRates)
  const ratesLoading = useCalculatorStore((state) => state.currencyRatesLoading)
  const ratesError = useCalculatorStore((state) => state.currencyRatesError)
  const fetchCurrencyRates = useCalculatorStore((state) => state.fetchCurrencyRates)
  const saved = preferences.find((entry) => entry.categoryId === 'currency')
  const [fromId, setFromId] = useState(saved?.fromUnitId ?? 1)
  const [toId, setToId] = useState(saved?.toUnitId ?? 2)
  const [input, setInput] = useState('')
  const available = rates
    ? CURRENCY_DEFINITIONS.filter((currency) => currency.code === rates.base || rates.rates[currency.code] !== undefined)
    : CURRENCY_DEFINITIONS
  const from = available.find((currency) => currency.id === fromId) ?? available[0] ?? CURRENCY_DEFINITIONS[0]
  const to = available.find((currency) => currency.id === toId) ?? available[1] ?? available[0] ?? CURRENCY_DEFINITIONS[1]

  useEffect(() => {
    void fetchCurrencyRates()
  }, [fetchCurrencyRates])

  useEffect(() => {
    if (!rates) return
    if (!available.some((currency) => currency.id === fromId)) setFromId(available[0]?.id ?? 1)
    if (!available.some((currency) => currency.id === toId)) setToId(available[1]?.id ?? available[0]?.id ?? 2)
  }, [rates, available, fromId, toId])

  useEffect(() => {
    const preference = preferences.find((entry) => entry.categoryId === 'currency')
    if (!preference) return
    if (CURRENCY_BY_ID.has(preference.fromUnitId) && CURRENCY_BY_ID.has(preference.toUnitId)) {
      setFromId(preference.fromUnitId)
      setToId(preference.toUnitId)
    }
  }, [preferences])

  const value = Number(input || '0') || 0
  const converted = convertCurrencyValue(value, from.code, to.code, rates)
  const resultText = formatCurrencyValue(converted, to.code)

  const save = (nextFrom: number, nextTo: number) => {
    setUnitPreferences([{ categoryId: 'currency', fromUnitId: nextFrom, toUnitId: nextTo }])
  }

  const pressDigit = (digit: string) => {
    if (input.replace('-', '').replace('.', '').length >= 15) return
    const next = input === '0' ? digit : `${input}${digit}`
    setInput(truncateCurrencyInput(next, from.code))
  }

  return (
    <div className="flex h-full min-h-0 w-full justify-center overflow-y-auto p-3 sm:p-6">
      <div className="w-full max-w-[680px] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">{calcT('tools.calculator.currency.title')}</h1>
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw size={13} />}
            loading={ratesLoading}
            onClick={() => { void fetchCurrencyRates(true) }}
          >
            {calcT('tools.calculator.common.refresh')}
          </Button>
        </div>

        {ratesError && !rates ? (
          <div className="rounded-[var(--r-lg)] border border-[var(--danger)] bg-[var(--bg-sunken)] p-4 text-[length:var(--text-13)] text-[var(--danger)]">
            {calcT('tools.calculator.currency.unavailable')}
          </div>
        ) : (
          <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3 sm:p-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
              <div className="space-y-2">
                <SelectMenu
                  label={calcT('tools.calculator.currency.from')}
                  value={String(fromId)}
                  searchable
                  onChange={(value) => {
                    const id = Number(value)
                    setFromId(id)
                    setInput((current) => truncateCurrencyInput(current, (CURRENCY_BY_ID.get(id) ?? from).code))
                    save(id, toId)
                  }}
                  options={available.map((currency) => ({ value: String(currency.id), label: currencyLabel(currency.code, locale) }))}
                />
                <div className="flex items-center justify-end gap-1 rounded-[var(--r-md)] bg-[var(--bg-surface)] px-3 py-2">
                  <span className="text-[length:var(--text-13)] text-[var(--text-tertiary)]">{currencySymbol(from.code, locale)}</span>
                  <span className="text-[length:var(--text-20)] font-semibold tabular-nums text-[var(--text-primary)]">{input || '0'}</span>
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
                    setInput((current) => truncateCurrencyInput(current, (CURRENCY_BY_ID.get(nextFrom) ?? from).code))
                    save(nextFrom, nextTo)
                  }}
                >
                  <ArrowLeftRight size={16} />
                </IconButton>
              </Tooltip>
              <div className="space-y-2">
                <SelectMenu
                  label={calcT('tools.calculator.currency.to')}
                  value={String(toId)}
                  searchable
                  onChange={(value) => {
                    const id = Number(value)
                    setToId(id)
                    save(fromId, id)
                  }}
                  options={available.map((currency) => ({ value: String(currency.id), label: currencyLabel(currency.code, locale) }))}
                />
                <div className="flex items-center gap-1 rounded-[var(--r-md)] bg-[var(--bg-surface)] px-3 py-2">
                  <span className="text-[length:var(--text-13)] text-[var(--text-tertiary)]">{currencySymbol(to.code, locale)}</span>
                  <span className="min-w-0 flex-1 truncate text-right text-[length:var(--text-20)] font-semibold tabular-nums text-[var(--text-primary)]">{resultText}</span>
                  <Tooltip label={calcT('tools.calculator.common.copy_result')}>
                    <IconButton label={calcT('tools.calculator.common.copy_result')} size="sm" onClick={() => { void copyToClipboard(resultText).then((ok) => { if (!ok) useUi.getState().toast({ title: calcT('tools.calculator.error.invalid_input'), tone: 'danger' }) }) }}>
                      <Copy size={13} />
                    </IconButton>
                  </Tooltip>
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              <span>{currencyRatioText(from.code, to.code, rates)}</span>
              <span>
                {rates
                  ? calcT('tools.calculator.currency.updated', {
                    time: new Intl.DateTimeFormat(locale === 'zh-CN' ? 'zh-CN' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(rates.fetchedAt),
                  })
                  : calcT('tools.calculator.common.loading')}
              </span>
            </div>
            <p className="mt-2 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
              {rates?.stale ? calcT('tools.calculator.currency.stale') : calcT('tools.calculator.currency.source')}
            </p>
          </div>
        )}

        <div className="grid grid-cols-4 gap-1.5">
          {['7', '8', '9'].map((digit) => <CalcKey key={digit} glyph={digit} ariaLabel={digit} onPress={() => pressDigit(digit)} />)}
          <CalcKey glyph={<Delete size={15} />} ariaLabel={calcT('tools.calculator.common.backspace')} variant="function" onPress={() => setInput((current) => current.slice(0, -1))} />
          {['4', '5', '6'].map((digit) => <CalcKey key={digit} glyph={digit} ariaLabel={digit} onPress={() => pressDigit(digit)} />)}
          <CalcKey glyph="C" ariaLabel={calcT('tools.calculator.common.clear')} variant="function" onPress={() => setInput('')} />
          {['1', '2', '3'].map((digit) => <CalcKey key={digit} glyph={digit} ariaLabel={digit} onPress={() => pressDigit(digit)} />)}
          <CalcKey
            glyph="."
            ariaLabel={calcT('tools.calculator.common.decimal')}
            disabled={currencyFractionDigits(from.code) === 0}
            onPress={() => setInput((current) => current.includes('.') ? current : truncateCurrencyInput(current ? `${current}.` : '0.', from.code))}
          />
          <CalcKey glyph="0" ariaLabel="0" className="col-span-2" onPress={() => pressDigit('0')} />
          <CalcKey glyph="=" ariaLabel={calcT('tools.calculator.common.equals')} variant="equals" className="col-span-2" onPress={() => setInput(resultText === '—' ? input : resultText)} />
        </div>

        <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] p-3">
          <h2 className="mb-2 text-[length:var(--text-12)] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{calcT('tools.calculator.currency.supplementary')}</h2>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {available.filter((currency) => currency.id !== fromId).map((currency) => {
              const other = convertCurrencyValue(value, from.code, currency.code, rates)
              return (
                <div key={currency.id} className="flex items-center justify-between gap-2 rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-2 py-1.5 text-[length:var(--text-12)]">
                  <span className="truncate text-[var(--text-tertiary)]">{currencyLabel(currency.code, locale)}</span>
                  <span className="shrink-0 font-semibold tabular-nums text-[var(--text-primary)]">{formatCurrencyValue(other, currency.code)}</span>
                </div>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}
