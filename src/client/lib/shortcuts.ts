import { IS_MAC } from './hotkeys'

export const APP_SHORTCUTS = {
  command: 'mod+shift+p',
  search: 'mod+shift+f',
  // The list search stays on `mod+shift+f`. Omnisearch is the index-backed prompt over every note,
  // and `mod+alt+f` is already the editor's format-code command, so the pair lives on O.
  omnisearch: 'mod+shift+o',
  omnisearchInFile: 'mod+alt+shift+o',
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
  emoji: 'mod+alt+e',
  // The launcher has to be reachable with the editor focused, and `q` is the letter the feature is
  // named after; `mod+shift+a` was left alone because Obsidian users bind it to their palette.
  quickadd: 'mod+shift+q',
  // A show starts on the slide under the editor cursor, so the key has to reach into the editor;
  // `mod+shift+p` is already the command palette.
  present: 'mod+alt+p',
  // The linter rewrites the note under the cursor, so its key has to reach the editor as well. The
  // reference plugin defaults to the same chord, and nothing here had claimed it.
  lintNote: 'mod+alt+l',
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
