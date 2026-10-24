import { beforeEach, describe, expect, it } from 'vitest'
import {
  attachTemplaterPickerHost,
  closeTemplaterPicker,
  openTemplaterPicker,
  openTemplaterPickerForFolder,
  peekTemplaterPicker,
} from './picker-request'
import { useUi } from '../../store/ui'

/**
 * The chooser's request signal, which is the only thing a command can actually set.
 *
 * The rule under test is the one `confirm()` states outright: with no host there is no dialog, and the ask
 * must say so rather than vanish. The folder half matters as much — the destination is the folder the
 * explorer is on, because a second channel carrying "which folder" is how the two start to disagree.
 */

describe('the templater chooser request', () => {
  beforeEach(() => {
    closeTemplaterPicker()
    useUi.setState({ view: 'all', folderId: null, panel: null, expandedFolders: [] } as never)
  })

  it('leaves the ask standing when a host is already on screen', () => {
    const detach = attachTemplaterPickerHost()
    try {
      expect(openTemplaterPicker('insert')).toBe(true)
      expect(peekTemplaterPicker()).toEqual({ mode: 'insert' })
    } finally {
      detach()
    }
  })

  it('raises the library to host it when nothing is listening, and keeps the ask for the next frame', () => {
    expect(openTemplaterPicker('create')).toBe(false)
    expect(useUi.getState().panel).toBe('templates')
    expect(peekTemplaterPicker()).toEqual({ mode: 'create' })
  })

  it('puts the library back down with the chooser it raised, and only then', () => {
    openTemplaterPicker('create')
    closeTemplaterPicker()
    expect(peekTemplaterPicker()).toBeNull()
    expect(useUi.getState().panel).toBeNull()
    // A request answered by a host that was already up never closes a panel the reader opened themselves.
    const detach = attachTemplaterPickerHost()
    useUi.getState().openPanel('templates')
    openTemplaterPicker('insert')
    closeTemplaterPicker()
    expect(useUi.getState().panel).toBe('templates')
    detach()
    closeTemplaterPicker()
  })

  it('moves the explorer to the folder before asking, so the chooser has one place to read', () => {
    useUi.getState().openExplorer(null)
    openTemplaterPickerForFolder('create', 'folder-7')
    const ui = useUi.getState()
    expect(ui.folderId).toBe('folder-7')
    expect(ui.view).toBe('folder')
    expect(ui.expandedFolders).toContain('folder-7')
    expect(peekTemplaterPicker()).toEqual({ mode: 'create' })
  })

  it('closes once, and an empty close takes nothing else down', () => {
    openTemplaterPicker('replace')
    expect(peekTemplaterPicker()).toEqual({ mode: 'replace' })
    closeTemplaterPicker()
    closeTemplaterPicker()
    expect(peekTemplaterPicker()).toBeNull()
    // The reader's own panel, opened while nothing was asked for, is not this signal's to close.
    useUi.getState().openPanel('templates')
    closeTemplaterPicker()
    expect(useUi.getState().panel).toBe('templates')
  })
})
