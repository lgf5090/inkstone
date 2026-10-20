/**
 * The twin of `en-US-todo-notify.ts`; the two are proven against each other by key and by placeholder
 * in `tests/todo-reminders.test.ts`.
 */
export const ZH_CN_TODO_NOTIFY = {
  title: '待办提醒',
  due: '{when} 到期',
  noDue: '这条待办有一条提醒',
  digestSummary: '今天 {today} 条，逾期 {overdue} 条',
  digestOverdue: '逾期',
  digestToday: '今天',
  digestNone: '今天没有到期的待办。',
  digestRest: '另有 {count} 条待办',
}
