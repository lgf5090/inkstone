/**
 * The Tools address is the source of truth for which module opens.
 *
 * A module chosen in this browser was persisted and replayed even for `/tools/qrcode`, so a bookmark
 * opened Short Links. These cases pin the path-to-module reading and the path the sidebar links with.
 */
import { describe, expect, it } from 'vitest'
import { calculatorViewFromSearch, toolsPathForSubmodule, toolsSubmoduleFromPath } from './store'
import { promptOptimizerViewFromSearch } from './prompt-optimizer/store'

describe('tools submodule routing', () => {
  it('reads the module a deep address names', () => {
    expect(toolsSubmoduleFromPath('/tools/password')).toBe('password')
    expect(toolsSubmoduleFromPath('/tools/qrcode/story')).toBe('qrcode')
    expect(toolsSubmoduleFromPath('/tools/calculator?view=graph')).toBe('calculator')
    expect(toolsSubmoduleFromPath('/tools/shortlinks')).toBe('shortlinks')
  })

  it('leaves the bare tools address to the remembered module', () => {
    expect(toolsSubmoduleFromPath('/tools')).toBeNull()
    expect(toolsSubmoduleFromPath('/tools/')).toBeNull()
    expect(toolsSubmoduleFromPath('/tools/not-a-module')).toBeNull()
  })

  it('links every module back with the address it can be read from', () => {
    for (const submodule of ['password', 'qrcode', 'id_photo', 'color', 'shortlinks', 'calculator', 'compare', 'network_panel', 'prompt_optimizer'] as const) {
      expect(toolsSubmoduleFromPath(toolsPathForSubmodule(submodule))).toBe(submodule)
    }
  })
})

describe('prompt optimizer view routing', () => {
  it('reads the view a prompt optimizer query names', () => {
    expect(promptOptimizerViewFromSearch('?view=favorites')).toBe('favorites')
    expect(promptOptimizerViewFromSearch('?view=pro_multi')).toBe('pro_multi')
    expect(promptOptimizerViewFromSearch('?view=not-a-view')).toBeNull()
    expect(promptOptimizerViewFromSearch('')).toBeNull()
  })
})

describe('calculator view routing', () => {
  it('reads the view a calculator query names', () => {
    expect(calculatorViewFromSearch('?view=textcalc')).toBe('textcalc')
    expect(calculatorViewFromSearch('?view=kinship')).toBe('kinship')
    expect(calculatorViewFromSearch('?view=not-a-view')).toBeNull()
    expect(calculatorViewFromSearch('')).toBeNull()
  })
})
