import { useRef, useState, type ReactElement } from 'react'
import { strToU8, zipSync } from 'fflate'
import { serializeProjectArchiveLines, PROJECT_ARCHIVE_VERSION, type ProjectArchiveLine } from '@shared/project/archive'
import { importAsanaCsv, importDeck, importJiraCsv, importNotionCsv, importTodoistCsv, importTrello } from '@shared/project/importers'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { Button } from '../../components/primitives'
import { Select } from '../../components/form'
import { Modal } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { importProjectArchive } from './api'

const CONVERTERS = {
  trello: importTrello,
  asana: importAsanaCsv,
  notion: importNotionCsv,
  jira: importJiraCsv,
  todoist: importTodoistCsv,
  deck: importDeck,
} as const

type Format = keyof typeof CONVERTERS

export function ImportDialog({ onClose }: { onClose: () => void }): ReactElement {
  const [format, setFormat] = useState<Format>('trello')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const toast = useUi((state) => state.toast)

  const submit = async () => {
    if (!file || busy) return
    setBusy(true)
    try {
      const text = await file.text()
      const lines: ProjectArchiveLine[] = CONVERTERS[format](text)
      const boardLine = lines.find((line) => line.type === 'board')
      const boardId = (boardLine?.data as { id: string } | undefined)?.id ?? 'imported'
      const bytes = zipSync({
        'version.json': strToU8(JSON.stringify({ version: PROJECT_ARCHIVE_VERSION, date: Date.now() })),
        [`${boardId}/board.jsonl`]: strToU8(serializeProjectArchiveLines(lines)),
      })
      const board = await importProjectArchive(bytes)
      onClose()
      navigateToPath(`/project/boards/${board.id}`)
    } catch (reason) {
      toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={t('project.import.title')} width={440}>
      <div className="space-y-3">
        <label className="block text-[length:var(--text-12)] text-[var(--text-secondary)]">
          {t('project.import.format')}
          <Select className="mt-1 w-full" value={format} onChange={(event) => setFormat(event.target.value as Format)}>
            {Object.keys(CONVERTERS).map((key) => <option key={key} value={key}>{key}</option>)}
          </Select>
        </label>
        <input ref={inputRef} type="file" className="hidden" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        <Button size="sm" onClick={() => inputRef.current?.click()}>{t('project.import.choose')}</Button>
        <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{file ? file.name : t('project.import.no_file')}</p>
        <Button variant="primary" disabled={!file || busy} onClick={() => void submit()}>{t('project.import.submit')}</Button>
      </div>
    </Modal>
  )
}