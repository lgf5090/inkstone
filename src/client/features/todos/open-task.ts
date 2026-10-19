/**
 * Opening one task from somewhere that is not the to-do app.
 *
 * A chip in a tool result, a saved message, a note selection — each of them names a task by id and each
 * of them has to land the reader in the same place: the to-do tab, that task's panel open. Doing that
 * from three call sites is how the three of them drift, so the navigation lives here once.
 *
 * The tab switch comes first because it is instant and the load behind it is not: the reader sees the
 * app they asked for while the row is read, rather than a chat that appears to ignore the press. What
 * the store then does — read the row if the open page does not hold it, and open the panel on it — is
 * the half that can fail, and it says so with a toast instead of a panel over nothing.
 */
import { navigateToPath } from '../../lib/app-history'
import { useTodos } from './store'

/** Show one task in the to-do tab, its panel open. */
export async function openTaskInTodo(id: string): Promise<void> {
  navigateToPath('/todo')
  await useTodos.getState().openTask(id)
}
