import { useState } from 'react'
import { Copy, Delete } from 'lucide-react'
import {
  KINSHIP_MAX_CHAIN,
  KINSHIP_RELATIONS,
  lookupKinship,
  type KinshipLookup,
  type KinshipRelation,
} from '@shared/tools/calculator/kinship/kinship'
import { IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { useUi } from '../../../../store/ui'
import { calcT } from '../lib/calc-i18n'
import { copyToClipboard } from '../lib/clipboard'
import { CalcKey } from '../components/CalcKey'

const RELATION_KEYS: Record<KinshipRelation, { glyph: string; label: string }> = {
  husband: { glyph: 'tools.calculator.kinship.glyph.husband', label: 'tools.calculator.kinship.relation.husband' },
  wife: { glyph: 'tools.calculator.kinship.glyph.wife', label: 'tools.calculator.kinship.relation.wife' },
  father: { glyph: 'tools.calculator.kinship.glyph.father', label: 'tools.calculator.kinship.relation.father' },
  mother: { glyph: 'tools.calculator.kinship.glyph.mother', label: 'tools.calculator.kinship.relation.mother' },
  older_brother: { glyph: 'tools.calculator.kinship.glyph.older_brother', label: 'tools.calculator.kinship.relation.older_brother' },
  younger_brother: { glyph: 'tools.calculator.kinship.glyph.younger_brother', label: 'tools.calculator.kinship.relation.younger_brother' },
  older_sister: { glyph: 'tools.calculator.kinship.glyph.older_sister', label: 'tools.calculator.kinship.relation.older_sister' },
  younger_sister: { glyph: 'tools.calculator.kinship.glyph.younger_sister', label: 'tools.calculator.kinship.relation.younger_sister' },
  son: { glyph: 'tools.calculator.kinship.glyph.son', label: 'tools.calculator.kinship.relation.son' },
  daughter: { glyph: 'tools.calculator.kinship.glyph.daughter', label: 'tools.calculator.kinship.relation.daughter' },
}

export function KinshipView() {
  const [chain, setChain] = useState<KinshipRelation[]>([])
  const [lookup, setLookup] = useState<KinshipLookup | null>(null)
  const [reverse, setReverse] = useState(false)

  const atLimit = chain.length >= KINSHIP_MAX_CHAIN
  const displayed = lookup ? (reverse ? lookup.reverse : lookup.forward) : []
  const complex = Boolean(lookup) && displayed.length === 0
  const canReverse = lookup !== null && lookup.reverse.length > 0
  const canCopy = Boolean(lookup) && displayed.length > 0

  const expression = chain.reduce(
    (text, relation) => `${text} ${calcT('tools.calculator.kinship.of')} ${calcT(RELATION_KEYS[relation].glyph)}`,
    calcT('tools.calculator.kinship.me'),
  )
  const primary = lookup
    ? complex ? calcT('tools.calculator.kinship.complex') : displayed.join(' / ')
    : expression
  const resultLabel = lookup
    ? complex
      ? calcT('tools.calculator.kinship.complex_hint')
      : calcT(reverse ? 'tools.calculator.kinship.reverse_label' : 'tools.calculator.kinship.forward_label')
    : calcT('tools.calculator.kinship.hint')

  const append = (relation: KinshipRelation) => {
    if (atLimit) return
    setChain((current) => [...current, relation])
    setLookup(null)
    setReverse(false)
  }

  const backspace = () => {
    setChain((current) => current.slice(0, -1))
    setLookup(null)
    setReverse(false)
  }

  const clear = () => {
    setChain([])
    setLookup(null)
    setReverse(false)
  }

  const compute = () => {
    if (chain.length === 0) return
    setLookup(lookupKinship(chain))
    setReverse(false)
  }

  const copy = () => {
    if (!canCopy) return
    void copyToClipboard(displayed.join(' / ')).then((ok) => {
      if (!ok) useUi.getState().toast({ title: calcT('tools.calculator.error.invalid_input'), tone: 'danger' })
    })
  }

  const relationKey = (relation: KinshipRelation) => (
    <CalcKey
      key={relation}
      glyph={calcT(RELATION_KEYS[relation].glyph)}
      ariaLabel={calcT(RELATION_KEYS[relation].label)}
      disabled={atLimit}
      className="px-1 text-[length:var(--text-12)]"
      onPress={() => append(relation)}
    />
  )

  return (
    <div className="flex h-full min-h-0 w-full justify-center overflow-y-auto p-3 sm:p-6">
      <div className="flex w-full max-w-[560px] flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
              {calcT('tools.calculator.kinship.title')}
            </h1>
            <p className="mt-0.5 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {calcT('tools.calculator.kinship.note')}
            </p>
          </div>
        </div>

        <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2.5 md:px-4">
          <div className="flex min-h-6 items-center justify-between gap-2">
            <span className="rounded-[var(--r-xs)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[length:var(--text-11)] font-medium tracking-wide text-[var(--text-tertiary)]">
              {calcT('tools.calculator.nav.kinship')}
            </span>
            {canCopy && (
              <Tooltip label={calcT('tools.calculator.common.copy_result')}>
                <IconButton label={calcT('tools.calculator.common.copy_result')} size="sm" className="size-9 md:size-6" onClick={copy}>
                  <Copy size={14} />
                </IconButton>
              </Tooltip>
            )}
          </div>
          {lookup && chain.length > 0 && (
            <div className="mt-1 truncate text-right text-[length:var(--text-12)] text-[var(--text-tertiary)]" title={expression}>
              {expression}
            </div>
          )}
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="mt-2 min-h-[2.2em] break-words text-right font-semibold text-[var(--text-primary)] text-[length:var(--text-26)]"
          >
            {primary}
          </div>
          <div className="mt-1 text-right text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {resultLabel}
          </div>
        </section>

        <div role="group" aria-label={calcT('tools.calculator.a11y.keypad')} className="grid grid-cols-4 gap-1.5">
          {KINSHIP_RELATIONS.slice(0, 2).map(relationKey)}
          <CalcKey glyph={<Delete size={16} />} ariaLabel={calcT('tools.calculator.common.backspace')} variant="function" disabled={chain.length === 0} onPress={backspace} />
          <CalcKey glyph="AC" ariaLabel={calcT('tools.calculator.kinship.clear_all')} variant="function" disabled={chain.length === 0} onPress={clear} />
          {KINSHIP_RELATIONS.slice(2).map(relationKey)}
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <CalcKey
            glyph={calcT('tools.calculator.kinship.reverse')}
            ariaLabel={calcT('tools.calculator.kinship.reverse')}
            variant="function"
            active={reverse}
            disabled={!canReverse}
            className="text-[length:var(--text-13)]"
            onPress={() => setReverse((current) => !current)}
          />
          <CalcKey
            glyph="="
            ariaLabel={calcT('tools.calculator.common.equals')}
            variant="equals"
            disabled={chain.length === 0}
            onPress={compute}
          />
        </div>

        {atLimit && (
          <p className="text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {calcT('tools.calculator.kinship.limit')}
          </p>
        )}
      </div>
    </div>
  )
}
