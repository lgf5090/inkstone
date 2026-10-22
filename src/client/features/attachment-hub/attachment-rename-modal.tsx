import { useEffect, useState } from 'react'
import { Pencil } from 'lucide-react'
import { Modal } from '../../components/overlay'
import { Button } from '../../components/primitives'
import { Input } from '../../components/form'
import { t } from '../../lib/i18n'

const MODAL_WIDTH = 440

interface AttachmentRenameModalProps {
  open: boolean
  onClose: () => void
  currentFilename: string
  onRename: (newFilename: string) => Promise<void>
}

export function AttachmentRenameModal(props: AttachmentRenameModalProps) {
  const { open, onClose, currentFilename, onRename } = props
  const [name, setName] = useState(currentFilename)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setName(currentFilename)
  }, [currentFilename, open])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || trimmed === currentFilename) {
      onClose()
      return
    }
    setIsSaving(true)
    try {
      await onRename(trimmed)
      onClose()
    }
    finally {
      setIsSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={(
        <div className='flex items-center gap-[var(--sp-2)]'>
          <Pencil size={15} className='text-[var(--accent)]' />
          <span>{t('attachments.rename')}</span>
        </div>
      )}
      width={MODAL_WIDTH}
    >
      <form onSubmit={(e) => void submit(e)} className='space-y-[var(--sp-4)] pt-[var(--sp-1)]'>
        <label className='block space-y-[var(--sp-1-5)]'>
          <span className='text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]'>
            {t('attachments.filename')}
          </span>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} disabled={isSaving} />
        </label>

        <div className='flex items-center justify-end gap-[var(--sp-2)] pt-[var(--sp-2)]'>
          <Button type='button' variant='secondary' size='sm' onClick={onClose} disabled={isSaving}>
            {t('common.cancel')}
          </Button>
          <Button type='submit' size='sm' disabled={!name.trim() || isSaving}>
            {isSaving ? t('common.loading') : t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
