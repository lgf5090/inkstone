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
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { UniverThreadCommentPlugin } from '@univerjs/thread-comment'
import { UniverThreadCommentUIPlugin } from '@univerjs/thread-comment-ui'
import ThreadCommentUIEnUS from '@univerjs/thread-comment-ui/locale/en-US'
import ThreadCommentUIZhCN from '@univerjs/thread-comment-ui/locale/zh-CN'
import { UniverUIPlugin } from '@univerjs/ui'
import UIEnUS from '@univerjs/ui/locale/en-US'
import UIzhCN from '@univerjs/ui/locale/zh-CN'
import { UniverBoardsPlugin } from '@univerjs-pro/boards'
import { UniverBoardsUIPlugin } from '@univerjs-pro/boards-ui'
import BoardsUIEnUS from '@univerjs-pro/boards-ui/locale/en-US'
import BoardsUIZhCN from '@univerjs-pro/boards-ui/locale/zh-CN'
import { UniverBoardsChartPlugin } from '@univerjs-pro/boards-chart'
import { UniverBoardsChartUIPlugin } from '@univerjs-pro/boards-chart-ui'
import BoardsChartUIEnUS from '@univerjs-pro/boards-chart-ui/locale/en-US'
import BoardsChartUIZhCN from '@univerjs-pro/boards-chart-ui/locale/zh-CN'
import { UniverBoardsLatexUIPlugin } from '@univerjs-pro/boards-latex-ui'
import { UniverShapeEditorUIPlugin } from '@univerjs-pro/shape-editor-ui'
import { UniverBoardsMindPlugin } from '@univerjs-pro/boards-mind'
import { UniverBoardsMindUIPlugin } from '@univerjs-pro/boards-mind-ui'
import BoardsMindUIEnUS from '@univerjs-pro/boards-mind-ui/locale/en-US'
import BoardsMindUIZhCN from '@univerjs-pro/boards-mind-ui/locale/zh-CN'
import { UniverBoardsPrintPlugin } from '@univerjs-pro/boards-print'
import BoardsPrintEnUS from '@univerjs-pro/boards-print/locale/en-US'
import BoardsPrintZhCN from '@univerjs-pro/boards-print/locale/zh-CN'
import { UniverBoardsResourcesPlugin } from '@univerjs-pro/boards-resources'
import { UniverBoardsResourcesUIPlugin } from '@univerjs-pro/boards-resources-ui'
import BoardsResourcesUIEnUS from '@univerjs-pro/boards-resources-ui/locale/en-US'
import BoardsResourcesUIZhCN from '@univerjs-pro/boards-resources-ui/locale/zh-CN'
import { UniverBoardsTablePlugin } from '@univerjs-pro/boards-table'
import { UniverBoardsTableUIPlugin } from '@univerjs-pro/boards-table-ui'
import BoardsTableUIEnUS from '@univerjs-pro/boards-table-ui/locale/en-US'
import BoardsTableUIZhCN from '@univerjs-pro/boards-table-ui/locale/zh-CN'
import { UniverBoardsThreadCommentPlugin } from '@univerjs-pro/boards-thread-comment'
import { UniverBoardsThreadCommentUIPlugin } from '@univerjs-pro/boards-thread-comment-ui'
import BoardsThreadCommentUIEnUS from '@univerjs-pro/boards-thread-comment-ui/locale/en-US'
import BoardsThreadCommentUIZhCN from '@univerjs-pro/boards-thread-comment-ui/locale/zh-CN'
import { UniverInkUIPlugin } from '@univerjs-pro/ink-ui'
import InkUIEnUS from '@univerjs-pro/ink-ui/locale/en-US'
import InkUIZhCN from '@univerjs-pro/ink-ui/locale/zh-CN'

import '@univerjs/ui/facade'
import '@univerjs-pro/boards/facade'
import '@univerjs-pro/boards-ui/facade'

import '@univerjs/design/lib/index.css'
import '@univerjs/ui/lib/index.css'
import '@univerjs/docs-ui/lib/index.css'
import '@univerjs/drawing-ui/lib/index.css'
import '@univerjs/thread-comment-ui/lib/index.css'
import '@univerjs-pro/ink-ui/lib/index.css'
import '@univerjs-pro/boards-ui/lib/index.css'
import '@univerjs-pro/boards-chart-ui/lib/index.css'
import '@univerjs-pro/boards-mind-ui/lib/index.css'
import '@univerjs-pro/boards-print/lib/index.css'
import '@univerjs-pro/boards-resources-ui/lib/index.css'
import '@univerjs-pro/boards-table-ui/lib/index.css'
import '@univerjs-pro/boards-thread-comment-ui/lib/index.css'

import type { OfficeEditPlan } from '@shared/office/ai'
import type { OfficeEditorContext, OfficeEditorProps } from './contracts'
import { OfficeEditorSurface } from './OfficeEditorSurface'
import type { OfficeEditorProduct } from './runtime'

const en = mergeLocales([
  DesignEnUS, UIEnUS, DocsUIEnUS, DrawingUIEnUS, ThreadCommentUIEnUS, InkUIEnUS, BoardsUIEnUS,
  BoardsChartUIEnUS, BoardsMindUIEnUS, BoardsPrintEnUS, BoardsResourcesUIEnUS,
  BoardsTableUIEnUS, BoardsThreadCommentUIEnUS,
])
const zh = mergeLocales([
  DesignZhCN, UIzhCN, DocsUIZhCN, DrawingUIZhCN, ThreadCommentUIZhCN, InkUIZhCN, BoardsUIZhCN,
  BoardsChartUIZhCN, BoardsMindUIZhCN, BoardsPrintZhCN, BoardsResourcesUIZhCN,
  BoardsTableUIZhCN, BoardsThreadCommentUIZhCN,
])

function shapeType(api: FUniver, name: string): typeof api.Enum.ShapeTypeEnum.Rect {
  const table = api.Enum.ShapeTypeEnum as unknown as Record<string, number>
  return (table[name] ?? api.Enum.ShapeTypeEnum.Rect) as unknown as typeof api.Enum.ShapeTypeEnum.Rect
}

async function applyPlan(api: FUniver, plan: OfficeEditPlan): Promise<void> {
  const board = api.getActiveBoard()
  if (!board) throw new Error('No active board')
  for (const op of plan.ops) {
    switch (op.kind) {
      case 'boards.add-sticky':
        board.insertText({
          text: op.text,
          left: op.left,
          top: op.top,
          ...(op.width !== undefined ? { width: op.width } : {}),
          ...(op.height !== undefined ? { height: op.height } : {}),
        })
        break
      case 'boards.add-shapes':
        board.insertShapes(op.shapes.map((shape) => ({
          shapeType: shapeType(api, shape.shapeType),
          transform: {
            left: shape.left,
            top: shape.top,
            ...(shape.width !== undefined ? { width: shape.width } : {}),
            ...(shape.height !== undefined ? { height: shape.height } : {}),
          },
          ...(shape.text ? { name: shape.text } : {}),
        })))
        break
      case 'boards.add-connector':
        board.insertConnector({
          start: { kind: 'free', x: op.from.x, y: op.from.y },
          end: { kind: 'free', x: op.to.x, y: op.to.y },
          ...(op.label ? { labelText: op.label } : {}),
        })
        break
    }
  }
}

const product: OfficeEditorProduct = {
  needsLicense: true,
  locales: { [LocaleType.EN_US]: en, [LocaleType.ZH_CN]: zh },
  register(univer, { container }) {
    univer.registerPlugin(UniverRenderEnginePlugin)
    univer.registerPlugin(UniverUIPlugin, { container })
    univer.registerPlugin(UniverDocsPlugin)
    univer.registerPlugin(UniverDocsUIPlugin)
    univer.registerPlugin(UniverDrawingPlugin)
    univer.registerPlugin(UniverDrawingUIPlugin)
    univer.registerPlugin(UniverInkUIPlugin)
    univer.registerPlugin(UniverBoardsPlugin)
    univer.registerPlugin(UniverBoardsUIPlugin)
    univer.registerPlugin(UniverBoardsMindPlugin)
    univer.registerPlugin(UniverBoardsMindUIPlugin)
    univer.registerPlugin(UniverShapeEditorUIPlugin)
    univer.registerPlugin(UniverBoardsTablePlugin)
    univer.registerPlugin(UniverBoardsTableUIPlugin)
    univer.registerPlugin(UniverBoardsChartPlugin)
    univer.registerPlugin(UniverBoardsChartUIPlugin)
    univer.registerPlugin(UniverBoardsResourcesPlugin)
    univer.registerPlugin(UniverBoardsResourcesUIPlugin)
    univer.registerPlugin(UniverBoardsPrintPlugin)
    univer.registerPlugin(UniverBoardsLatexUIPlugin)
    univer.registerPlugin(UniverThreadCommentPlugin)
    univer.registerPlugin(UniverThreadCommentUIPlugin)
    univer.registerPlugin(UniverBoardsThreadCommentPlugin)
    univer.registerPlugin(UniverBoardsThreadCommentUIPlugin)
  },
  create(api, { fileId, title, snapshot }) {
    api.createBoard({ ...(snapshot ?? {}), id: fileId, name: title })
    return {
      unitId: fileId,
      save: () => api.getActiveBoard()?.save() ?? {},
      context: () => contextOf(api),
    }
  },
  applyPlan,
}

function contextOf(api: FUniver): OfficeEditorContext {
  const board = api.getActiveBoard()
  return {
    elements: board?.findElements().length ?? 0,
    name: board?.getName() ?? '',
  }
}

export function OfficeBoardsEditor(props: OfficeEditorProps) {
  return <OfficeEditorSurface {...props} product={product} />
}