/**
 * Opening one task by its address, from anywhere.
 *
 * A chip in a tool result, a saved message, a note selection, the row of a notification centre — each of
 * them names a task by id, and each has to land the reader in the same place: the to-do tab, that task's
 * own address, its panel open. That place is now a real address (`/todo/<id>`), which means the callers do
 * not have to know anything about the to-do app's state: they ask for a task, and the address bar does the
 * moving. The container's own first paint reads the same address, so a link pasted into another tab, or
 * held on a phone and opened from a reminder, arrives at the same screen a press inside the app does.
 *
 * The tab is put right before the task address is written, because the tab is instant and the read behind
 * it is not: the reader sees the app they asked for while the row is being fetched, rather than a chat that
 * appears to ignore the press. What the store then does — read the row if the open page does not hold it,
 * and open the panel on it — is the half that can fail, and it says so with a toast and an address that no
 * longer names a task, rather than a panel over nothing.
 */
import { navigateToPath, currentPathname } from '../../lib/app-history'
import { tabIdForPath } from '../shell/app-tabs'
import { TODO_PATH } from './todo-address'
import { useTodos } from './store'

/** Show one task in the to-do tab, its panel open, at the address that names it. */
export async function openTaskInTodo(id: string): Promise<void> {
  if (tabIdForPath(currentPathname()) !== 'todo') navigateToPath(TODO_PATH)
  await useTodos.getState().openTask(id)
}
