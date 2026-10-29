/** The editor's keyboard layer: shortcuts that only act while a note is open and no field or dialog owns the key. */
import { useEffect, useRef } from 'react'
import { registerAll } from '../../lib/hotkeys'
import { t } from '../../lib/i18n'

export interface InknoteHotkeyHandlers {
  enabled: () => boolean
  undo: () => void
  redo: () => void
  save: () => void
  newNote: () => void
  find: () => void
  outline: () => void
  present: () => void
  exportPage: () => void
  previousPage: () => void
  nextPage: () => void
  selectAll: () => void
  copySelection: () => void
  pasteSelection: () => void
  deleteSelection: () => void
}

export function useInknoteHotkeys(handlers: InknoteHotkeyHandlers): void {
  const live = useRef(handlers)
  live.current = handlers
  useEffect(() => registerAll([
    { id: 'inknote.undo', combo: 'mod+z', description: () => t('inknote.action.undo'), group: () => t('inknote.help.keyboard'), enabled: () => live.current.enabled(), handler: () => live.current.undo() },
    { id: 'inknote.redo', combo: 'mod+shift+z', description: () => t('inknote.action.redo'), group: () => t('inknote.help.keyboard'), enabled: () => live.current.enabled(), handler: () => live.current.redo() },
    { id: 'inknote.redo-alt', combo: 'mod+y', description: () => t('inknote.action.redo'), group: () => t('inknote.help.keyboard'), enabled: () => live.current.enabled(), handler: () => live.current.redo(), hidden: true },
    { id: 'inknote.save', combo: 'mod+s', description: () => t('inknote.save'), group: () => t('inknote.help.keyboard'), enabled: () => live.current.enabled(), handler: () => live.current.save() },
    { id: 'inknote.new-note', combo: 'mod+n', description: () => t('inknote.new_note'), group: () => t('inknote.help.keyboard'), enabled: () => live.current.enabled(), handler: () => live.current.newNote() },
    { id: 'inknote.find', combo: 'mod+f', description: () => t('inknote.action.find'), group: () => t('inknote.help.keyboard'), enabled: () => live.current.enabled(), handler: () => live.current.find() },
    { id: 'inknote.outline', combo: 'mod+g', description: () => t('inknote.action.outline'), group: () => t('inknote.help.keyboard'), enabled: () => live.current.enabled(), handler: () => live.current.outline() },
    { id: 'inknote.present', combo: 'mod+p', description: () => t('inknote.action.presentation'), group: () => t('inknote.help.keyboard'), enabled: () => live.current.enabled(), handler: () => live.current.present() },
    { id: 'inknote.export-page', combo: 'mod+shift+p', description: () => t('inknote.action.export_page_png'), group: () => t('inknote.help.keyboard'), enabled: () => live.current.enabled(), handler: () => live.current.exportPage() },
    { id: 'inknote.previous-page', combo: 'pageup', description: () => t('inknote.page.prev'), group: () => t('inknote.help.keyboard'), enabled: () => live.current.enabled(), handler: () => live.current.previousPage() },
    { id: 'inknote.next-page', combo: 'pagedown', description: () => t('inknote.page.next'), group: () => t('inknote.help.keyboard'), enabled: () => live.current.enabled(), handler: () => live.current.nextPage() },
    { id: 'inknote.select-all', combo: 'mod+a', description: () => t('inknote.action.select_all'), group: () => t('inknote.help.keyboard'), enabled: () => live.current.enabled(), handler: () => live.current.selectAll() },
    { id: 'inknote.copy', combo: 'mod+c', description: () => t('inknote.action.copy_selection'), group: () => t('inknote.help.keyboard'), enabled: () => live.current.enabled(), handler: () => live.current.copySelection() },
    { id: 'inknote.paste', combo: 'mod+v', description: () => t('inknote.action.paste_selection'), group: () => t('inknote.help.keyboard'), enabled: () => live.current.enabled(), handler: () => live.current.pasteSelection() },
    { id: 'inknote.delete-selection', combo: 'delete', description: () => t('inknote.action.delete_selection'), group: () => t('inknote.help.keyboard'), enabled: () => live.current.enabled(), handler: () => live.current.deleteSelection() },
    { id: 'inknote.backspace-selection', combo: 'backspace', description: () => t('inknote.action.delete_selection'), group: () => t('inknote.help.keyboard'), enabled: () => live.current.enabled(), handler: () => live.current.deleteSelection(), hidden: true },
  ]), [])
}
