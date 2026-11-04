/**
 * The one dialog that names a comparison before it is saved.
 *
 * The project name is the reader's own word for the pair, so it is typed rather than derived: two
 * files called `config.json` in different folders would otherwise both be "config.json".
 */
import { useEffect, useState } from 'react'
import { Button } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { t } from '../../../../lib/i18n'
import { PROJECT_LIMITS } from '@shared/tools/compare/types'

export function SaveDialog({
  open,
  defaultName,
  busy,
  onClose,
  onSave,
}: {
  open: boolean
  defaultName: string
  busy?: boolean
  onClose: () => void
  onSave: (name: string) => void
}) {
  const [name, setName] = useState(defaultName)
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (open) {
      setName(defaultName.slice(0, PROJECT_LIMITS.name))
      setTouched(false)
    }
  }, [open, defaultName])

  const trimmed = name.trim()
  const invalid = touched && !trimmed

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('tools.compare.save.title')}
      description={t('tools.compare.save.desc')}
      width={440}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              setTouched(true)
              if (trimmed) onSave(trimmed)
            }}
          >
            {t('tools.compare.save.submit')}
          </Button>
        </>
      )}
    >
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => setTouched(true)}
        aria-label={t('tools.compare.save.name')}
        aria-invalid={invalid || undefined}
        invalid={invalid}
        maxLength={PROJECT_LIMITS.name}
        placeholder={t('tools.compare.save.name')}
        autoFocus
      />
      {invalid && <p className="mt-1 text-[length:var(--text-11)] text-[var(--danger)]">{t('tools.compare.save.name_required')}</p>}
    </Modal>
  )
}
