/**
 * The names the open board listens for.
 *
 * The tool implementations live in the worker; the page only needs to know which results mean its
 * copy is stale. Keeping the list here rather than importing the worker module keeps the client
 * chunk free of it, and `project-tools.test.ts` pins the two against each other so a new write tool
 * cannot be added without the board learning to refresh.
 */
export const PROJECT_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'project_create_card',
  'project_update_card',
  'project_schedule_card',
  'project_delete_card',
])
