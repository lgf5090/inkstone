/**
 * The words a task reminder carries, in English.
 *
 * A separate catalog from the interface's for the reason the subscription one states: the sweep runs on
 * a cron tick with no request behind it, and shipping seven thousand interface keys into the worker to
 * reach three sentences is a cost every deployment pays. `tests/todo-reminders.test.ts` proves this file
 * and its Chinese twin carry the same keys and the same placeholders.
 */
export const EN_US_TODO_NOTIFY = {
  title: 'Task reminder',
  due: 'Due {when}',
  noDue: 'A reminder for this task',
}
