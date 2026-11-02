import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { CURSOR_COMMAND_EXECUTIONS, MAX_CURSOR_COMMAND_INSTRUCTION_CHARS, MAX_CURSOR_COMMAND_LABEL_CHARS, type AssistantCursorCommand, type CursorCommandExecution } from '@shared/assistant'
import { t, type MessageKey } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Input, Select, Textarea } from '../../components/form'
import { useAssistant } from './assistant-store'

const EXECUTION_LABELS: Record<CursorCommandExecution, MessageKey> = {
  'quick-ask-ask': 'assistant.cursor_commands.exec.ask',
  'quick-ask-rewrite': 'assistant.cursor_commands.exec.rewrite',
  'add-to-composer': 'assistant.cursor_commands.exec.composer',
  'add-and-send': 'assistant.cursor_commands.exec.send',
}

/**
 * The reader's own instructions for a passage.
 *
 * Each row is one command rather than a mini prompt editor: a command is a name, one instruction and
 * where it goes, and anything longer belongs in a Skill.
 */
export function CursorCommandsSection() {
  const commands = useAssistant((state) => state.cursorCommands)
  const create = useAssistant((state) => state.createCursorCommand)
  const update = useAssistant((state) => state.updateCursorCommand)
  const remove = useAssistant((state) => state.removeCursorCommand)
  const [label, setLabel] = useState('')
  const [instruction, setInstruction] = useState('')
  const [execution, setExecution] = useState<CursorCommandExecution>('quick-ask-ask')
  const [busy, setBusy] = useState(false)

  const add = () => {
    if (!label.trim() || !instruction.trim() || busy) return
    setBusy(true)
    void create({ label: label.trim(), instruction: instruction.trim(), execution }).then((ok) => {
      setBusy(false)
      if (ok) {
        setLabel('')
        setInstruction('')
      }
    })
  }

  return (
    <div className="space-y-2 py-2">
      <div className="space-y-1.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2">
        <div className="flex gap-1.5">
          <Input
            value={label}
            maxLength={MAX_CURSOR_COMMAND_LABEL_CHARS}
            placeholder={t('assistant.cursor_commands.name')}
            aria-label={t('assistant.cursor_commands.name')}
            onChange={(event) => setLabel(event.target.value)}
            className="h-8 flex-1"
          />
          <Select
            value={execution}
            aria-label={t('assistant.cursor_commands.execution')}
            onChange={(event) => setExecution(event.target.value as CursorCommandExecution)}
            className="h-8 w-48 text-[length:var(--text-11)]"
          >
            {CURSOR_COMMAND_EXECUTIONS.map((entry) => (
              <option key={entry} value={entry}>{t(EXECUTION_LABELS[entry])}</option>
            ))}
          </Select>
        </div>
        <Textarea
          rows={2}
          value={instruction}
          maxLength={MAX_CURSOR_COMMAND_INSTRUCTION_CHARS}
          placeholder={t('assistant.cursor_commands.instruction')}
          aria-label={t('assistant.cursor_commands.instruction')}
          onChange={(event) => setInstruction(event.target.value)}
        />
        <div className="flex justify-end">
          <Button size="sm" variant="secondary" disabled={!label.trim() || !instruction.trim() || busy} onClick={add}>
            {t('assistant.cursor_commands.add')}
          </Button>
        </div>
      </div>
      {commands.length === 0
        ? <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('assistant.cursor_commands.empty')}</p>
        : (
          <ul className="divide-y divide-[var(--border-subtle)] rounded-[var(--r-md)] border border-[var(--border-subtle)]">
            {commands.map((command: AssistantCursorCommand) => (
              <li key={command.id} className="flex items-center gap-2 px-2.5 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{command.label}</p>
                  <p className="truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t(EXECUTION_LABELS[command.execution])}</p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-pressed={command.enabled}
                  onClick={() => void update(command.id, { enabled: !command.enabled })}
                >
                  {t(command.enabled ? 'assistant.cursor_commands.enabled' : 'assistant.cursor_commands.disabled')}
                </Button>
                <IconButton label={t('common.delete')} size="sm" onClick={() => void remove(command.id)}>
                  <Trash2 size={13} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}
