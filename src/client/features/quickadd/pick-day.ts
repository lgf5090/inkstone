/**
 * The one implementation of "run this choice, but ask which day it counts from first".
 *
 * Two entries reach for it: the launcher's Shift, and the second palette command a choice can carry
 * when the reader wants that entry to have its own name or hotkey. Asking here rather than inside the
 * engine keeps the shape the launcher has always had — a dismissed question runs nothing at all, no
 * cancelled-run notice — and hands the engine a day it must not ask for a second time.
 */
import type { QuickAddChoice } from '@shared/quickadd'
import { t } from '../../lib/i18n'
import { useQuickAdd } from '../../store/quickadd'
import { askQuickAddPrompts } from './prompt-queue'
import { promptRequest } from '../../lib/quickadd/session'

export async function runChoiceWithChosenDay(
  choice: QuickAddChoice,
  options: { sourceNoteId?: string } = {},
): Promise<void> {
  const { dateFormat } = useQuickAdd.getState().settings
  const answers = await askQuickAddPrompts({
    requests: [promptRequest({
      kind: 'date',
      key: 'day',
      label: t('quickadd.prompt_day'),
      dateFormat,
    })],
    onePage: false,
    choiceId: choice.id,
    choiceName: choice.name,
  })
  const value = answers?.get('day')
  const stamp = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(stamp)) return
  const { runQuickAddChoice } = await import('../../lib/quickadd/runner')
  await runQuickAddChoice(choice.id, { sourceNoteId: options.sourceNoteId, day: new Date(stamp) })
}
