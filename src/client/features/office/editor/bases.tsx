import { LocaleType, mergeLocales } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import DesignEnUS from '@univerjs/design/locale/en-US'
import DesignZhCN from '@univerjs/design/locale/zh-CN'
import { UniverProFormulaEnginePlugin } from '@univerjs-pro/engine-formula'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { UniverThreadCommentPlugin } from '@univerjs/thread-comment'
import { UniverThreadCommentUIPlugin } from '@univerjs/thread-comment-ui'
import ThreadCommentUIEnUS from '@univerjs/thread-comment-ui/locale/en-US'
import ThreadCommentUIZhCN from '@univerjs/thread-comment-ui/locale/zh-CN'
import { UniverUIPlugin } from '@univerjs/ui'
import UIEnUS from '@univerjs/ui/locale/en-US'
import UIzhCN from '@univerjs/ui/locale/zh-CN'
import { UniverBasesPlugin } from '@univerjs-pro/bases'
import BasesEnUS from '@univerjs-pro/bases/locale/en-US'
import BasesZhCN from '@univerjs-pro/bases/locale/zh-CN'
import { UniverBasesUIPlugin } from '@univerjs-pro/bases-ui'
import BasesUIEnUS from '@univerjs-pro/bases-ui/locale/en-US'
import BasesUIZhCN from '@univerjs-pro/bases-ui/locale/zh-CN'
import { UniverBaseDashboardPlugin } from '@univerjs-pro/bases-dashboard'
import { UniverBaseDashboardUIPlugin } from '@univerjs-pro/bases-dashboard-ui'
import DashboardUIEnUS from '@univerjs-pro/bases-dashboard-ui/locale/en-US'
import DashboardUIZhCN from '@univerjs-pro/bases-dashboard-ui/locale/zh-CN'
import { UniverBasesThreadCommentPlugin } from '@univerjs-pro/bases-thread-comment'
import { UniverBasesThreadCommentUIPlugin } from '@univerjs-pro/bases-thread-comment-ui'
import BasesThreadCommentUIEnUS from '@univerjs-pro/bases-thread-comment-ui/locale/en-US'
import BasesThreadCommentUIZhCN from '@univerjs-pro/bases-thread-comment-ui/locale/zh-CN'

import '@univerjs/ui/facade'
import '@univerjs-pro/bases/facade'
import '@univerjs-pro/bases-ui/facade'
import '@univerjs-pro/engine-formula/facade'

import '@univerjs/design/lib/index.css'
import '@univerjs/ui/lib/index.css'
import '@univerjs/thread-comment-ui/lib/index.css'
import '@univerjs-pro/bases-ui/lib/index.css'
import '@univerjs-pro/bases-thread-comment-ui/lib/index.css'

import type { OfficeEditPlan } from '@shared/office/ai'
import { t } from '../../../lib/i18n'
import { useSession } from '../../../store/session'
import type { OfficeEditorContext, OfficeEditorProps } from './contracts'
import { OfficeEditorSurface } from './OfficeEditorSurface'
import { uploadOfficeAsset } from './office-api'
import type { OfficeEditorProduct } from './runtime'
import { registerPro } from '../office-build'

const en = mergeLocales([
  DesignEnUS, UIEnUS, ThreadCommentUIEnUS, BasesEnUS, BasesUIEnUS, DashboardUIEnUS,
  BasesThreadCommentUIEnUS,
])
const zh = mergeLocales([
  DesignZhCN, UIzhCN, ThreadCommentUIZhCN, BasesZhCN, BasesUIZhCN, DashboardUIZhCN,
  BasesThreadCommentUIZhCN,
])

function tableOf(api: FUniver, ref: string) {
  const base = api.getActiveBase()
  if (!base) throw new Error('No active base')
  return base.getTableByName(ref) ?? base.getTableById(ref)
}

async function applyPlan(api: FUniver, plan: OfficeEditPlan): Promise<void> {
  const base = api.getActiveBase()
  if (!base) throw new Error('No active base')
  for (const op of plan.ops) {
    switch (op.kind) {
      case 'bases.add-table':
        base.insertTable(op.name, op.primaryField ? { primaryFieldName: op.primaryField } : {})
        break
      case 'bases.add-field': {
        const table = tableOf(api, op.table)
        if (!table) throw new Error('Base table not found')
        const fieldType = (api.Enum.BaseFieldType as unknown as Record<string, number>)[op.fieldType]
        if (fieldType === undefined) throw new Error(`Unknown base field type: ${op.fieldType}`)
        table.addField(op.name, fieldType as unknown as typeof api.Enum.BaseFieldType.Text)
        break
      }
      case 'bases.add-record': {
        const table = tableOf(api, op.table)
        if (!table) throw new Error('Base table not found')
        table.addRecord(op.values, api.Enum.BaseFieldKeyEnum.Name)
        break
      }
      case 'bases.set-record': {
        const table = tableOf(api, op.table)
        if (!table) throw new Error('Base table not found')
        const record = table.getRecordById(op.recordId)
        const field = table.getFieldByName(op.field)
        if (!record || !field) throw new Error('Base record or field not found')
        record.setValue(field.getId(), op.value as never)
        break
      }
    }
  }
}

function personOptions(): Array<{ id: string; name: string; avatar?: string }> {
  const user = useSession.getState().user
  if (!user) return []
  return [{
    id: user.id,
    name: user.name || user.login,
    ...(user.avatarUrl ? { avatar: user.avatarUrl } : {}),
  }]
}

const product: OfficeEditorProduct = {
  needsLicense: true,
  locales: { [LocaleType.EN_US]: en, [LocaleType.ZH_CN]: zh },
  register(univer, { container }) {
    univer.registerPlugin(UniverRenderEnginePlugin)
    univer.registerPlugin(UniverUIPlugin, { container, ribbonType: 'grid' })
    registerPro(univer, UniverProFormulaEnginePlugin)
    registerPro(univer, UniverBasesPlugin)
    univer.registerPlugin(UniverBasesUIPlugin, {
      attachment: {
        accept: ['image/*', '.pdf', '.txt', '.csv'],
        maxSize: 10 * 1024 * 1024,
        upload: async (file: File) => {
          const asset = await uploadOfficeAsset(file, { name: file.name })
          return {
            id: asset.id,
            name: file.name,
            mimeType: asset.mime,
            source: new URL(asset.url, window.location.origin).href,
          }
        },
      },
      personOptions: personOptions(),
    })
    registerPro(univer, UniverBaseDashboardPlugin)
    registerPro(univer, UniverBaseDashboardUIPlugin)
    univer.registerPlugin(UniverThreadCommentPlugin)
    univer.registerPlugin(UniverThreadCommentUIPlugin)
    registerPro(univer, UniverBasesThreadCommentPlugin)
    registerPro(univer, UniverBasesThreadCommentUIPlugin)
  },
  create(api, { fileId, title, snapshot }) {
    api.createBase({ ...(snapshot ?? {}), id: fileId, name: title })
    const base = api.getActiveBase()
    if (!snapshot && base?.getTables().length === 0) {
      base.insertTable(t('office.bases.default_table'), { primaryFieldName: t('office.bases.default_field') })
    }
    return {
      unitId: fileId,
      save: () => api.getActiveBase()?.save() ?? {},
      context: () => contextOf(api),
    }
  },
  applyPlan,
}

function contextOf(api: FUniver): OfficeEditorContext {
  const base = api.getActiveBase()
  return {
    tables: base?.getTables().length ?? 0,
    name: base?.getName() ?? '',
  }
}

export function OfficeBasesEditor(props: OfficeEditorProps) {
  return <OfficeEditorSurface {...props} product={product} />
}