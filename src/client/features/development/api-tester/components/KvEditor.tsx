import { useRef, useState } from 'react'
import { File as FileIcon, Loader2, Paperclip, Plus, Trash2 } from 'lucide-react'
import { MAX_FILE_BYTES, MAX_KV_ITEMS } from '@shared/development/api-tester/limits'
import { kv } from '@shared/development/api-tester/state'
import type { KeyValue } from '@shared/development/api-tester/types'
import { Checkbox } from '../../../../components/form'
import { Button, IconButton } from '../../../../components/primitives'
import { t } from '../../../../lib/i18n'
import { formatBytes } from '../../../../lib/time'
import { errorMessage, uploadFile } from '../api'
import { VariableAutocomplete, type AutocompleteVariable } from './VariableAutocomplete'

export function KvEditor({
  items,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  showCheckbox = true,
  variables = [],
  allowFile = false,
  onFileRemoved,
}: {
  items: KeyValue[]
  onChange: (items: KeyValue[]) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
  showCheckbox?: boolean
  variables?: readonly AutocompleteVariable[]
  /** form-data fields may point at an uploaded file instead of a text value. */
  allowFile?: boolean
  onFileRemoved?: (fileId: string) => void
}) {
  const itemsRef = useRef(items)
  itemsRef.current = items
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const pendingFileId = useRef<string | null>(null)
  const [uploadingId, setUploadingId] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const update = (id: string, patch: Partial<KeyValue>) => {
    onChange(itemsRef.current.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  const remove = (item: KeyValue) => {
    if (item.fileId) onFileRemoved?.(item.fileId)
    onChange(itemsRef.current.filter((entry) => entry.id !== item.id))
  }

  const clearFile = (item: KeyValue) => {
    if (item.fileId) onFileRemoved?.(item.fileId)
    update(item.id, { isFile: false, fileId: undefined, fileName: undefined, fileSize: undefined, fileType: undefined })
  }

  const chooseFile = (id: string) => {
    pendingFileId.current = id
    setUploadError(null)
    fileInputRef.current?.click()
  }

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const target = event.target
    const file = target.files?.[0]
    target.value = ''
    const id = pendingFileId.current
    pendingFileId.current = null
    if (!file || !id) return
    if (file.size > MAX_FILE_BYTES) {
      setUploadError(t('api.error.payload_too_large'))
      return
    }
    setUploadingId(id)
    setUploadError(null)
    try {
      const uploaded = await uploadFile(file, file.type.startsWith('image/') ? 'image' : 'bin', file.name)
      update(id, {
        isFile: true,
        fileId: uploaded.id,
        fileName: uploaded.name,
        fileSize: uploaded.size,
        fileType: uploaded.contentType,
        value: '',
      })
    } catch (error) {
      setUploadError(errorMessage(error))
    } finally {
      setUploadingId(null)
    }
  }

  return (
    <div className="space-y-1">
      {allowFile && (
        <input
          ref={fileInputRef}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-label={t('development.apitester.choose_file')}
          onChange={(event) => void handleFileChange(event)}
        />
      )}
      {items.map((item) => (
        <div key={item.id} className="flex items-center gap-1.5">
          {showCheckbox && (
            <Checkbox
              checked={item.enabled}
              onChange={(enabled) => update(item.id, { enabled })}
              ariaLabel={t('development.apitester.enabled')}
              className="shrink-0"
            />
          )}
          <VariableAutocomplete
            value={item.key}
            variables={variables}
            placeholder={keyPlaceholder ?? t('development.apitester.key_name')}
            ariaLabel={keyPlaceholder ?? t('development.apitester.key_name')}
            wrapperClassName="min-w-0 flex-1"
            className="h-8 font-mono text-[length:var(--text-12)]"
            onValueChange={(key) => update(item.id, { key })}
          />
          {item.isFile ? (
            <div className="flex min-w-0 flex-1 items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2 py-1 text-[length:var(--text-11)]">
              <FileIcon size={12} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
              <span className="min-w-0 flex-1 truncate font-mono">{item.fileName ?? t('development.apitester.file_selected')}</span>
              {typeof item.fileSize === 'number' && (
                <span className="shrink-0 text-[var(--text-tertiary)]">{formatBytes(item.fileSize)}</span>
              )}
              <IconButton
                label={t('development.apitester.remove_file')}
                size="sm"
                className="shrink-0 text-[var(--text-tertiary)] hover:text-[var(--danger)]"
                onClick={() => clearFile(item)}
              >
                <Trash2 size={12} />
              </IconButton>
            </div>
          ) : (
            <VariableAutocomplete
              value={item.value}
              variables={variables}
              placeholder={valuePlaceholder ?? t('development.apitester.key_value')}
              ariaLabel={valuePlaceholder ?? t('development.apitester.key_value')}
              wrapperClassName="min-w-0 flex-1"
              className="h-8 font-mono text-[length:var(--text-12)]"
              onValueChange={(value) => update(item.id, { value })}
            />
          )}
          {allowFile && (
            <IconButton
              label={t('development.apitester.choose_file')}
              size="sm"
              className="shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              disabled={uploadingId === item.id}
              onClick={() => chooseFile(item.id)}
            >
              {uploadingId === item.id ? <Loader2 size={12} className="animate-spin" /> : <Paperclip size={12} />}
            </IconButton>
          )}
          <IconButton
            label={t('development.apitester.delete')}
            size="sm"
            className="shrink-0 text-[var(--text-tertiary)] hover:text-[var(--danger)]"
            onClick={() => remove(item)}
          >
            <Trash2 size={13} />
          </IconButton>
        </div>
      ))}
      {uploadError && (
        <p role="alert" className="text-[length:var(--text-11)] text-[var(--danger)]">
          {uploadError}
        </p>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="gap-1 text-[var(--text-secondary)]"
        icon={<Plus size={13} />}
        disabled={items.length >= MAX_KV_ITEMS}
        onClick={() => onChange([...items, kv()])}
      >
        {t('development.apitester.add')}
      </Button>
    </div>
  )
}
