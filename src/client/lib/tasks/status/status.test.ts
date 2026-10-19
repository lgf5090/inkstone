import { describe, expect, it } from 'vitest'
import { Status, type StatusConfiguration } from './status'
import { StatusRegistry, validateStatusConfigurations } from './registry'

function configuration(symbol: string, name: string, next: string, type: StatusConfiguration['type']): StatusConfiguration {
  return { symbol, name, nextStatusSymbol: next, availableAsCommand: true, type }
}

describe('Status', () => {
  it('types an unregistered character from its shape alone', () => {
    expect(Status.typeForUnknownSymbol('x')).toBe('DONE')
    expect(Status.typeForUnknownSymbol('X')).toBe('DONE')
    expect(Status.typeForUnknownSymbol('/')).toBe('IN_PROGRESS')
    expect(Status.typeForUnknownSymbol('-')).toBe('CANCELLED')
    expect(Status.typeForUnknownSymbol('')).toBe('EMPTY')
    expect(Status.typeForUnknownSymbol('★')).toBe('TODO')
  })

  it('prefixes group text so the order is meaningful rather than alphabetical', () => {
    expect(Status.IN_PROGRESS.typeGroupText).toBe('%%1%%IN_PROGRESS')
    expect(Status.TODO.typeGroupText).toBe('%%2%%TODO')
    expect(Status.DONE.typeGroupText).toBe('%%4%%DONE')
    expect(Status.CANCELLED.typeGroupText).toBe('%%5%%CANCELLED')
  })

  it('says so when a configuration could not have come from a checkbox', () => {
    expect(Status.createUnknown('★').previewText).toBe('[★] UNKNOWN (★)')
    expect(Status.createUnknown('ab').previewText).toBe('ERROR: More than one character in "ab"')
  })
})

describe('StatusRegistry', () => {
  it('registers exactly the four statuses a fresh install answers with', () => {
    const registry = new StatusRegistry()
    expect(registry.registeredStatuses.map((status) => status.symbol)).toEqual([' ', '/', 'x', '-'])
    expect(registry.bySymbol('h')).toBeNull()
  })

  it('falls back to an unknown status rather than failing on a symbol from an old note', () => {
    const registry = new StatusRegistry()
    expect(registry.bySymbolOrCreate('X').type).toBe('DONE')
    expect(registry.bySymbolOrCreate('★').name).toBe('UNKNOWN (★)')
    expect(registry.bySymbolOrCreate('★').availableAsCommand).toBe(false)
  })

  it('walks the cycle the reader can click through', () => {
    const registry = new StatusRegistry()
    expect(registry.getNextStatusOrCreate(Status.TODO).symbol).toBe('x')
    expect(registry.getNextStatusOrCreate(Status.DONE).symbol).toBe(' ')
    expect(registry.getNextStatusOrCreate(Status.CANCELLED).symbol).toBe(' ')
  })

  it('gives a recurring task an open status even when the chain leads elsewhere', () => {
    const registry = new StatusRegistry([
      configuration(' ', 'Todo', 'x', 'TODO'),
      configuration('x', 'Done', '/', 'DONE'),
      configuration('/', 'In Progress', 'x', 'IN_PROGRESS'),
    ])
    expect(registry.getNextStatusOrCreate(Status.TODO).type).toBe('DONE')
    expect(registry.getNextRecurrenceStatusOrCreate(Status.TODO).symbol).toBe('/')
  })

  it('terminates on a chain with no open status and falls back to a space', () => {
    const registry = new StatusRegistry([
      configuration('x', 'Done', '-', 'DONE'),
      configuration('-', 'Cancelled', 'x', 'CANCELLED'),
    ])
    const from = registry.bySymbolOrCreate('x')
    expect(registry.getNextRecurrenceStatusOrCreate(from).symbol).toBe(' ')
  })

  it('lists the characters the reader never defined', () => {
    const registry = new StatusRegistry()
    expect(registry.findUnknownStatuses([' ', '★', '★', 'x']).map((status) => status.symbol)).toEqual(['★'])
  })
})

describe('validateStatusConfigurations', () => {
  it('accepts the defaults', () => {
    expect(validateStatusConfigurations(new StatusRegistry().registeredStatuses.map((status) => status.configuration))).toEqual([])
  })

  it('catches every way a table can make toggling unsafe', () => {
    const failures = validateStatusConfigurations([
      configuration(' ', 'Todo', 'x', 'TODO'),
      configuration(' ', 'Second Todo', 'x', 'TODO'),
      configuration('x', 'Done', 'missing', 'DONE'),
      configuration('ab', 'Too long', ' ', 'TODO'),
      configuration('?', '  ', ' ', 'TODO'),
    ])
    expect(failures.map((failure) => failure.reason)).toEqual([
      'duplicate-symbol',
      'missing-next',
      'bad-symbol',
      'empty-name',
    ])
  })
})
