import { LocaleType, mergeLocales } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import DesignEnUS from '@univerjs/design/locale/en-US'
import DesignZhCN from '@univerjs/design/locale/zh-CN'
import { UniverDocsUIPlugin } from '@univerjs/docs-ui'
import DocsUIEnUS from '@univerjs/docs-ui/locale/en-US'
import DocsUIZhCN from '@univerjs/docs-ui/locale/zh-CN'
import { UniverPdfsPlugin } from '@univerjs-pro/pdfs'
import { UniverPdfsUIPlugin } from '@univerjs-pro/pdfs-ui'
import PdfsUIEnUS from '@univerjs-pro/pdfs-ui/locale/en-US'
import PdfsUIZhCN from '@univerjs-pro/pdfs-ui/locale/zh-CN'
import { UniverPdfsPrintPlugin } from '@univerjs-pro/pdfs-print'
import PdfsPrintEnUS from '@univerjs-pro/pdfs-print/locale/en-US'
import PdfsPrintZhCN from '@univerjs-pro/pdfs-print/locale/zh-CN'
import { UniverUIPlugin } from '@univerjs/ui'
import UIEnUS from '@univerjs/ui/locale/en-US'
import UIzhCN from '@univerjs/ui/locale/zh-CN'

import '@univerjs/ui/facade'
import '@univerjs/docs-ui/facade'
import '@univerjs-pro/pdfs/facade'

import '@univerjs/design/lib/index.css'
import '@univerjs/ui/lib/index.css'
import '@univerjs/docs-ui/lib/index.css'
import '@univerjs-pro/pdfs-ui/lib/index.css'
import '@univerjs-pro/pdfs-print/lib/index.css'

import type { OfficeEditPlan } from '@shared/office/ai'
import type { OfficeEditorContext, OfficeEditorProps } from './contracts'
import { OfficeEditorSurface } from './OfficeEditorSurface'
import type { OfficeEditorProduct } from './runtime'
import { registerPro } from '../office-build'

const en = mergeLocales([DesignEnUS, UIEnUS, DocsUIEnUS, PdfsUIEnUS, PdfsPrintEnUS])
const zh = mergeLocales([DesignZhCN, UIzhCN, DocsUIZhCN, PdfsUIZhCN, PdfsPrintZhCN])

async function applyPlan(api: FUniver, plan: OfficeEditPlan): Promise<void> {
  const pdf = api.getActivePdf()
  if (!pdf) throw new Error('No active PDF')
  for (const op of plan.ops) {
    switch (op.kind) {
      case 'pdfs.add-page':
        pdf.insertPage(op.index)
        break
      case 'pdfs.add-text': {
        const page = pdf.getPageByIndex(op.pageIndex)
        if (!page) throw new Error('PDF page not found')
        page.insertTextBox({
          text: op.text,
          ...(op.x !== undefined ? { left: op.x } : {}),
          ...(op.y !== undefined ? { top: op.y } : {}),
          ...(op.width !== undefined ? { width: op.width } : {}),
          ...(op.height !== undefined ? { height: op.height } : {}),
          ...(op.fontSize !== undefined ? { fontSize: op.fontSize } : {}),
        })
        break
      }
      case 'pdfs.add-table': {
        const page = pdf.getPageByIndex(op.pageIndex)
        if (!page) throw new Error('PDF page not found')
        page.insertTable({
          rowCount: op.rows,
          columnCount: op.columns,
          ...(op.values ? { cellTexts: op.values.flat() } : {}),
        })
        break
      }
    }
  }
}

const product: OfficeEditorProduct = {
  needsLicense: true,
  locales: { [LocaleType.EN_US]: en, [LocaleType.ZH_CN]: zh },
  register(univer, { container }) {
    univer.registerPlugin(UniverUIPlugin, { container, ribbonType: 'grid' })
    univer.registerPlugin(UniverDocsUIPlugin)
    registerPro(univer, UniverPdfsPlugin)
    registerPro(univer, UniverPdfsUIPlugin)
    registerPro(univer, UniverPdfsPrintPlugin)
  },
  create(api, { fileId, title, snapshot }) {
    api.createPdf({ ...(snapshot ?? {}), id: fileId, name: title })
    return {
      unitId: fileId,
      save: () => api.getActivePdf()?.save() ?? {},
      context: () => contextOf(api),
    }
  },
  applyPlan,
}

function contextOf(api: FUniver): OfficeEditorContext {
  const pdf = api.getActivePdf()
  return {
    pages: pdf?.getPages().length ?? 0,
    name: pdf?.getName() ?? '',
  }
}

export function OfficePdfsEditor(props: OfficeEditorProps) {
  return <OfficeEditorSurface {...props} product={product} />
}