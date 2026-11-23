import { LocaleType, mergeLocales } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import DesignEnUS from '@univerjs/design/locale/en-US'
import DesignZhCN from '@univerjs/design/locale/zh-CN'
import { UniverDocsPlugin } from '@univerjs/docs'
import { UniverDocsUIPlugin } from '@univerjs/docs-ui'
import DocsUIEnUS from '@univerjs/docs-ui/locale/en-US'
import DocsUIZhCN from '@univerjs/docs-ui/locale/zh-CN'
import { UniverDrawingPlugin } from '@univerjs/drawing'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { UniverSlidesPlugin } from '@univerjs-pro/slides'
import SlidesEnUS from '@univerjs-pro/slides/locale/en-US'
import SlidesZhCN from '@univerjs-pro/slides/locale/zh-CN'
import { UniverSlidesUIPlugin } from '@univerjs-pro/slides-ui'
import SlidesUIEnUS from '@univerjs-pro/slides-ui/locale/en-US'
import SlidesUIZhCN from '@univerjs-pro/slides-ui/locale/zh-CN'
import { UniverThreadCommentPlugin } from '@univerjs/thread-comment'
import { UniverThreadCommentUIPlugin } from '@univerjs/thread-comment-ui'
import ThreadCommentUIEnUS from '@univerjs/thread-comment-ui/locale/en-US'
import ThreadCommentUIZhCN from '@univerjs/thread-comment-ui/locale/zh-CN'
import { UniverUIPlugin } from '@univerjs/ui'
import UIEnUS from '@univerjs/ui/locale/en-US'
import UIzhCN from '@univerjs/ui/locale/zh-CN'
import { UniverSlidesChartPlugin } from '@univerjs-pro/slides-chart'
import { UniverSlidesChartUIPlugin } from '@univerjs-pro/slides-chart-ui'
import SlidesChartUIEnUS from '@univerjs-pro/slides-chart-ui/locale/en-US'
import SlidesChartUIZhCN from '@univerjs-pro/slides-chart-ui/locale/zh-CN'
import { UniverSlidesPrintPlugin } from '@univerjs-pro/slides-print'
import SlidesPrintEnUS from '@univerjs-pro/slides-print/locale/en-US'
import SlidesPrintZhCN from '@univerjs-pro/slides-print/locale/zh-CN'
import { UniverSlidesTablePlugin } from '@univerjs-pro/slides-table'
import { UniverSlidesTableUIPlugin } from '@univerjs-pro/slides-table-ui'
import SlidesTableUIEnUS from '@univerjs-pro/slides-table-ui/locale/en-US'
import SlidesTableUIZhCN from '@univerjs-pro/slides-table-ui/locale/zh-CN'
import { UniverSlidesThreadCommentPlugin } from '@univerjs-pro/slides-thread-comment'
import { UniverSlidesThreadCommentUIPlugin } from '@univerjs-pro/slides-thread-comment-ui'
import SlidesThreadCommentUIEnUS from '@univerjs-pro/slides-thread-comment-ui/locale/en-US'
import SlidesThreadCommentUIZhCN from '@univerjs-pro/slides-thread-comment-ui/locale/zh-CN'

import '@univerjs/ui/facade'
import '@univerjs/docs-ui/facade'
import '@univerjs-pro/slides/facade'

import '@univerjs/design/lib/index.css'
import '@univerjs/ui/lib/index.css'
import '@univerjs/docs-ui/lib/index.css'
import '@univerjs/thread-comment-ui/lib/index.css'
import '@univerjs-pro/slides-ui/lib/index.css'
import '@univerjs-pro/slides-chart-ui/lib/index.css'
import '@univerjs-pro/slides-print/lib/index.css'
import '@univerjs-pro/slides-table-ui/lib/index.css'
import '@univerjs-pro/slides-thread-comment-ui/lib/index.css'

import type { OfficeEditPlan } from '@shared/office/ai'
import type { OfficeEditorContext, OfficeEditorProps } from './contracts'
import { OfficeEditorSurface } from './OfficeEditorSurface'
import type { OfficeEditorProduct } from './runtime'
import { registerPro } from '../office-build'

const en = mergeLocales([
  DesignEnUS, UIEnUS, DocsUIEnUS, SlidesEnUS, SlidesUIEnUS, ThreadCommentUIEnUS,
  SlidesChartUIEnUS, SlidesPrintEnUS, SlidesTableUIEnUS, SlidesThreadCommentUIEnUS,
])
const zh = mergeLocales([
  DesignZhCN, UIzhCN, DocsUIZhCN, SlidesZhCN, SlidesUIZhCN, ThreadCommentUIZhCN,
  SlidesChartUIZhCN, SlidesPrintZhCN, SlidesTableUIZhCN, SlidesThreadCommentUIZhCN,
])

async function applyPlan(api: FUniver, plan: OfficeEditPlan): Promise<void> {
  const presentation = api.getActivePresentation()
  if (!presentation) throw new Error('No active presentation')
  for (const op of plan.ops) {
    switch (op.kind) {
      case 'slides.add-slide':
        presentation.appendSlide(op.name ? { name: op.name } : {})
        break
      case 'slides.set-title': {
        const slide = presentation.getSlideByIndex(op.slideIndex)
        if (!slide) throw new Error('Slide not found')
        // A title is text inside the slide canvas; the text-box facade is not part of the base
        // presentation API, so this plan operation is intentionally reported rather than guessed.
        throw new Error('Editing slide text through the assistant is not available yet')
      }
      case 'slides.add-text':
      case 'slides.add-shape':
        throw new Error('Editing slide elements through the assistant is not available yet')
    }
  }
}

const product: OfficeEditorProduct = {
  needsLicense: true,
  locales: { [LocaleType.EN_US]: en, [LocaleType.ZH_CN]: zh },
  register(univer, { container }) {
    univer.registerPlugin(UniverRenderEnginePlugin)
    univer.registerPlugin(UniverUIPlugin, { container, ribbonType: 'grid' })
    univer.registerPlugin(UniverDocsPlugin)
    univer.registerPlugin(UniverDocsUIPlugin)
    univer.registerPlugin(UniverDrawingPlugin)
    registerPro(univer, UniverSlidesPlugin)
    registerPro(univer, UniverSlidesUIPlugin)
    univer.registerPlugin(UniverThreadCommentPlugin)
    univer.registerPlugin(UniverThreadCommentUIPlugin)
    registerPro(univer, UniverSlidesThreadCommentPlugin)
    registerPro(univer, UniverSlidesThreadCommentUIPlugin)
    registerPro(univer, UniverSlidesChartPlugin)
    registerPro(univer, UniverSlidesChartUIPlugin)
    registerPro(univer, UniverSlidesPrintPlugin)
    registerPro(univer, UniverSlidesTablePlugin)
    registerPro(univer, UniverSlidesTableUIPlugin)
  },
  create(api, { fileId, title, snapshot }) {
    api.createPresentation({ ...(snapshot ?? {}), id: fileId, name: title })
    return {
      unitId: fileId,
      save: () => api.getActivePresentation()?.save() ?? {},
      context: () => contextOf(api),
    }
  },
  applyPlan,
}

function contextOf(api: FUniver): OfficeEditorContext {
  const presentation = api.getActivePresentation()
  const active = presentation?.getActiveSlide()
  const slides = presentation?.getSlides() ?? []
  return {
    slides: slides.length,
    activeSlide: active ? slides.findIndex((slide) => slide.getId() === active.getId()) + 1 : 0,
    name: presentation?.getName() ?? '',
  }
}

export function OfficeSlidesEditor(props: OfficeEditorProps) {
  return <OfficeEditorSurface {...props} product={product} />
}