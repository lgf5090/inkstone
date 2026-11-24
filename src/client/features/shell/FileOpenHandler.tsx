import { useEffect, useRef } from 'react'
import { LIMITS } from '@shared/constants'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useNoteTemplates } from '../../store/note-templates'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'

interface LaunchFileHandle {
  getFile: () => Promise<File>
}

interface LaunchParams {
  files?: LaunchFileHandle[]
}

interface LaunchQueue {
  setConsumer: (consumer: (params: LaunchParams) => void) => void
}

export function FileOpenHandler() {
  const userId = useSession((state) => state.user?.id)
  const toast = useUi((state) => state.toast)
  const pull = useNotes((state) => state.pull)
  const busy = useRef(false)

  useEffect(() => {
    if (!userId) return
    const queue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue
    if (!queue) return
    queue.setConsumer((params) => {
      void (async () => {
        if (busy.current) {
          toast({ title: t('settings.import_in_progress'), tone: 'warning' })
          return
        }
        const handles = params.files ?? []
        if (!handles.length) return
        busy.current = true
        try {
          if (handles.length > LIMITS.importFilesMax) throw new Error(t('settings.import_too_large'))
          const files: File[] = []
          let bytes = 0
          for (const handle of handles) {
            const file = await handle.getFile()
            bytes += file.size
            if (bytes > LIMITS.importUploadMaxBytes) throw new Error(t('settings.import_too_large'))
            files.push(file)
          }
          const { prepareNoteImport } = await import('../settings/note-importers')
          const prepared = await prepareNoteImport(files)
          const result = await api.transfer.import(prepared.files)
          result.warnings.unshift(...prepared.warnings.map((warning) => t(warning)))
          const refreshed = await pull({ force: true }).then(() => true, () => false)
          const templatesRefreshed = await useNoteTemplates.getState().reloadFromAccount(userId).then(() => true, () => false)
          const summary = t('settings.created_value0_updated_value1_skipped_value2_restored_value3_attachments', {
            value0: result.createdNotes,
            value1: result.updatedNotes,
            value2: result.skippedNotes,
            value3: result.createdAttachments,
            value4: result.skippedAttachments,
          })
          const details = [summary, ...result.warnings.slice(0, 1)]
          if (!refreshed || !templatesRefreshed) details.push(t('settings.operation_completed_but_refresh_failed'))
          toast({
            title: t('settings.import_completed'),
            description: details.join('\uFF1B'),
            tone: result.warnings.length || !refreshed || !templatesRefreshed ? 'warning' : 'success',
          })
        }
        catch (error) {
          toast({ title: t('settings.import_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
        }
        finally {
          busy.current = false
        }
      })()
    })
  }, [userId, toast, pull])

  return null
}
