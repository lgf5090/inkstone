import { BlockType, type ConvertTo } from 'md-dragger/domain'
import type { DraggerBlockStyle, DraggerMenuRootItemId, EditorSettings } from '@shared/types'
import { t } from '../../lib/i18n'

/** The names the menu layer maps to an icon component; a new one has to be mapped there too. */
export type DraggerIconName =
  | 'pilcrow'
  | 'heading'
  | 'heading-level'
  | 'list'
  | 'list-ordered'
  | 'list-checks'
  | 'quote'
  | 'callout'
  | 'code'
  | 'math'
  | 'sparkles'
  | 'copy'
  | 'scissors'
  | 'duplicate'
  | 'trash'

export type DraggerConversionOption = {
  id: string
  label: string
  icon: DraggerIconName
  /** A style's own glyph, which a built-in row never has; drawn in place of the mapped icon. */
  glyph?: string
  target: ConvertTo
}

/** A submenu: the rows it holds are ordered by the reader's own `draggerMenuOrders` entry. */
export type DraggerMenuGroup = {
  id: Exclude<DraggerMenuRootItemId, 'paragraph' | 'quote' | 'code-block' | 'math-block'>
  label: string
  icon: DraggerIconName
  options: DraggerConversionOption[]
}

export type DraggerMenuEntry = DraggerConversionOption | DraggerMenuGroup

export function isDraggerMenuGroup(entry: DraggerMenuEntry): entry is DraggerMenuGroup {
  return 'options' in entry
}

const HEADING_OPTIONS = (level: number): DraggerConversionOption => ({
  id: `heading-${level}`,
  label: t('dragger.heading_level', { level }),
  icon: 'heading-level',
  target: { type: BlockType.Heading, level: level as 1 | 2 | 3 | 4 | 5 | 6 },
})

// Built per menu, never at module scope: a constant here would freeze the language the bundle was
// first read in, and a reader switching languages would keep getting the old menu.
const listOptions = (): DraggerConversionOption[] => [
  { id: 'list-unordered', label: t('dragger.bullet_list'), icon: 'list', target: { type: BlockType.ListItem, markerType: 'unordered' } },
  { id: 'list-ordered', label: t('dragger.numbered_list'), icon: 'list-ordered', target: { type: BlockType.ListItem, markerType: 'ordered' } },
  { id: 'list-task', label: t('dragger.task_list'), icon: 'list-checks', target: { type: BlockType.ListItem, markerType: 'task' } },
]

const calloutOptions = (): DraggerConversionOption[] => [
  { id: 'callout-note', label: t('dragger.callout_note'), icon: 'callout', target: { template: '> [!note]\n${content}', linePrefix: '> ' } },
  { id: 'callout-tip', label: t('dragger.callout_tip'), icon: 'callout', target: { template: '> [!tip]\n${content}', linePrefix: '> ' } },
  { id: 'callout-warning', label: t('dragger.callout_warning'), icon: 'callout', target: { template: '> [!warning]\n${content}', linePrefix: '> ' } },
]

function customOptions(styles: readonly DraggerBlockStyle[], order: readonly string[]): DraggerConversionOption[] {
  const byId = new Map(styles.map((style) => [style.id, style]))
  const options: DraggerConversionOption[] = []
  for (const id of order) {
    const style = byId.get(id)
    if (!style) continue
    options.push({ id: style.id, label: style.label, icon: 'sparkles', glyph: style.icon || undefined, target: styleToTemplate(style) })
  }
  return options
}

/** The engine takes a template; a stored style is that template plus the copy the menu shows. */
export function styleToTemplate(style: DraggerBlockStyle): ConvertTo {
  const target: ConvertTo = { template: style.template }
  if (style.linePrefix) target.linePrefix = style.linePrefix
  if (style.variables) target.variables = style.variables
  return target
}

/**
 * The handle's popup menu, in the order the reader set it, with empty groups left out.
 *
 * A group whose rows the reader hid (or whose custom styles were all deleted) would open an empty
 * panel, so it drops out of the top level too.
 */
export function draggerBlockMenuEntries(settings: EditorSettings): DraggerMenuEntry[] {
  const orders = settings.draggerMenuOrders
  const groups: Record<DraggerMenuGroup['id'], DraggerMenuGroup> = {
    heading: { id: 'heading', label: t('dragger.heading'), icon: 'heading', options: [1, 2, 3, 4, 5, 6]
      .map(HEADING_OPTIONS)
      .filter((option) => orders.heading.includes(option.id))
      .sort((a, b) => orders.heading.indexOf(a.id) - orders.heading.indexOf(b.id)) },
    list: { id: 'list', label: t('dragger.list'), icon: 'list', options: orderedBy(listOptions(), orders.list) },
    callout: { id: 'callout', label: t('dragger.callout'), icon: 'callout', options: orderedBy(calloutOptions(), orders.callout) },
    custom: { id: 'custom', label: t('dragger.custom'), icon: 'sparkles', options: customOptions(settings.draggerBlockStyles, orders.custom) },
  }
  const singles: Partial<Record<DraggerMenuRootItemId, DraggerConversionOption>> = {
    paragraph: { id: 'paragraph', label: t('dragger.paragraph'), icon: 'pilcrow', target: { type: BlockType.Paragraph } },
    quote: { id: 'quote', label: t('dragger.quote'), icon: 'quote', target: { type: BlockType.Blockquote } },
    'code-block': { id: 'code-block', label: t('dragger.code_block'), icon: 'code', target: { type: BlockType.CodeBlock } },
    'math-block': { id: 'math-block', label: t('dragger.math_block'), icon: 'math', target: { type: BlockType.MathBlock } },
  }
  const entries: DraggerMenuEntry[] = []
  for (const id of orders.root) {
    const single = singles[id]
    if (single) {
      entries.push(single)
      continue
    }
    const group = groups[id as DraggerMenuGroup['id']]
    if (group && group.options.length > 0) entries.push(group)
  }
  return entries
}

function orderedBy<T extends { id: string }>(options: readonly T[], order: readonly string[]): T[] {
  const byId = new Map(options.map((option) => [option.id, option]))
  return order.map((id) => byId.get(id)).filter((option): option is T => option !== undefined)
}

/** The menu's last group: the block edits that are not a conversion. */
export function draggerBlockActionLabels(): { copy: string; cut: string; duplicate: string; delete: string } {
  return {
    copy: t('dragger.copy_block'),
    cut: t('dragger.cut_block'),
    duplicate: t('dragger.duplicate_block'),
    delete: t('dragger.delete_block'),
  }
}
