import { buildTemplateLibraryExport } from '@shared/note-templates'
import { useNoteTemplates } from '../../store/note-templates'
import { useUi } from '../../store/ui'
import { downloadTextFile } from '../../lib/export-note'
import { t } from '../../lib/i18n'

function localDateKey(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Built-ins are re-seeded by the app, so an export carries only what the user made. */
export function exportTemplateLibrary(): void {
  const state = useNoteTemplates.getState()
  const data = buildTemplateLibraryExport(state.categories, state.templates)
  downloadTextFile(`inkstone-templates-${localDateKey()}.json`, JSON.stringify(data, null, 2), 'application/json')
  useUi.getState().toast({
    title: t('templates.exported_value0_templates', { value0: data.templates.length }),
    tone: 'success',
  })
}

export async function copyTemplateLibraryJson(): Promise<void> {
  const state = useNoteTemplates.getState()
  const data = buildTemplateLibraryExport(state.categories, state.templates)
  const ui = useUi.getState()
  try {
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2))
    ui.toast({ title: t('templates.copied_to_clipboard'), tone: 'success' })
  }
  catch {
    ui.toast({ title: t('templates.copy_failed'), tone: 'danger' })
  }
}
