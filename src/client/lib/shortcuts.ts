import { IS_MAC } from './hotkeys'

export const APP_SHORTCUTS = {
  command: 'mod+shift+p',
  search: 'mod+shift+f',
  graph: 'mod+shift+g',
  newNote: IS_MAC ? 'mod+alt+shift+n' : 'mod+alt+n',
  templates: 'mod+shift+n',
  settings: 'mod+,',
  toggleList: IS_MAC ? 'mod+alt+shift+b' : 'mod+alt+b',
  cycleLayout: 'mod+\\',
  shortcuts: 'mod+shift+/',
  save: 'mod+s',
  star: 'mod+alt+s',
  outline: 'mod+alt+o',
  // A show starts on the slide under the editor cursor, so the key has to reach into the editor;
  // `mod+shift+p` is already the command palette.
  present: 'mod+alt+p',
} as const

export const NOTE_LIST_SHORTCUTS = {
  delete: IS_MAC ? 'mod+backspace' : 'delete',
} as const

export function codeMirrorKey(combo: string): string {
  const names: Record<string, string> = {
    mod: 'Mod', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift',
    enter: 'Enter', escape: 'Escape', tab: 'Tab',
    arrowup: 'ArrowUp', arrowdown: 'ArrowDown',
  }
  return combo.split('+').map((part) => names[part.toLowerCase()] ?? part).join('-')
}
