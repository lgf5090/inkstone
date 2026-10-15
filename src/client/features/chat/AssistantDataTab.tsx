/**
 * The data tab: importing and exporting the assistant's own records.
 */
import { useRef, useState } from 'react'
import { Download, Upload } from 'lucide-react'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { Button } from '../../components/primitives'
import { SettingRow } from '../../components/form'
import { confirm } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'
import { Group } from './assistant-settings-shared'

const IMPORT_KEYS: Record<string, 'assistant.settings.import_conversations' | 'assistant.settings.import_messages' | 'assistant.settings.import_memories' | 'assistant.settings.import_tasks' | 'assistant.settings.import_projects' | 'assistant.settings.import_automations' | 'assistant.settings.import_notifications'> = {
  conversations: 'assistant.settings.import_conversations',
  messages: 'assistant.settings.import_messages',
  memories: 'assistant.settings.import_memories',
  tasks: 'assistant.settings.import_tasks',
  projects: 'assistant.settings.import_projects',
  automations: 'assistant.settings.import_automations',
  notifications: 'assistant.settings.import_notifications',
}

export function DataTab() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [file, setFile] = useState<File | null>(null)

  /**
   * The summary is read back from the server rather than counted here, so the toast cannot claim a
   * merge that did not happen; the skipped notes are what an imported file was not allowed to change.
   */
  const runImport = async () => {
    if (!file) return
    setImporting(true)
    try {
      const payload = JSON.parse(await file.text())
      const result = await api.assistant.importBackup(payload)
      const counts = Object.entries(result.imported)
        .filter(([key, value]) => key !== 'skipped' && typeof value === 'number' && (value as number) > 0)
        .map(([key, value]) => t(IMPORT_KEYS[key] ?? 'assistant.settings.import_items', { count: value as number }))
      const notes = result.imported.skipped ?? []
      useUi.getState().toast({
        title: counts.length ? counts.join(' · ') : t('assistant.settings.import_nothing'),
        description: notes.length ? notes.join('; ') : undefined,
        tone: 'success',
        duration: 8000,
      })
      await useAssistant.getState().bootstrap(true)
    } catch (error) {
      useUi.getState().toast({
        title: error instanceof SyntaxError ? t('assistant.settings.import_bad_json') : t('assistant.toast.failed'),
        tone: 'danger',
      })
    } finally {
      setImporting(false)
      setFile(null)
    }
  }

  return (
    <>
      <Group title={t('assistant.settings.data')}>
        <SettingRow title={t('assistant.settings.export')} description={t('assistant.settings.export_hint')}>
          <a
            href={api.assistant.exportUrl}
            download="inkstone-assistant-backup.json"
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--border-default)] px-2.5 text-[length:var(--text-12)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            <Download size={14} />
            {t('assistant.settings.export')}
          </a>
        </SettingRow>
        <SettingRow
          title={t('assistant.settings.import')}
          description={file ? file.name : t('assistant.settings.import_hint')}
        >
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
              {t('settings.select_file')}
            </Button>
            <Button size="sm" loading={importing} disabled={!file} onClick={() => void runImport()}>
              <Upload size={14} />
              {t('assistant.settings.import')}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => {
                const picked = event.target.files?.[0] ?? null
                event.target.value = ''
                setFile(picked)
              }}
            />
          </div>
        </SettingRow>
      </Group>

      <Group title={t('assistant.settings.danger')}>
        <SettingRow title={t('assistant.settings.clear_chats')} description={t('assistant.settings.clear_chats_hint')}>
          <Button
            size="sm"
            variant="secondary"
            className="text-[var(--danger)]"
            onClick={() => {
              void confirm({
                title: t('assistant.settings.clear_chats'),
                description: t('assistant.settings.clear_danger_hint'),
                confirmLabel: t('assistant.settings.clear_chats'),
                tone: 'danger',
              }).then(async (yes) => {
                if (!yes) return
                await api.assistant.deleteConversations()
                useAssistant.getState().bootstrap(true)
              })
            }}
          >
            {t('assistant.settings.clear_chats')}
          </Button>
        </SettingRow>
        <SettingRow title={t('assistant.settings.clear_memories')} description={t('assistant.settings.clear_memories_hint')}>
          <Button
            size="sm"
            variant="secondary"
            className="text-[var(--danger)]"
            onClick={() => {
              void confirm({
                title: t('assistant.settings.clear_memories'),
                description: t('assistant.settings.clear_danger_hint'),
                confirmLabel: t('assistant.settings.clear_memories'),
                tone: 'danger',
              }).then(async (yes) => {
                if (!yes) return
                await api.assistant.clearMemories()
                await useAssistant.getState().loadMemories()
              })
            }}
          >
            {t('assistant.settings.clear_memories')}
          </Button>
        </SettingRow>
      </Group>
    </>
  )
}
