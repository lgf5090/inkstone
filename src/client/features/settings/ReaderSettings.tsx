/**
 * The reader's place in the app's own settings.
 *
 * The in-book appearance panel changes how *this page* looks; this section is for the things a reader
 * decides once: where reading notes are filed, whether every mark writes into one, how long a day of
 * reading should be, and how the shelf — which cannot leave the device it is on — is carried to the
 * next one.
 */
import { useEffect, useRef, useState } from 'react'
import { Download, Trash2, Upload } from 'lucide-react'
import { Button } from '../../components/primitives'
import { Input, Segmented, SettingRow, Slider, Switch } from '../../components/form'
import { confirm } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { useSession } from '../../store/session'
import { useLibrary } from '../reading/store/library'
import { useReaderSettings } from '../reading/store/reader-settings'
import { dropBookHandle } from '../reading/reader/useEpubHandle'
import { HIGHLIGHT_COLORS } from '../reading/types'
import { DEFAULT_HIGHLIGHT_PAINT } from '../reading/themes'

export function ReaderSettings() {
  const settings = useReaderSettings()
  const update = useReaderSettings((state) => state.update)
  const reset = useReaderSettings((state) => state.reset)
  const books = useLibrary((state) => state.books)
  const highlights = useLibrary((state) => state.highlights)
  const exportLibrary = useLibrary((state) => state.exportLibrary)
  const importLibrary = useLibrary((state) => state.importLibrary)
  const toast = useUi((state) => state.toast)
  const fileInput = useRef<HTMLInputElement>(null)
  const [, setBusy] = useState(false)
  const userId = useSession((state) => state.user?.id ?? null)
  const status = useLibrary((state) => state.status)
  const bindUser = useLibrary((state) => state.bindUser)

  // The shelf loads itself when the reading tab mounts, but this section is reachable from anywhere:
  // without this, a reader who has never opened the tab this session would be told they own no books.
  useEffect(() => {
    if (status === 'idle') void bindUser(userId)
  }, [bindUser, status, userId])

  const marked = Object.values(highlights).reduce((total, list) => total + list.length, 0)

  return (
    <div className="space-y-1">
      <SettingRow title={t('settings.reading_notes_folder')} description={t('settings.reading_notes_folder_desc')}>
        <Input
          value={settings.notesFolder}
          onChange={(event) => update('notesFolder', event.target.value)}
          placeholder={t('settings.reading_notes_folder_placeholder')}
          className="w-56"
        />
      </SettingRow>

      <SettingRow title={t('settings.reading_auto_note')} description={t('settings.reading_auto_note_desc')}>
        <Switch checked={settings.autoBookNote} onChange={(value) => update('autoBookNote', value)} label={t('settings.reading_auto_note')} />
      </SettingRow>

      <SettingRow title={t('settings.reading_backlinks')} description={t('settings.reading_backlinks_desc')}>
        <Switch checked={settings.quoteBacklinks} onChange={(value) => update('quoteBacklinks', value)} label={t('settings.reading_backlinks')} />
      </SettingRow>

      <SettingRow title={t('settings.reading_export_colors')} description={t('settings.reading_export_colors_desc')}>
        <Switch checked={settings.exportColors} onChange={(value) => update('exportColors', value)} label={t('settings.reading_export_colors')} />
      </SettingRow>

      <SettingRow title={t('settings.reading_default_color')} description={t('settings.reading_default_color_desc')}>
        <div className="flex gap-2">
          {HIGHLIGHT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={color}
              aria-pressed={settings.defaultHighlightColor === color}
              onClick={() => update('defaultHighlightColor', color)}
              className="size-6 rounded-full border-2"
              style={{
                background: DEFAULT_HIGHLIGHT_PAINT[color],
                borderColor: settings.defaultHighlightColor === color ? 'var(--accent)' : 'transparent',
              }}
            />
          ))}
        </div>
      </SettingRow>

      <SettingRow title={t('settings.reading_timer')} description={t('settings.reading_timer_desc')}>
        <Switch checked={settings.timerEnabled} onChange={(value) => update('timerEnabled', value)} label={t('settings.reading_timer')} />
      </SettingRow>
      {settings.timerEnabled ? (
        <SettingRow title={t('settings.reading_daily_goal')} description={t('settings.reading_daily_goal_desc')}>
          <div className="w-56">
            <Slider value={settings.dailyGoalMinutes} min={0} max={240} step={5} onChange={(value) => update('dailyGoalMinutes', value)} label={t('settings.reading_daily_goal')} />
          </div>
        </SettingRow>
      ) : null}

      <SettingRow title={t('settings.reading_translate')} description={t('settings.reading_translate_desc')}>
        <Switch checked={settings.translateEnabled} onChange={(value) => update('translateEnabled', value)} label={t('settings.reading_translate')} />
      </SettingRow>
      {settings.translateEnabled ? (
        <SettingRow title={t('settings.reading_translate_engine')} description={t('settings.reading_translate_engine_desc')}>
          <Segmented
            value={settings.translateEngine}
            onChange={(value) => update('translateEngine', value)}
            options={[
              { value: 'google', label: t('reading.engine_free') },
              { value: 'ai', label: t('reading.engine_ai') },
            ]}
          />
        </SettingRow>
      ) : null}

      <SettingRow title={t('settings.reading_shelf')} description={t('settings.reading_shelf_desc', { value0: books.length, value1: marked })}>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" icon={<Download size={13} />} disabled={!books.length} onClick={() => void runExport()}>
            {t('reading.export_library')}
          </Button>
          <Button size="sm" variant="secondary" icon={<Upload size={13} />} onClick={() => fileInput.current?.click()}>
            {t('reading.import_library')}
          </Button>
          <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} disabled={!books.length} onClick={() => void runReset()}>
            {t('settings.reading_reset')}
          </Button>
        </div>
      </SettingRow>
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void runImport(file)
        }}
      />
    </div>
  )

  async function runExport(): Promise<void> {
    const json = await exportLibrary()
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `inkstone-reading-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    toast({ title: t('reading.library_exported'), tone: 'success' })
  }

  async function runImport(file: File): Promise<void> {
    setBusy(true)
    try {
      const result = await importLibrary(await file.text())
      toast({
        title: t('reading.library_imported_value0', { value0: result.books }),
        description: [
          t('reading.library_imported_highlights_value0', { value0: result.highlights }),
          result.rejected ? t('reading.library_imported_rejected_value0', { value0: result.rejected }) : null,
        ].filter(Boolean).join('\n'),
        tone: 'success',
      })
    } catch (err) {
      toast({ title: t('reading.library_import_failed'), description: err instanceof Error ? err.message : String(err), tone: 'danger' })
    }
    setBusy(false)
  }

  async function runReset(): Promise<void> {
    const ok = await confirm({
      title: t('settings.reading_reset_confirm'),
      description: t('settings.reading_reset_confirm_desc'),
      confirmLabel: t('settings.reading_reset'),
      tone: 'danger',
    })
    if (!ok) return
    for (const book of books) dropBookHandle(book.id)
    reset()
    toast({ title: t('settings.reading_reset_done'), tone: 'success' })
  }
}
