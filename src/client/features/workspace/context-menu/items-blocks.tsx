import { ArrowLeftRight, Braces, CheckSquare, Copy, Eye, Maximize2, Network, Pencil, Sparkles, Trash2, Waypoints } from 'lucide-react'
import { submenuFor, type MenuItem } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { formatCode } from '../../../lib/markdown/code-formatter'
import { FORMATTABLE_LANGUAGES } from '../../../lib/markdown/code-formatter/types'
import { CHART_TEMPLATES, KANBAN_TEMPLATES, MERMAID_TEMPLATES, MINDMAP_TEMPLATES } from '../../../editor/diagram-templates'
import { detectChartMode } from '../../../lib/markdown/chart/body'
import { convertChartFence } from '../../preview/chart-block-toolbar'
import { detectMindmapMode } from '../../../lib/markdown/mindmap/body'
import type { ContextKind, MenuCtx, FenceInfoData } from './types'
import { isSourceMenu } from './types'
import { currentFence, fenceSource, patchFence, removeFence, replaceFenceBody } from './writes'

/**
 * The menus of the fenced families: a code block, an example, and the four diagram kinds.
 *
 * They share three rows — copy the source, swap the body for a starter, delete the block — and each
 * adds only what its own format can answer to. Nothing here writes markup by hand: the edits go
 * through `writes.ts`, which is the same fence surgery the block toolbars already use.
 */

/** The info string with its leading language replaced and every other option kept as written. */
export function swapFenceLanguage(info: string, language: string): string {
  const trimmed = info.trimStart()
  const indent = info.slice(0, info.length - trimmed.length)
  const rest = trimmed.replace(/^[^\s{]*/, '').trim()
  return `${indent}${language}${rest ? ` ${rest}` : ''}`
}

/** The block the menu was opened on, when the pointer is on a block of this kind. */
function blockFence(ctx: MenuCtx, kind: ContextKind): FenceInfoData | null {
  if (ctx.editor?.kind === kind) return ctx.editor.fence ?? null
  if (ctx.preview?.kind === kind) return ctx.preview.fence ?? null
  return null
}

function copySourceItem(ctx: MenuCtx): MenuItem {
  return {
    id: 'copy-block-source',
    label: t('contextmenu.copy_source'),
    icon: <Copy size={14} />,
    separatorBefore: true,
    onSelect: () => ctx.onCopyText(fenceSource(ctx)),
  }
}

function jumpItem(ctx: MenuCtx): MenuItem | null {
  const line = ctx.preview?.line
  if (isSourceMenu(ctx) || line === undefined) return null
  return { id: 'jump-to-editor', label: t('contextmenu.jump_to_editor'), icon: <Pencil size={14} />, onSelect: () => ctx.onJumpToLine(line) }
}

function deleteBlockItem(ctx: MenuCtx): MenuItem {
  return {
    id: 'delete-block',
    label: t('contextmenu.delete_block'),
    icon: <Trash2 size={14} />,
    tone: 'danger',
    separatorBefore: true,
    onSelect: () => {
      if (!removeFence(ctx)) ctx.onToast({ title: t('preview.chart_block_moved'), tone: 'warning' })
    },
  }
}

function templateItem(ctx: MenuCtx, templates: typeof MERMAID_TEMPLATES): MenuItem | null {
  const items: MenuItem[] = templates.map((template) => ({
    id: template.id,
    label: t(template.labelKey),
    onSelect: () => {
      if (!replaceFenceBody(ctx, template.body)) ctx.onToast({ title: t('preview.chart_block_moved'), tone: 'warning' })
    },
  }))
  if (items.length === 0) return null
  return {
    id: 'block-templates',
    label: t('contextmenu.templates'),
    icon: <Sparkles size={14} />,
    separatorBefore: true,
    subItems: items,
    submenu: submenuFor(items, 190),
  }
}

function formatItem(ctx: MenuCtx, body: string, language: string): MenuItem {
  return {
    id: 'format-block',
    label: t('command.format_code_block'),
    icon: <Sparkles size={14} />,
    onSelect: () => {
      const formatted = formatCode(body, language)
      if (formatted.trimEnd() === body.trimEnd()) {
        ctx.onToast({ title: t('contextmenu.already_formatted'), tone: 'default' })
        return
      }
      if (!replaceFenceBody(ctx, formatted)) ctx.onToast({ title: t('preview.chart_block_moved'), tone: 'warning' })
    },
  }
}

function languageItem(ctx: MenuCtx, info: string, language: string): MenuItem {
  const current = language.toLowerCase()
  const items: MenuItem[] = FORMATTABLE_LANGUAGES.map((next) => ({
    id: `lang-${next}`,
    label: next,
    checked: next === current,
    onSelect: () => {
      if (!patchFence(ctx, { info: swapFenceLanguage(info, next) })) ctx.onToast({ title: t('preview.chart_block_moved'), tone: 'warning' })
    },
  }))
  return {
    id: 'change-language',
    label: t('contextmenu.change_language'),
    icon: <Braces size={14} />,
    separatorBefore: true,
    subItems: items,
    submenu: submenuFor(items, 168),
  }
}

export function buildCodeItems(ctx: MenuCtx): MenuItem[] | null {
  const fence = blockFence(ctx, 'codeblock')
  if (!fence) return null
  const items: MenuItem[] = [formatItem(ctx, fence.body, fence.language)]
  if (isSourceMenu(ctx)) {
    items.push({
      id: 'select-block',
      label: t('contextmenu.select_block'),
      icon: <CheckSquare size={14} />,
      onSelect: () => {
        const view = ctx.editorView
        if (!view || fence.from === undefined || fence.to === undefined) return
        view.dispatch({ selection: { anchor: fence.from, head: fence.to }, scrollIntoView: true })
        view.focus()
      },
    })
    items.push(languageItem(ctx, fence.info, fence.language))
  }
  items.push(copySourceItem(ctx))
  const jump = jumpItem(ctx)
  if (jump) items.push(jump)
  items.push(deleteBlockItem(ctx))
  return items
}

export function buildMermaidItems(ctx: MenuCtx): MenuItem[] | null {
  const fence = blockFence(ctx, 'mermaid')
  if (!fence) return null
  const items: MenuItem[] = []
  const templates = templateItem(ctx, MERMAID_TEMPLATES)
  if (templates) items.push(templates)
  items.push(formatItem(ctx, fence.body, 'mermaid'))
  items.push(copySourceItem(ctx))
  const jump = jumpItem(ctx)
  if (jump) items.push(jump)
  items.push(deleteBlockItem(ctx))
  return items
}

/**
 * The chart family's own row. The conversion is the preview toolbar's function, called with the same
 * arguments, so the two surfaces can never drift into offering different conversions of one body.
 */
function chartConvertItem(ctx: MenuCtx): MenuItem | null {
  const at = currentFence(ctx)
  if (!at) return null
  const toTable = detectChartMode(at.body) !== 'table'
  return {
    id: 'chart-convert',
    label: t(toTable ? 'preview.chart_convert_to_table' : 'preview.chart_convert_to_json'),
    icon: <ArrowLeftRight size={14} />,
    onSelect: () => {
      convertChartFence(at.line, ctx.content, ctx.onEditContent, ctx.onToast)
    },
  }
}

export function buildChartItems(ctx: MenuCtx): MenuItem[] | null {
  const fence = blockFence(ctx, 'chart')
  if (!fence) return null
  const items: MenuItem[] = []
  const templates = templateItem(ctx, CHART_TEMPLATES)
  if (templates) items.push(templates)
  const convert = chartConvertItem(ctx)
  if (convert) items.push(convert)
  items.push(copySourceItem(ctx))
  const jump = jumpItem(ctx)
  if (jump) items.push(jump)
  items.push(deleteBlockItem(ctx))
  return items
}

/**
 * The mind map's format swap belongs to the live canvas, which holds edits that have not been written
 * back yet. The block's own button is therefore the only correct way to ask for it, and that button
 * exists in the preview — a source-only note gets the row disabled rather than a second conversion.
 */
function mindmapConvertItem(ctx: MenuCtx, body: string): MenuItem {
  const target = detectMindmapMode(body) === 'json' ? 'outline' : 'json'
  const button = ctx.preview?.target.closest<HTMLElement>('[data-mindmap]')
    ?.querySelector<HTMLElement>('[data-mindmap-action="convert-format"]') ?? null
  return {
    id: 'mindmap-convert',
    label: t(target === 'outline' ? 'preview.mindmap_convert_outline' : 'preview.mindmap_convert_json'),
    icon: <Network size={14} />,
    disabled: !button,
    onSelect: () => button?.click(),
  }
}

export function buildMindmapItems(ctx: MenuCtx): MenuItem[] | null {
  const fence = blockFence(ctx, 'mindmap')
  if (!fence) return null
  const items: MenuItem[] = []
  if (detectMindmapMode(fence.body) === 'json') items.push(formatItem(ctx, fence.body, 'json'))
  items.push(mindmapConvertItem(ctx, fence.body))
  const templates = templateItem(ctx, MINDMAP_TEMPLATES)
  if (templates) items.push(templates)
  if (ctx.preview) {
    items.push({
      id: 'mindmap-fullscreen',
      label: t('preview.mindmap_fullscreen'),
      icon: <Maximize2 size={14} />,
      separatorBefore: true,
      onSelect: () => ctx.onBlockAction('mindmap-fullscreen', ctx.preview!.target),
    })
    items.push({
      id: 'mindmap-theme',
      label: t('preview.mindmap_theme'),
      icon: <Eye size={14} />,
      onSelect: () => ctx.onBlockAction('mindmap-theme', ctx.preview!.target),
    })
  }
  items.push(copySourceItem(ctx))
  const jump = jumpItem(ctx)
  if (jump) items.push(jump)
  items.push(deleteBlockItem(ctx))
  return items
}

export function buildKanbanItems(ctx: MenuCtx): MenuItem[] | null {
  const fence = blockFence(ctx, 'kanban')
  if (!fence) return null
  const items: MenuItem[] = []
  const templates = templateItem(ctx, KANBAN_TEMPLATES)
  if (templates) items.push(templates)
  if (ctx.preview) {
    items.push({
      id: 'kanban-fullscreen',
      label: t('preview.kanban_fullscreen'),
      icon: <Waypoints size={14} />,
      separatorBefore: true,
      onSelect: () => ctx.onBlockAction('kanban-fullscreen', ctx.preview!.target),
    })
  }
  items.push(copySourceItem(ctx))
  const jump = jumpItem(ctx)
  if (jump) items.push(jump)
  items.push(deleteBlockItem(ctx))
  return items
}

export function buildExampleItems(ctx: MenuCtx): MenuItem[] | null {
  const fence = blockFence(ctx, 'example')
  if (!fence) return null
  const items: MenuItem[] = [
    {
      id: 'copy-example-body',
      label: t('contextmenu.copy_example_source'),
      icon: <Copy size={14} />,
      onSelect: () => ctx.onCopyText(fence.body),
    },
    copySourceItem(ctx),
  ]
  const jump = jumpItem(ctx)
  if (jump) items.push(jump)
  items.push(deleteBlockItem(ctx))
  return items
}

/** Every fenced family's builder, indexed by the kind the detectors report. */
export const FENCE_BUILDERS = {
  codeblock: buildCodeItems,
  example: buildExampleItems,
  mermaid: buildMermaidItems,
  chart: buildChartItems,
  mindmap: buildMindmapItems,
  kanban: buildKanbanItems,
} as const
