import { LocaleType, mergeLocales } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import DesignEnUS from '@univerjs/design/locale/en-US'
import DesignZhCN from '@univerjs/design/locale/zh-CN'
import { UniverDocsPlugin } from '@univerjs/docs'
import { UniverDocsUIPlugin } from '@univerjs/docs-ui'
import DocsUIEnUS from '@univerjs/docs-ui/locale/en-US'
import DocsUIZhCN from '@univerjs/docs-ui/locale/zh-CN'
import { UniverDocsDrawingPlugin } from '@univerjs/docs-drawing'
import { UniverDocsDrawingUIPlugin } from '@univerjs/docs-drawing-ui'
import DocsDrawingUIEnUS from '@univerjs/docs-drawing-ui/locale/en-US'
import DocsDrawingUIZhCN from '@univerjs/docs-drawing-ui/locale/zh-CN'
import { UniverDocsFindReplacePlugin } from '@univerjs/docs-find-replace'
import { UniverDocsHyperLinkPlugin } from '@univerjs/docs-hyper-link'
import { UniverDocsHyperLinkUIPlugin } from '@univerjs/docs-hyper-link-ui'
import DocsHyperLinkUIEnUS from '@univerjs/docs-hyper-link-ui/locale/en-US'
import DocsHyperLinkUIZhCN from '@univerjs/docs-hyper-link-ui/locale/zh-CN'
import { UniverDocsTocPlugin } from '@univerjs/docs-toc'
import { UniverDocsTocUIPlugin } from '@univerjs/docs-toc-ui'
import DocsTocUIEnUS from '@univerjs/docs-toc-ui/locale/en-US'
import DocsTocUIZhCN from '@univerjs/docs-toc-ui/locale/zh-CN'
import { UniverDocsChartThreadCommentPlugin } from '@univerjs-pro/docs-chart-thread-comment'
import { UniverDocsDrawingThreadCommentPlugin } from '@univerjs-pro/docs-drawing-thread-comment'
import { UniverDocsThreadCommentPlugin } from '@univerjs/docs-thread-comment'
import { UniverDocsThreadCommentUIPlugin } from '@univerjs/docs-thread-comment-ui'
import DocsThreadCommentUIEnUS from '@univerjs/docs-thread-comment-ui/locale/en-US'
import DocsThreadCommentUIZhCN from '@univerjs/docs-thread-comment-ui/locale/zh-CN'
import { UniverDrawingPlugin } from '@univerjs/drawing'
import { UniverDrawingUIPlugin } from '@univerjs/drawing-ui'
import DrawingUIEnUS from '@univerjs/drawing-ui/locale/en-US'
import DrawingUIZhCN from '@univerjs/drawing-ui/locale/zh-CN'
import { UniverProFormulaEnginePlugin } from '@univerjs-pro/engine-formula'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { UniverThreadCommentPlugin } from '@univerjs/thread-comment'
import { UniverThreadCommentUIPlugin } from '@univerjs/thread-comment-ui'
import ThreadCommentUIEnUS from '@univerjs/thread-comment-ui/locale/en-US'
import ThreadCommentUIZhCN from '@univerjs/thread-comment-ui/locale/zh-CN'
import { UniverUIPlugin } from '@univerjs/ui'
import UIEnUS from '@univerjs/ui/locale/en-US'
import UIzhCN from '@univerjs/ui/locale/zh-CN'
import { UniverWatermarkPlugin } from '@univerjs/watermark'
import { UniverDocsCalloutPlugin } from '@univerjs-pro/docs-callout'
import { UniverDocsCalloutUIPlugin } from '@univerjs-pro/docs-callout-ui'
import DocsCalloutUIEnUS from '@univerjs-pro/docs-callout-ui/locale/en-US'
import DocsCalloutUIZhCN from '@univerjs-pro/docs-callout-ui/locale/zh-CN'
import { UniverDocsChartPlugin } from '@univerjs-pro/docs-chart'
import { UniverDocsChartUIPlugin } from '@univerjs-pro/docs-chart-ui'
import DocsChartUIEnUS from '@univerjs-pro/docs-chart-ui/locale/en-US'
import DocsChartUIZhCN from '@univerjs-pro/docs-chart-ui/locale/zh-CN'
/*
 * `docs-code-ui` imports one Prism grammar per language but never the base grammars those grammars
 * extend, so a bundler that hands `prismjs` its own copy of the core leaves `clike` undefined and
 * `prism-c` throws while it loads. Importing the bases here registers them on the core the grammars
 * share, before the plugin's own imports run.
 */
import 'prismjs/components/prism-markup'
import 'prismjs/components/prism-css'
import 'prismjs/components/prism-clike'
import 'prismjs/components/prism-javascript'
import { UniverDocsCodePlugin } from '@univerjs-pro/docs-code'
import { UniverDocsCodeUIPlugin } from '@univerjs-pro/docs-code-ui'
import DocsCodeUIEnUS from '@univerjs-pro/docs-code-ui/locale/en-US'
import DocsCodeUIZhCN from '@univerjs-pro/docs-code-ui/locale/zh-CN'
import { UniverDocsColumnPlugin } from '@univerjs-pro/docs-column'
import { UniverDocsColumnUIPlugin } from '@univerjs-pro/docs-column-ui'
import DocsColumnUIEnUS from '@univerjs-pro/docs-column-ui/locale/en-US'
import DocsColumnUIZhCN from '@univerjs-pro/docs-column-ui/locale/zh-CN'
import { UniverDocsFormulaPlugin } from '@univerjs-pro/docs-formula'
import { UniverDocsFormulaUIPlugin } from '@univerjs-pro/docs-formula-ui'
import DocsFormulaUIEnUS from '@univerjs-pro/docs-formula-ui/locale/en-US'
import DocsFormulaUIZhCN from '@univerjs-pro/docs-formula-ui/locale/zh-CN'
import { UniverDocsLatexPlugin } from '@univerjs-pro/docs-latex'
import { UniverDocsLatexUIPlugin } from '@univerjs-pro/docs-latex-ui'
import DocsLatexUIEnUS from '@univerjs-pro/docs-latex-ui/locale/en-US'
import DocsLatexUIZhCN from '@univerjs-pro/docs-latex-ui/locale/zh-CN'
import { UniverDocsListPlugin } from '@univerjs-pro/docs-list'
import { UniverDocsListUIPlugin } from '@univerjs-pro/docs-list-ui'
import DocsListUIEnUS from '@univerjs-pro/docs-list-ui/locale/en-US'
import DocsListUIZhCN from '@univerjs-pro/docs-list-ui/locale/zh-CN'
import { UniverDocsPrintPlugin } from '@univerjs-pro/docs-print'
import DocsPrintEnUS from '@univerjs-pro/docs-print/locale/en-US'
import DocsPrintZhCN from '@univerjs-pro/docs-print/locale/zh-CN'
import { UniverDocsQuotePlugin } from '@univerjs-pro/docs-quote'
import { UniverDocsQuoteUIPlugin } from '@univerjs-pro/docs-quote-ui'
import DocsQuoteUIEnUS from '@univerjs-pro/docs-quote-ui/locale/en-US'
import DocsQuoteUIZhCN from '@univerjs-pro/docs-quote-ui/locale/zh-CN'
import { UniverDocsReferencePlugin } from '@univerjs-pro/docs-reference'
import { UniverDocsReferenceUIPlugin } from '@univerjs-pro/docs-reference-ui'
import DocsReferenceUIEnUS from '@univerjs-pro/docs-reference-ui/locale/en-US'
import DocsReferenceUIZhCN from '@univerjs-pro/docs-reference-ui/locale/zh-CN'
import { UniverDocsSdtPlugin } from '@univerjs-pro/docs-sdt'
import { UniverDocsSdtUIPlugin } from '@univerjs-pro/docs-sdt-ui'
import DocsSdtUIEnUS from '@univerjs-pro/docs-sdt-ui/locale/en-US'
import DocsSdtUIZhCN from '@univerjs-pro/docs-sdt-ui/locale/zh-CN'
import { UniverDocsShapePlugin } from '@univerjs-pro/docs-shape'
import { UniverDocsShapeUIPlugin } from '@univerjs-pro/docs-shape-ui'
import DocsShapeUIEnUS from '@univerjs-pro/docs-shape-ui/locale/en-US'
import DocsShapeUIZhCN from '@univerjs-pro/docs-shape-ui/locale/zh-CN'
import { UniverDocsTablePlugin } from '@univerjs-pro/docs-table'
import { UniverDocsTableUIPlugin } from '@univerjs-pro/docs-table-ui'
import DocsTableUIEnUS from '@univerjs-pro/docs-table-ui/locale/en-US'
import DocsTableUIZhCN from '@univerjs-pro/docs-table-ui/locale/zh-CN'

import '@univerjs/ui/facade'
import '@univerjs/docs/facade'
import '@univerjs/docs-ui/facade'
import '@univerjs/docs-drawing/facade'
import '@univerjs-pro/docs-table/facade'
import '@univerjs-pro/engine-formula/facade'

import '@univerjs/design/lib/index.css'
import '@univerjs/ui/lib/index.css'
import '@univerjs/docs-ui/lib/index.css'
import '@univerjs/drawing-ui/lib/index.css'
import '@univerjs/docs-drawing-ui/lib/index.css'
import '@univerjs/thread-comment-ui/lib/index.css'
import '@univerjs/docs-hyper-link-ui/lib/index.css'
import '@univerjs/docs-toc-ui/lib/index.css'
import '@univerjs/docs-thread-comment-ui/lib/index.css'
import '@univerjs-pro/docs-callout-ui/lib/index.css'
import '@univerjs-pro/docs-chart-ui/lib/index.css'
import '@univerjs-pro/docs-code-ui/lib/index.css'
import '@univerjs-pro/docs-column-ui/lib/index.css'
import '@univerjs-pro/docs-formula-ui/lib/index.css'
import '@univerjs-pro/docs-latex-ui/lib/index.css'
import '@univerjs-pro/docs-list-ui/lib/index.css'
import '@univerjs-pro/docs-print/lib/index.css'
import '@univerjs-pro/docs-quote-ui/lib/index.css'
import '@univerjs-pro/docs-reference-ui/lib/index.css'
import '@univerjs-pro/docs-sdt-ui/lib/index.css'
import '@univerjs-pro/docs-shape-ui/lib/index.css'
import '@univerjs-pro/docs-table-ui/lib/index.css'

import type { OfficeEditPlan } from '@shared/office/ai'
import type { OfficeEditorContext, OfficeEditorProps } from './contracts'
import { OfficeEditorSurface } from './OfficeEditorSurface'
import type { OfficeEditorProduct } from './runtime'

const en = mergeLocales([
  DesignEnUS, UIEnUS, DocsUIEnUS, DrawingUIEnUS, DocsDrawingUIEnUS, ThreadCommentUIEnUS,
  DocsHyperLinkUIEnUS, DocsTocUIEnUS, DocsThreadCommentUIEnUS, DocsCalloutUIEnUS, DocsChartUIEnUS,
  DocsColumnUIEnUS, DocsFormulaUIEnUS, DocsLatexUIEnUS, DocsCodeUIEnUS,
  DocsListUIEnUS, DocsPrintEnUS, DocsQuoteUIEnUS, DocsReferenceUIEnUS, DocsSdtUIEnUS, DocsShapeUIEnUS,
  DocsTableUIEnUS,
])

const zh = mergeLocales([
  DesignZhCN, UIzhCN, DocsUIZhCN, DrawingUIZhCN, DocsDrawingUIZhCN, ThreadCommentUIZhCN,
  DocsHyperLinkUIZhCN, DocsTocUIZhCN, DocsThreadCommentUIZhCN, DocsCalloutUIZhCN, DocsChartUIZhCN,
  DocsColumnUIZhCN, DocsFormulaUIZhCN, DocsLatexUIZhCN, DocsCodeUIZhCN,
  DocsListUIZhCN, DocsPrintZhCN, DocsQuoteUIZhCN, DocsReferenceUIZhCN, DocsSdtUIZhCN, DocsShapeUIZhCN,
  DocsTableUIZhCN,
])

function documentOf(api: FUniver) {
  const document = api.getActiveDocument()
  if (!document) throw new Error('No active document')
  return document
}

async function applyPlan(api: FUniver, plan: OfficeEditPlan): Promise<void> {
  const document = documentOf(api)
  for (const op of plan.ops) {
    switch (op.kind) {
      case 'docs.append-paragraph':
        document.appendParagraph(op.text)
        break
      case 'docs.insert-text':
        document.insertText(op.offset, op.text)
        break
      case 'docs.replace-text': {
        const paragraph = document.findParagraphByText(op.search)
        if (!paragraph) throw new Error(`Text not found: ${op.search.slice(0, 80)}`)
        const index = paragraph.getText().indexOf(op.search)
        if (index < 0) throw new Error(`Text not found: ${op.search.slice(0, 80)}`)
        const start = paragraph.getInfo().startOffset + index
        document.deleteRange({ startOffset: start, endOffset: start + op.search.length })
        document.insertText(start, op.replacement)
        break
      }
      case 'docs.insert-table':
        if (op.values) document.insertTableFromData(op.values)
        else document.insertTable(op.rows, op.columns)
        break
    }
  }
}

const product: OfficeEditorProduct = {
  locales: { [LocaleType.EN_US]: en, [LocaleType.ZH_CN]: zh },
  register(univer, { container }) {
    univer.registerPlugin(UniverRenderEnginePlugin)
    univer.registerPlugin(UniverProFormulaEnginePlugin)
    univer.registerPlugin(UniverUIPlugin, { container, ribbonType: 'grid' })
    univer.registerPlugin(UniverDocsPlugin)
    univer.registerPlugin(UniverDocsUIPlugin)
    univer.registerPlugin(UniverDrawingPlugin)
    univer.registerPlugin(UniverDrawingUIPlugin)
    univer.registerPlugin(UniverDocsDrawingPlugin)
    univer.registerPlugin(UniverDocsDrawingUIPlugin)
    univer.registerPlugin(UniverDocsFindReplacePlugin)
    univer.registerPlugin(UniverDocsHyperLinkPlugin)
    univer.registerPlugin(UniverDocsHyperLinkUIPlugin)
    univer.registerPlugin(UniverDocsTocPlugin)
    univer.registerPlugin(UniverDocsTocUIPlugin)
    univer.registerPlugin(UniverThreadCommentPlugin)
    univer.registerPlugin(UniverThreadCommentUIPlugin)
    univer.registerPlugin(UniverDocsThreadCommentPlugin)
    univer.registerPlugin(UniverDocsThreadCommentUIPlugin)
    univer.registerPlugin(UniverDocsDrawingThreadCommentPlugin)
    univer.registerPlugin(UniverDocsChartThreadCommentPlugin)
    univer.registerPlugin(UniverWatermarkPlugin)
    univer.registerPlugin(UniverDocsCalloutPlugin)
    univer.registerPlugin(UniverDocsCalloutUIPlugin)
    univer.registerPlugin(UniverDocsChartPlugin)
    univer.registerPlugin(UniverDocsChartUIPlugin)
    univer.registerPlugin(UniverDocsCodePlugin)
    univer.registerPlugin(UniverDocsCodeUIPlugin)
    univer.registerPlugin(UniverDocsColumnPlugin)
    univer.registerPlugin(UniverDocsColumnUIPlugin)
    univer.registerPlugin(UniverDocsFormulaPlugin)
    univer.registerPlugin(UniverDocsFormulaUIPlugin)
    univer.registerPlugin(UniverDocsLatexPlugin)
    univer.registerPlugin(UniverDocsLatexUIPlugin)
    univer.registerPlugin(UniverDocsListPlugin)
    univer.registerPlugin(UniverDocsListUIPlugin)
    univer.registerPlugin(UniverDocsPrintPlugin)
    univer.registerPlugin(UniverDocsQuotePlugin)
    univer.registerPlugin(UniverDocsQuoteUIPlugin)
    univer.registerPlugin(UniverDocsReferencePlugin)
    univer.registerPlugin(UniverDocsReferenceUIPlugin)
    univer.registerPlugin(UniverDocsSdtPlugin)
    univer.registerPlugin(UniverDocsSdtUIPlugin)
    univer.registerPlugin(UniverDocsShapePlugin)
    univer.registerPlugin(UniverDocsShapeUIPlugin)
    univer.registerPlugin(UniverDocsTablePlugin)
    univer.registerPlugin(UniverDocsTableUIPlugin)
  },
  create(api, { fileId, title, snapshot }) {
    api.createDocument({ ...(snapshot ?? {}), id: fileId, title })
    return {
      unitId: fileId,
      save: () => api.getActiveDocument()?.save() ?? {},
      context: () => contextOf(api),
    }
  },
  applyPlan,
}

function contextOf(api: FUniver): OfficeEditorContext {
  const document = api.getActiveDocument()
  return {
    paragraphs: document?.getParagraphs().length ?? 0,
    name: document?.getName() ?? '',
  }
}

export function OfficeDocsEditor(props: OfficeEditorProps) {
  return <OfficeEditorSurface {...props} product={product} />
}