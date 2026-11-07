import { useRef } from 'react'
import { BetweenHorizontalStart, CornerDownLeft, Play } from 'lucide-react'
import { Button } from '../../components/primitives'
import { Field, Textarea } from '../../components/form'
import { t } from '../../lib/i18n'
import { currentLineAt, isCommandSendShortcut, QUICK_COMMAND_TEXT_MAX } from './quick-commands'

export function CommandEditor({
  value,
  onChange,
  canInsert,
  canSend,
  onInsert,
  onSendAll,
  onSendLine,
}: {
  value: string
  onChange: (value: string) => void
  canInsert: boolean
  canSend: boolean
  onInsert: (text: string) => void
  onSendAll: (text: string) => void
  onSendLine: (text: string) => void
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)

  const line = () => {
    const textarea = ref.current
    if (!textarea) return value.trim() ? value.split('\n')[0] : ''
    return currentLineAt(value, textarea.selectionStart)
  }

  return (
    <div className="space-y-2">
      <Field label={t('webssh.quick.editor')} hint={t('webssh.quick.editor_hint')}>
        <Textarea
          ref={ref}
          rows={5}
          value={value}
          maxLength={QUICK_COMMAND_TEXT_MAX}
          className="font-mono text-[length:var(--text-12)]"
          placeholder={t('webssh.quick.editor_placeholder')}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (!isCommandSendShortcut(event)) return
            event.preventDefault()
            if (value.trim()) onSendAll(value)
          }}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="secondary" icon={<BetweenHorizontalStart size={13} aria-hidden="true" />} disabled={!canInsert || !value.trim()} onClick={() => onInsert(value)}>
          {t('webssh.quick.insert')}
        </Button>
        <Button size="sm" variant="secondary" icon={<CornerDownLeft size={13} aria-hidden="true" />} disabled={!canSend || !line().trim()} onClick={() => onSendLine(line())}>
          {t('webssh.quick.send_line')}
        </Button>
        <Button size="sm" variant="primary" icon={<Play size={13} aria-hidden="true" />} disabled={!canSend || !value.trim()} onClick={() => onSendAll(value)}>
          {t('webssh.quick.send_all')}
        </Button>
      </div>
      <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('webssh.quick.send_hint')}</p>
    </div>
  )
}
