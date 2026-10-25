/**
 * The estimate editor: one ladder of presets, one typed duration, two doors in.
 *
 * The card's chip and the task editor's field are the same question — "how long do you plan this to
 * take" — asked from two places, so they share one control instead of writing the ladder twice. The
 * reference app offers exactly this shape: a short list of the durations people actually plan in, plus
 * free text for the rest, and a bare number read as minutes.
 *
 * Neither half is a native control. `SelectMenu` is the app's own menu over `menuitemcheckbox` rows —
 * a `<select>` cannot carry the duration typography and ignores every design token — and the custom
 * entry is the shared `Input` over the duration grammar, not `type="number"`: the field accepts `1h20m`,
 * which no number spinner can express.
 *
 * The invalid state is reported rather than swallowed. A reader who types `soon` and presses save gets
 * a refusal and a kept estimate; writing zero for words that are not a duration would silently erase a
 * plan they never meant to touch.
 */
import { useRef, useState } from 'react'
import { SelectMenu } from '../../components/select-menu'
import { Input } from '../../components/form'
import { Button } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { parseTaskDuration, formatTaskDuration } from '@shared/todos/duration'
import { TIME_ESTIMATE_PRESETS_MS } from '@shared/todos/model'

/** What the picker says the reader now means, and whether the words in the box can be honoured. */
export interface EstimateEdit {
  /** The estimate to write, or null for "take the plan away". */
  value: number | null
  /** The custom box holds words that are not a duration, so nothing may be written from it. */
  invalid: boolean
}

/** The menu's three non-numeric rows. */
const NONE = 'none'
const CUSTOM = 'custom'

/**
 * The preset ladder as menu coordinates, in the order a reader scans it.
 *
 * Preset values are stringified so one `SelectMenu` can hold both the ladder and the two words that
 * stand outside it; the number the reader picks is read back from the same list.
 */
function presetKey(ms: number): string {
  return String(ms)
}

/** The preset the current estimate sits on, or null when it is neither none nor one of the ladder. */
function presetOf(value: number | null): string {
  if (value === null) return NONE
  return TIME_ESTIMATE_PRESETS_MS.some((entry) => entry === value) ? presetKey(value) : CUSTOM
}

export function EstimatePicker({
  estimate,
  onChange,
  className,
}: {
  /** The estimate the row carries when the picker opens; the starting point, not a live value. */
  estimate: number | null
  /** Every pick or typed word answers with what should now be written, and whether it may be. */
  onChange: (edit: EstimateEdit) => void
  className?: string
}) {
  const [value, setValue] = useState<number | null>(estimate)
  const [text, setText] = useState('')
  const [invalid, setInvalid] = useState(false)
  const customRef = useRef<HTMLInputElement>(null)

  const report = (next: EstimateEdit): void => {
    setValue(next.value)
    setInvalid(next.invalid)
    onChange(next)
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <SelectMenu
        label={t('todo.time.label')}
        value={text.trim() ? CUSTOM : presetOf(value)}
        onChange={(key) => {
          setText('')
          if (key === NONE) {
            report({ value: null, invalid: false })
            return
          }
          if (key === CUSTOM) {
            // The typed box is the whole point of picking "custom": take the reader there.
            customRef.current?.focus()
            return
          }
          report({ value: Number(key), invalid: false })
        }}
        options={[
          { value: NONE, label: t('todo.time.none') },
          ...TIME_ESTIMATE_PRESETS_MS.map((ms) => ({ value: presetKey(ms), label: formatTaskDuration(ms) })),
          { value: CUSTOM, label: t('todo.time.custom') },
        ]}
      />
      <Input
        ref={customRef}
        data-estimate-custom=""
        aria-label={t('todo.time.custom_label')}
        placeholder={t('todo.time.custom_hint')}
        value={text}
        invalid={invalid}
        onChange={(event) => {
          const words = event.target.value
          setText(words)
          if (!words.trim()) {
            // Emptying the box hands the choice back to the ladder rather than meaning "zero".
            report({ value, invalid: false })
            return
          }
          const parsed = parseTaskDuration(words)
          if (parsed === null) {
            setValue(value)
            setInvalid(true)
            onChange({ value, invalid: true })
            return
          }
          report({ value: parsed, invalid: false })
        }}
      />
      {invalid && (
        // The refusal names the box it belongs to and stays beside it, so the reader is not left
        // hunting for the field that was not understood.
        <span role="alert" className="text-[length:var(--text-11)] text-[var(--danger)]">
          {t('todo.time.invalid')}
        </span>
      )}
    </div>
  )
}

/**
 * The card's own door to the estimate: the picker, on a surface, over the row it belongs to.
 *
 * The row is where a reader notices that the plan and the reality have come apart, so asking them to
 * open the editor to fix a number they can already see would be a second gesture for one decision.
 * `Modal` brings the focus trap, Escape, the backdrop and the announced name; the save is refused
 * while the custom box holds words that are not a duration rather than writing what the reader did
 * not say.
 */
export function EstimateDialog({ open, title, estimate, onClose, onSave }: {
  open: boolean
  /** The row being changed, named so the dialog answers for a task the reader can point at. */
  title: string
  estimate: number | null
  onClose: () => void
  /** Called only with a value the reader can stand behind — a duration, or null for none. */
  onSave: (value: number | null) => void
}) {
  const [edit, setEdit] = useState<EstimateEdit>({ value: estimate, invalid: false })
  // The picker is mounted per opening, so a close without saving cannot leak a half-typed number into
  // the next row's dialog; the key is the row's own, which is the thing that actually changed.
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('todo.time.dialog_title')}
      description={t('todo.time.dialog_description', { title })}
      width={420}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('todo.action.cancel')}</Button>
          <Button
            size="sm"
            data-estimate-save=""
            disabled={edit.invalid}
            onClick={() => { onSave(edit.value) }}
          >
            {t('todo.action.save')}
          </Button>
        </>
      )}
    >
      <EstimatePicker key={title} estimate={estimate} onChange={setEdit} />
    </Modal>
  )
}
