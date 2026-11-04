/**
 * The compare tool's page state.
 *
 * What is here is what the reader is looking at, not what the server knows: the two sides in the
 * editor, the options applied to them, and which view is up. Saved projects and statistics live on
 * the server and are fetched by the views that draw them.
 */
import { create } from 'zustand'
import {
  DEFAULT_TEXT_OPTIONS,
  normalizeTextOptions,
  type CompareKind,
  type TextCompareOptions,
  type TextViewMode,
} from '@shared/tools/compare/types'

export interface CompareSide {
  text: string
  name: string
  bytes: number
  encoding: string | null
}

export const EMPTY_SIDE: CompareSide = { text: '', name: '', bytes: 0, encoding: null }

export type CompareLanguage = 'auto' | 'plain' | 'javascript' | 'typescript' | 'json' | 'markdown' | 'sql' | 'css' | 'html' | 'xml' | 'yaml' | 'toml' | 'python' | 'shell' | 'c' | 'cpp' | 'java' | 'go' | 'rust' | 'diff' | 'properties'

export interface CompareState {
  left: CompareSide
  right: CompareSide
  options: TextCompareOptions
  mode: TextViewMode
  collapseUnchanged: boolean
  language: CompareLanguage
  /** Which kind the last comparison was, so a saved project can be filed correctly. */
  kind: CompareKind

  setSide: (side: 'left' | 'right', value: CompareSide) => void
  swapSides: () => void
  resetSides: () => void
  setOptions: (patch: Partial<TextCompareOptions>) => void
  resetOptions: () => void
  setMode: (mode: TextViewMode) => void
  setCollapseUnchanged: (value: boolean) => void
  setLanguage: (language: CompareLanguage) => void
  setKind: (kind: CompareKind) => void
  /** Replaces both sides at once, which is what opening a project does. */
  loadSides: (left: CompareSide, right: CompareSide, options?: TextCompareOptions, kind?: CompareKind) => void
}

export const useCompareStore = create<CompareState>((set, get) => ({
  left: EMPTY_SIDE,
  right: EMPTY_SIDE,
  options: DEFAULT_TEXT_OPTIONS,
  mode: 'side_by_side',
  collapseUnchanged: true,
  language: 'auto',
  kind: 'text',

  setSide: (side, value) => set({ [side]: value } as Pick<CompareState, 'left' | 'right'>),
  swapSides: () => set({ left: get().right, right: get().left }),
  resetSides: () => set({ left: EMPTY_SIDE, right: EMPTY_SIDE }),
  setOptions: (patch) => set({ options: normalizeTextOptions({ ...get().options, ...patch }) }),
  resetOptions: () => set({ options: DEFAULT_TEXT_OPTIONS }),
  setMode: (mode) => set({ mode }),
  setCollapseUnchanged: (value) => set({ collapseUnchanged: value }),
  setLanguage: (language) => set({ language }),
  setKind: (kind) => set({ kind }),
  loadSides: (left, right, options, kind) => set({
    left,
    right,
    options: options ? normalizeTextOptions(options) : get().options,
    kind: kind ?? 'text',
  }),
}))
