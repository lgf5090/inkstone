/**
 * The CodeMirror surface behind both text views.
 *
 * `@codemirror/merge` does the aligning, the gutters, the folding and the inline marks; this host
 * only decides which of its two shapes to build and hands it the diff the screen actually counted.
 * When any option is in force the package's own diff would disagree with the number printed above,
 * so the precomputed change ranges are passed through `diffConfig.override` — the same answer the
 * statistics came from is the one the reader sees.
 */
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { EditorSelection, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { Change, MergeView, uncollapseUnchanged, unifiedMergeView } from '@codemirror/merge'
import { FOLD_MARGIN, FOLD_MIN_SIZE, hasTextOptions, type TextCompareOptions, type TextDiffResult, type TextViewMode } from '@shared/tools/compare/types'
import { compareBaseExtensions } from './editor'
import type { CompareLanguage } from '../store'

export interface MergeHostHandle {
  jumpToHunk: (index: number, direction: 1 | -1) => void
  selectAllDiffs: () => void
}

export interface MergeHostProps {
  left: string
  right: string
  diff: TextDiffResult
  options: TextCompareOptions
  mode: TextViewMode
  collapseUnchanged: boolean
  language: CompareLanguage
  leftName: string
  rightName: string
  ref?: Ref<MergeHostHandle>
}

const MAX_SELECTED_RANGES = 500

function canOverride(options: TextCompareOptions): boolean {
  return hasTextOptions(options) || options.leftRange !== null || options.rightRange !== null
}

export function MergeHost({ left, right, diff, options, mode, collapseUnchanged, language, leftName, rightName, ref }: MergeHostProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<MergeView | EditorView | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.replaceChildren()
    const base: Extension[] = compareBaseExtensions(language, leftName)
    const second: Extension[] = compareBaseExtensions(language, rightName)
    const shared = {
      collapseUnchanged: collapseUnchanged ? { margin: FOLD_MARGIN, minSize: FOLD_MIN_SIZE } : undefined,
      diffConfig: canOverride(options)
        // `Chunk.build` calls `offset` on every change it receives, so a plain object would fail at
        // runtime even though it has the same four numbers.
        ? { override: () => diff.changes.map((change) => new Change(change.fromA, change.toA, change.fromB, change.toB)) }
        : undefined,
    }

    if (mode === 'side_by_side') {
      const view = new MergeView({
        a: { doc: left, extensions: base },
        b: { doc: right, extensions: second },
        parent: host,
        orientation: 'a-b',
        gutter: true,
        highlightChanges: true,
        ...shared,
      })
      viewRef.current = view
      return () => {
        view.destroy()
        viewRef.current = null
      }
    }

    const view = new EditorView({
      parent: host,
      doc: right,
      extensions: [
        ...base,
        unifiedMergeView({
          original: left,
          gutter: true,
          highlightChanges: true,
          allowInlineDiffs: true,
          mergeControls: false,
          ...shared,
        }),
      ],
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [left, right, diff, options, mode, collapseUnchanged, language, leftName, rightName])

  useImperativeHandle(ref, () => ({
    jumpToHunk: (index, direction) => {
      const view = viewRef.current
      const hunk = diff.hunks[index]
      if (!view || !hunk) return
      const targetLine = mode === 'side_by_side' ? hunk.leftStart : hunk.rightStart
      const editor = view instanceof MergeView ? view.a : view
      const lineNumber = Math.min(Math.max(1, targetLine), editor.state.doc.lines)
      const position = editor.state.doc.line(lineNumber).from
      editor.dispatch({
        selection: { anchor: position },
        effects: [
          uncollapseUnchanged.of(position),
          EditorView.scrollIntoView(position, { y: 'start', yMargin: 48 }),
        ],
      })
      editor.focus()
      void direction
    },
    selectAllDiffs: () => {
      const view = viewRef.current
      if (!view) return
      const editors = view instanceof MergeView ? [view.a, view.b] : [view]
      for (const editor of editors) {
        const ranges = diff.hunks.slice(0, MAX_SELECTED_RANGES).map((hunk) => {
          const startLine = Math.min(Math.max(1, hunk.leftStart), editor.state.doc.lines)
          const endLine = Math.min(Math.max(startLine, hunk.leftEnd), editor.state.doc.lines)
          return EditorSelection.range(editor.state.doc.line(startLine).from, editor.state.doc.line(endLine).to)
        })
        editor.dispatch({ selection: EditorSelection.create(ranges, 0) })
      }
    },
  }), [diff, mode])

  return <div ref={hostRef} data-testid="compare-merge-host" className="h-full min-h-0 w-full overflow-hidden" />
}
