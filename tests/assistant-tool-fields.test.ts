import { describe, expect, it } from 'vitest'
import { ALL_TOOLS } from '../src/worker/assistant/tools'

/**
 * A tool must not read an argument it never declared.
 *
 * `validateArgs` walks the declared field list and copies only those keys, so a handler that reaches for
 * an undeclared one reads `undefined` forever — the call is accepted, the field is silently ignored, and
 * the model is told the change took effect. This happened to `update_subscription`, which read `startDate`
 * without declaring it. No type error and no failing call could show it, because the code is valid and the
 * call does succeed.
 *
 * The guard reads the source of the compiled handler rather than calling it, because a call can only prove
 * the one argument it happens to pass.
 */

const READS = /\bargs\?*\.\s*([a-zA-Z_][\w]*)/g

function readsArguments(source: string): string[] {
  const names = new Set<string>()
  for (const match of source.matchAll(READS)) names.add(match[1])
  return [...names]
}

describe('the argument contract of every assistant tool', () => {
  it('declares each field its handler reads', () => {
    const offenders: string[] = []
    for (const definition of ALL_TOOLS) {
      const declared = Object.keys(definition.fields)
      const source = 'run' in definition
        ? definition.run.toString()
        : `${definition.prepare.toString()}\n${definition.commit.toString()}`
      for (const name of readsArguments(source)) {
        if (!declared.includes(name)) offenders.push(`${definition.name} reads args.${name}`)
      }
    }
    expect(offenders, `undeclared arguments:\n${offenders.join('\n')}`).toEqual([])
  })

  it('refuses a field it did not advertise, instead of accepting and dropping it', async () => {
    const update = ALL_TOOLS.find((definition) => definition.name === 'update_subscription')
    expect(update, 'update_subscription is registered').toBeDefined()
    const fields = update!.fields
    // The two dates used to be missing from this list, which is how a conversation could not move when a
    // plan started or keep it on the lunar calendar even though the row supports both. Switching a plan on
    // or off is deliberately not here: that is what `set_subscription_active` is for, so one verb per call.
    for (const name of ['startDate', 'useLunar', 'autoRenew']) {
      expect(fields, `${name} must be declared to be honoured`).toHaveProperty(name)
    }
    const create = ALL_TOOLS.find((definition) => definition.name === 'create_subscription')!
    for (const name of ['useLunar', 'autoRenew', 'isActive', 'trialEndsAt']) {
      expect(create.fields, `${name} must be declared to be honoured`).toHaveProperty(name)
    }
  })
})
