/** A named bundle of instructions a reader can expand instead of typing. */
export interface Preset {
  name: string
  instructions: (context: PresetContext) => string[]
}

export interface PresetContext {
  /** Path of the note the block lives in, or null when it is being previewed outside a note. */
  currentPath: string | null
  /**
   * Fields every block hides unless its own query says `show`.
   *
   * The reader's setting, applied before the block's instructions, so `show due date` in a query still
   * wins: the note the author wrote is more specific than a preference set somewhere else.
   */
  defaultHiddenFields?: string[]
}

function scoped(context: PresetContext, instruction: string): string[] {
  if (context.currentPath === null) return []
  return [instruction.replace('{path}', context.currentPath)]
}

export const PRESETS: Preset[] = [
  { name: 'this_file', instructions: (context) => scoped(context, 'path includes {path}') },
  { name: 'this_folder', instructions: (context) => scoped(context, 'folder includes {path}') },
  { name: 'this_folder_only', instructions: (context) => scoped(context, 'path regex matches ^{dir}/[^/]+$') },
  { name: 'this_root', instructions: (context) => scoped(context, 'root includes {root}') },
  {
    name: 'hide_date_fields',
    instructions: () => ['hide due date', 'hide scheduled date', 'hide start date', 'hide created date', 'hide done date', 'hide cancelled date'],
  },
  {
    name: 'hide_non_date_fields',
    instructions: () => ['hide priority', 'hide recurrence rule', 'hide on completion', 'hide id', 'hide depends on', 'hide tags'],
  },
  { name: 'hide_query_elements', instructions: () => ['hide edit button', 'hide postpone button', 'hide backlink', 'hide task count', 'hide group count'] },
    {
    name: 'hide_everything',
    instructions: () => [...BY_NAME.get('hide_date_fields')!.instructions({ currentPath: null }),
      ...BY_NAME.get('hide_non_date_fields')!.instructions({ currentPath: null }),
      ...BY_NAME.get('hide_query_elements')!.instructions({ currentPath: null }),
      'short mode'],
  },
]

const BY_NAME = new Map(PRESETS.map((preset) => [preset.name, preset]))

export const PRESET_NAMES = PRESETS.map((preset) => preset.name)

/** The instructions a preset stands for, or null when the name is not one. */
export function expandPreset(name: string, context: PresetContext): string[] | null {
  const preset = BY_NAME.get(name.trim().toLowerCase())
  if (preset === undefined) return null
  let out = preset.instructions(context)
  if (preset.name === 'this_folder_only' || preset.name === 'this_root') {
    const path = context.currentPath ?? ''
    const slash = path.lastIndexOf('/')
    const folder = slash < 0 ? '' : path.slice(0, slash)
    out = out.map((line) => line.replace('{dir}', folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).replace('{root}', folder.split('/')[0] ?? ''))
  }
  return out
}
