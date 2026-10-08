/**
 * The shell's side of QuickAdd: load the account's library, and turn each choice that carries a
 * shortcut into a real key binding.
 *
 * The bindings are registered while the library is loaded and disposed when it changes, so a renamed
 * or re-keyed choice takes effect on the next keystroke rather than needing a reload. Two choices with
 * the same combo cannot both fire: the registry is walked in insertion order, which is tree order, so
 * the choice the reader sees first in the launcher is the one that owns the key — and the settings
 * editor says so before it lets the collision through.
 */
import { useEffect } from 'react'
import type { QuickAddChoice } from '@shared/quickadd'
import { register, type Hotkey } from '../../lib/hotkeys'
import { t } from '../../lib/i18n'
import { useQuickAdd } from '../../store/quickadd'

function choiceHotkey(choice: QuickAddChoice): Hotkey {
  return {
    id: `quickadd:${choice.id}`,
    combo: choice.hotkey!,
    description: () => t('quickadd.run_choice', { name: choice.name }),
    group: () => t('quickadd.group'),
    // The reader is usually inside a note when they press it, and the shortcut has to reach them there.
    allowInInput: true,
    handler: () => {
      void import('../../lib/quickadd/runner').then(({ runQuickAddChoice }) => runQuickAddChoice(choice.id))
    },
  }
}

export function useQuickAddBridge(owner: string | undefined): void {
  const hydrate = useQuickAdd((state) => state.hydrate)
  const enabled = useQuickAdd((state) => state.settings.enabled)
  const choices = useQuickAdd((state) => state.choices)

  useEffect(() => {
    if (!owner) return
    void hydrate(owner).catch((error) => {
      console.warn('[quickadd] failed to load the choice library', error)
    })
  }, [owner, hydrate])

  useEffect(() => {
    if (!enabled) return
    const wanted = [...choices]
      .sort((a, b) => a.position - b.position)
      .filter((choice) => choice.enabled && choice.type !== 'group' && choice.hotkey)
    const claimed = new Set<string>()
    const disposers = wanted
      .filter((choice) => {
        const combo = choice.hotkey!.toLowerCase()
        if (claimed.has(combo)) return false
        claimed.add(combo)
        return true
      })
      .map((choice) => register(choiceHotkey(choice)))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, [choices, enabled])
}
