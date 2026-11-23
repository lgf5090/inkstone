import { LocaleType, mergeLocales } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import DesignEnUS from '@univerjs/design/locale/en-US'
import DesignZhCN from '@univerjs/design/locale/zh-CN'
import { UniverDocsPlugin } from '@univerjs/docs'
import { UniverDocsUIPlugin } from '@univerjs/docs-ui'
import DocsUIEnUS from '@univerjs/docs-ui/locale/en-US'
import DocsUIZhCN from '@univerjs/docs-ui/locale/zh-CN'
import { UniverDrawingPlugin } from '@univerjs/drawing'
import { UniverDrawingUIPlugin } from '@univerjs/drawing-ui'
import DrawingUIEnUS from '@univerjs/drawing-ui/locale/en-US'
import DrawingUIZhCN from '@univerjs/drawing-ui/locale/zh-CN'
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import SheetsEnUS from '@univerjs/sheets/locale/en-US'
import SheetsZhCN from '@univerjs/sheets/locale/zh-CN'
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula'
import { UniverSheetsFormulaUIPlugin } from '@univerjs/sheets-formula-ui'
import SheetsFormulaUIEnUS from '@univerjs/sheets-formula-ui/locale/en-US'
import SheetsFormulaUIZhCN from '@univerjs/sheets-formula-ui/locale/zh-CN'
import { UniverSheetsNumfmtPlugin } from '@univerjs/sheets-numfmt'
import { UniverSheetsNumfmtUIPlugin } from '@univerjs/sheets-numfmt-ui'
import SheetsNumfmtUIEnUS from '@univerjs/sheets-numfmt-ui/locale/en-US'
import SheetsNumfmtUIZhCN from '@univerjs/sheets-numfmt-ui/locale/zh-CN'
import { UniverSheetsUIPlugin } from '@univerjs/sheets-ui'
import SheetsUIEnUS from '@univerjs/sheets-ui/locale/en-US'
import SheetsUIZhCN from '@univerjs/sheets-ui/locale/zh-CN'
import { UniverSheetsConditionalFormattingPlugin } from '@univerjs/sheets-conditional-formatting'
import { UniverSheetsConditionalFormattingUIPlugin } from '@univerjs/sheets-conditional-formatting-ui'
import SheetsConditionalFormattingUIEnUS from '@univerjs/sheets-conditional-formatting-ui/locale/en-US'
import SheetsConditionalFormattingUIZhCN from '@univerjs/sheets-conditional-formatting-ui/locale/zh-CN'
import { UniverSheetsCrosshairHighlightPlugin } from '@univerjs/sheets-crosshair-highlight'
import { UniverSheetsDataValidationPlugin } from '@univerjs/sheets-data-validation'
import { UniverSheetsDataValidationUIPlugin } from '@univerjs/sheets-data-validation-ui'
import SheetsDataValidationUIEnUS from '@univerjs/sheets-data-validation-ui/locale/en-US'
import SheetsDataValidationUIZhCN from '@univerjs/sheets-data-validation-ui/locale/zh-CN'
import { UniverSheetsDrawingPlugin } from '@univerjs/sheets-drawing'
import { UniverSheetsDrawingUIPlugin } from '@univerjs/sheets-drawing-ui'
import SheetsDrawingUIEnUS from '@univerjs/sheets-drawing-ui/locale/en-US'
import SheetsDrawingUIZhCN from '@univerjs/sheets-drawing-ui/locale/zh-CN'
import { UniverSheetsFilterPlugin } from '@univerjs/sheets-filter'
import { UniverSheetsFilterUIPlugin } from '@univerjs/sheets-filter-ui'
import SheetsFilterUIEnUS from '@univerjs/sheets-filter-ui/locale/en-US'
import SheetsFilterUIZhCN from '@univerjs/sheets-filter-ui/locale/zh-CN'
import { UniverSheetsFindReplacePlugin } from '@univerjs/sheets-find-replace'
import { UniverSheetsHyperLinkPlugin } from '@univerjs/sheets-hyper-link'
import { UniverSheetsHyperLinkUIPlugin } from '@univerjs/sheets-hyper-link-ui'
import SheetsHyperLinkUIEnUS from '@univerjs/sheets-hyper-link-ui/locale/en-US'
import SheetsHyperLinkUIZhCN from '@univerjs/sheets-hyper-link-ui/locale/zh-CN'
import { UniverSheetsNotePlugin } from '@univerjs/sheets-note'
import { UniverSheetsNoteUIPlugin } from '@univerjs/sheets-note-ui'
import SheetsNoteUIEnUS from '@univerjs/sheets-note-ui/locale/en-US'
import SheetsNoteUIZhCN from '@univerjs/sheets-note-ui/locale/zh-CN'
import { UniverSheetsSortPlugin } from '@univerjs/sheets-sort'
import { UniverSheetsSortUIPlugin } from '@univerjs/sheets-sort-ui'
import SheetsSortUIEnUS from '@univerjs/sheets-sort-ui/locale/en-US'
import SheetsSortUIZhCN from '@univerjs/sheets-sort-ui/locale/zh-CN'
import { UniverSheetsTablePlugin } from '@univerjs/sheets-table'
import { UniverSheetsTableUIPlugin } from '@univerjs/sheets-table-ui'
import SheetsTableUIEnUS from '@univerjs/sheets-table-ui/locale/en-US'
import SheetsTableUIZhCN from '@univerjs/sheets-table-ui/locale/zh-CN'
import { UniverSheetsChartThreadCommentPlugin } from '@univerjs-pro/sheets-chart-thread-comment'
import { UniverSlicerPlugin } from '@univerjs-pro/slicer'
import { UniverSheetsDrawingThreadCommentPlugin } from '@univerjs-pro/sheets-drawing-thread-comment'
import { UniverSheetsThreadCommentPlugin } from '@univerjs/sheets-thread-comment'
import { UniverSheetsThreadCommentUIPlugin } from '@univerjs/sheets-thread-comment-ui'
import SheetsThreadCommentUIEnUS from '@univerjs/sheets-thread-comment-ui/locale/en-US'
import SheetsThreadCommentUIZhCN from '@univerjs/sheets-thread-comment-ui/locale/zh-CN'
import { UniverThreadCommentPlugin } from '@univerjs/thread-comment'
import { UniverThreadCommentUIPlugin } from '@univerjs/thread-comment-ui'
import ThreadCommentUIEnUS from '@univerjs/thread-comment-ui/locale/en-US'
import ThreadCommentUIZhCN from '@univerjs/thread-comment-ui/locale/zh-CN'
import { UniverUIPlugin } from '@univerjs/ui'
import UIEnUS from '@univerjs/ui/locale/en-US'
import UIzhCN from '@univerjs/ui/locale/zh-CN'
import { UniverWatermarkPlugin } from '@univerjs/watermark'
import { UniverSheetsChartPlugin } from '@univerjs-pro/sheets-chart'
import { UniverSheetsChartUIPlugin } from '@univerjs-pro/sheets-chart-ui'
import SheetsChartUIEnUS from '@univerjs-pro/sheets-chart-ui/locale/en-US'
import SheetsChartUIZhCN from '@univerjs-pro/sheets-chart-ui/locale/zh-CN'
import { UniverSheetsOutlinePlugin } from '@univerjs-pro/sheets-outline'
import { UniverSheetsOutlineUIPlugin } from '@univerjs-pro/sheets-outline-ui'
import SheetsOutlineUIEnUS from '@univerjs-pro/sheets-outline-ui/locale/en-US'
import SheetsOutlineUIZhCN from '@univerjs-pro/sheets-outline-ui/locale/zh-CN'
import { UniverSheetsPivotTablePlugin } from '@univerjs-pro/sheets-pivot'
import { UniverSheetsPivotTableUIPlugin } from '@univerjs-pro/sheets-pivot-ui'
import SheetsPivotUIEnUS from '@univerjs-pro/sheets-pivot-ui/locale/en-US'
import SheetsPivotUIZhCN from '@univerjs-pro/sheets-pivot-ui/locale/zh-CN'
import { UniverSheetsPivotChartPlugin } from '@univerjs-pro/sheets-pivot-chart'
import { UniverSheetsPivotChartUIPlugin } from '@univerjs-pro/sheets-pivot-chart-ui'
import SheetsPivotChartUIEnUS from '@univerjs-pro/sheets-pivot-chart-ui/locale/en-US'
import SheetsPivotChartUIZhCN from '@univerjs-pro/sheets-pivot-chart-ui/locale/zh-CN'
import { UniverSheetsPrintPlugin } from '@univerjs-pro/sheets-print'
import SheetsPrintEnUS from '@univerjs-pro/sheets-print/locale/en-US'
import SheetsPrintZhCN from '@univerjs-pro/sheets-print/locale/zh-CN'
import { UniverSheetsShapePlugin } from '@univerjs-pro/sheets-shape'
import { UniverSheetsShapeUIPlugin } from '@univerjs-pro/sheets-shape-ui'
import SheetsShapeUIEnUS from '@univerjs-pro/sheets-shape-ui/locale/en-US'
import SheetsShapeUIZhCN from '@univerjs-pro/sheets-shape-ui/locale/zh-CN'
import { UniverSheetsSlicerPlugin } from '@univerjs-pro/sheets-slicer'
import { UniverSheetsSlicerUIPlugin } from '@univerjs-pro/sheets-slicer-ui'
import SheetsSlicerUIEnUS from '@univerjs-pro/sheets-slicer-ui/locale/en-US'
import SheetsSlicerUIZhCN from '@univerjs-pro/sheets-slicer-ui/locale/zh-CN'
import { UniverSheetSparklinePlugin } from '@univerjs-pro/sheets-sparkline'
import { UniverSheetSparklineUIPlugin } from '@univerjs-pro/sheets-sparkline-ui'
import SheetsSparklineUIEnUS from '@univerjs-pro/sheets-sparkline-ui/locale/en-US'
import SheetsSparklineUIZhCN from '@univerjs-pro/sheets-sparkline-ui/locale/zh-CN'

import '@univerjs/engine-formula/facade'
import '@univerjs/ui/facade'
import '@univerjs/docs-ui/facade'
import '@univerjs/sheets/facade'
import '@univerjs/sheets-ui/facade'
import '@univerjs/sheets-formula/facade'
import '@univerjs/sheets-numfmt/facade'
import '@univerjs-pro/engine-formula/facade'

import '@univerjs/design/lib/index.css'
import '@univerjs/ui/lib/index.css'
import '@univerjs/docs-ui/lib/index.css'
import '@univerjs/sheets-ui/lib/index.css'
import '@univerjs/sheets-formula-ui/lib/index.css'
import '@univerjs/sheets-numfmt-ui/lib/index.css'
import '@univerjs/sheets-table-ui/lib/index.css'
import '@univerjs/sheets-thread-comment-ui/lib/index.css'
import '@univerjs/thread-comment-ui/lib/index.css'
import '@univerjs-pro/sheets-chart-ui/lib/index.css'
import '@univerjs-pro/sheets-outline-ui/lib/index.css'
import '@univerjs-pro/sheets-pivot-ui/lib/index.css'
import '@univerjs-pro/sheets-pivot-chart-ui/lib/index.css'
import '@univerjs-pro/sheets-print/lib/index.css'
import '@univerjs-pro/sheets-shape-ui/lib/index.css'
import '@univerjs-pro/sheets-slicer-ui/lib/index.css'
import '@univerjs-pro/sheets-sparkline-ui/lib/index.css'

import type { OfficeEditPlan } from '@shared/office/ai'
import type { OfficeEditorContext, OfficeEditorProps } from './contracts'
import { OfficeEditorSurface } from './OfficeEditorSurface'
import type { OfficeEditorProduct } from './runtime'

const en = mergeLocales([
  DesignEnUS, UIEnUS, DocsUIEnUS, SheetsEnUS, SheetsUIEnUS, SheetsFormulaUIEnUS, SheetsNumfmtUIEnUS,
  SheetsConditionalFormattingUIEnUS, SheetsDataValidationUIEnUS, SheetsDrawingUIEnUS,
  SheetsFilterUIEnUS, SheetsHyperLinkUIEnUS, SheetsNoteUIEnUS, SheetsSortUIEnUS, SheetsTableUIEnUS,
  SheetsThreadCommentUIEnUS, ThreadCommentUIEnUS,
  SheetsChartUIEnUS, SheetsOutlineUIEnUS,
  SheetsPivotUIEnUS, SheetsPivotChartUIEnUS, SheetsPrintEnUS, SheetsShapeUIEnUS, SheetsSlicerUIEnUS,
  SheetsSparklineUIEnUS, DrawingUIEnUS,
])

const zh = mergeLocales([
  DesignZhCN, UIzhCN, DocsUIZhCN, SheetsZhCN, SheetsUIZhCN, SheetsFormulaUIZhCN, SheetsNumfmtUIZhCN,
  SheetsConditionalFormattingUIZhCN, SheetsDataValidationUIZhCN, SheetsDrawingUIZhCN,
  SheetsFilterUIZhCN, SheetsHyperLinkUIZhCN, SheetsNoteUIZhCN, SheetsSortUIZhCN, SheetsTableUIZhCN,
  SheetsThreadCommentUIZhCN, ThreadCommentUIZhCN,
  SheetsChartUIZhCN, SheetsOutlineUIZhCN,
  SheetsPivotUIZhCN, SheetsPivotChartUIZhCN, SheetsPrintZhCN, SheetsShapeUIZhCN, SheetsSlicerUIZhCN,
  SheetsSparklineUIZhCN, DrawingUIZhCN,
])

function sheetFor(api: FUniver, name?: string) {
  const workbook = api.getActiveWorkbook()
  if (!workbook) throw new Error('No active workbook')
  return name ? workbook.getSheetByName(name) : workbook.getActiveSheet()
}

async function applyPlan(api: FUniver, plan: OfficeEditPlan): Promise<void> {
  const workbook = api.getActiveWorkbook()
  if (!workbook) throw new Error('No active workbook')
  for (const op of plan.ops) {
    switch (op.kind) {
      case 'sheets.set-values': {
        const values = op.values.map((row) => row.map((cell) => cell === null ? '' : cell))
        sheetFor(api, op.sheet)?.getRange(op.range).setValues(values)
        break
      }
      case 'sheets.set-formula':
        sheetFor(api, op.sheet)?.getRange(op.range).setFormula(op.formula)
        break
      case 'sheets.set-number-format':
        sheetFor(api, op.sheet)?.getRange(op.range).setNumberFormat(op.pattern)
        break
      case 'sheets.set-style': {
        const range = sheetFor(api, op.sheet)?.getRange(op.range)
        if (!range) break
        if (op.bold !== undefined) range.setFontWeight(op.bold ? 'bold' : 'normal')
        if (op.italic !== undefined) range.setFontStyle(op.italic ? 'italic' : 'normal')
        if (op.background) range.setBackgroundColor(op.background)
        if (op.color) range.setFontColor(op.color)
        break
      }
      case 'sheets.insert-rows':
        sheetFor(api, op.sheet)?.insertRows(op.index, op.count)
        break
      case 'sheets.delete-rows':
        sheetFor(api, op.sheet)?.deleteRows(op.index, op.count)
        break
      case 'sheets.add-sheet':
        workbook.insertSheet(op.name)
        break
      case 'sheets.rename-sheet':
        sheetFor(api, op.sheet)?.setName(op.name)
        break
    }
  }
}

const product: OfficeEditorProduct = {
  locales: { [LocaleType.EN_US]: en, [LocaleType.ZH_CN]: zh },
  needsLicense: true,
  register(univer, { container }) {
    univer.registerPlugin(UniverRenderEnginePlugin)
    univer.registerPlugin(UniverFormulaEnginePlugin)
    univer.registerPlugin(UniverUIPlugin, { container, ribbonType: 'grid' })
    univer.registerPlugin(UniverDocsPlugin)
    univer.registerPlugin(UniverDocsUIPlugin)
    univer.registerPlugin(UniverSheetsPlugin)
    univer.registerPlugin(UniverSheetsUIPlugin)
    univer.registerPlugin(UniverSheetsFormulaPlugin)
    univer.registerPlugin(UniverSheetsFormulaUIPlugin)
    univer.registerPlugin(UniverSheetsNumfmtPlugin)
    univer.registerPlugin(UniverSheetsNumfmtUIPlugin)
    univer.registerPlugin(UniverSheetsConditionalFormattingPlugin)
    univer.registerPlugin(UniverSheetsConditionalFormattingUIPlugin)
    univer.registerPlugin(UniverSheetsCrosshairHighlightPlugin)
    univer.registerPlugin(UniverSheetsDataValidationPlugin)
    univer.registerPlugin(UniverSheetsDataValidationUIPlugin)
    univer.registerPlugin(UniverDrawingPlugin)
    univer.registerPlugin(UniverDrawingUIPlugin)
    univer.registerPlugin(UniverSheetsDrawingPlugin)
    univer.registerPlugin(UniverSheetsDrawingUIPlugin)
    univer.registerPlugin(UniverSheetsFilterPlugin)
    univer.registerPlugin(UniverSheetsFilterUIPlugin)
    univer.registerPlugin(UniverSheetsFindReplacePlugin)
    univer.registerPlugin(UniverSheetsHyperLinkPlugin)
    univer.registerPlugin(UniverSheetsHyperLinkUIPlugin)
    univer.registerPlugin(UniverSheetsNotePlugin)
    univer.registerPlugin(UniverSheetsNoteUIPlugin)
    univer.registerPlugin(UniverSheetsSortPlugin)
    univer.registerPlugin(UniverSheetsSortUIPlugin)
    univer.registerPlugin(UniverSheetsTablePlugin)
    univer.registerPlugin(UniverSheetsTableUIPlugin)
    univer.registerPlugin(UniverThreadCommentPlugin)
    univer.registerPlugin(UniverThreadCommentUIPlugin)
    univer.registerPlugin(UniverSheetsThreadCommentPlugin)
    univer.registerPlugin(UniverSheetsThreadCommentUIPlugin)
    univer.registerPlugin(UniverSheetsDrawingThreadCommentPlugin)
    univer.registerPlugin(UniverSheetsChartThreadCommentPlugin)
    univer.registerPlugin(UniverWatermarkPlugin)
    univer.registerPlugin(UniverSheetsChartPlugin)
    univer.registerPlugin(UniverSheetsChartUIPlugin)
    univer.registerPlugin(UniverSheetsPivotTablePlugin)
    univer.registerPlugin(UniverSheetsPivotTableUIPlugin)
    univer.registerPlugin(UniverSheetsPivotChartPlugin)
    univer.registerPlugin(UniverSheetsPivotChartUIPlugin)
    univer.registerPlugin(UniverSheetsPrintPlugin)
    univer.registerPlugin(UniverSheetsShapePlugin)
    univer.registerPlugin(UniverSheetsShapeUIPlugin)
    univer.registerPlugin(UniverSlicerPlugin)
    univer.registerPlugin(UniverSheetsSlicerPlugin)
    univer.registerPlugin(UniverSheetsSlicerUIPlugin)
    univer.registerPlugin(UniverSheetSparklinePlugin)
    univer.registerPlugin(UniverSheetSparklineUIPlugin)
    univer.registerPlugin(UniverSheetsOutlinePlugin)
    univer.registerPlugin(UniverSheetsOutlineUIPlugin)
  },
  create(api, { fileId, snapshot }) {
    // The file id is the unit id, as every other product already does: the history panel asks the server
    // by unit id, and a workbook that invents its own id would be a document the server cannot find.
    api.createWorkbook({ ...(snapshot ?? {}), id: fileId })
    const workbook = api.getActiveWorkbook()
    workbook?.setEditable(true)
    return {
      unitId: fileId,
      save: () => api.getActiveWorkbook()?.save() ?? {},
      context: () => contextOf(api),
    }
  },
  applyPlan,
}

function contextOf(api: FUniver): OfficeEditorContext {
  const workbook = api.getActiveWorkbook()
  const sheet = workbook?.getActiveSheet()
  const range = workbook?.getActiveRange()
  return {
    sheet: sheet?.getSheetName() ?? '',
    range: range?.getA1Notation() ?? '',
    sheets: workbook?.getNumSheets() ?? 0,
  }
}

export function OfficeSheetsEditor(props: OfficeEditorProps) {
  return <OfficeEditorSurface {...props} product={product} />
}