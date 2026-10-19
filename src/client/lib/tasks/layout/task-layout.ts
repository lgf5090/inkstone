/**
 * The parts a task line is made of.
 *
 * **This declaration order is the on-disk order.** Writing `📅` before `✅` and then reading the
 * line back works either way, but a stable order is what lets a rewrite change one field without
 * reshuffling its neighbours into a diff the reader has to re-learn.
 */
export enum TaskLayoutComponent {
  Description = 'description',
  Id = 'id',
  DependsOn = 'dependsOn',
  Priority = 'priority',
  RecurrenceRule = 'recurrenceRule',
  OnCompletion = 'onCompletion',
  CreatedDate = 'createdDate',
  StartDate = 'startDate',
  ScheduledDate = 'scheduledDate',
  DueDate = 'dueDate',
  CancelledDate = 'cancelledDate',
  DoneDate = 'doneDate',
  BlockLink = 'blockLink',
}

export const TASK_LAYOUT_COMPONENTS: TaskLayoutComponent[] = Object.values(TaskLayoutComponent)

const DATE_COMPONENTS: TaskLayoutComponent[] = [

  TaskLayoutComponent.CreatedDate,
  TaskLayoutComponent.StartDate,
  TaskLayoutComponent.ScheduledDate,
  TaskLayoutComponent.DueDate,
  TaskLayoutComponent.CancelledDate,
  TaskLayoutComponent.DoneDate,
]

/**
 * Which components a query draws, and how much of each.
 *
 * `shortMode` keeps a field's symbol and drops its value, which is how a dense list still shows
 * that a task is overdue without spending a column on the date.
 */
export class TaskLayoutOptions {
  private readonly hidden = new Set<TaskLayoutComponent>()
  private tagsVisible = true

  constructor(hidden: Iterable<TaskLayoutComponent> = []) {
    for (const component of hidden) this.hidden.add(component)
  }

  static readonly DATE_COMPONENTS = DATE_COMPONENTS

  isShown(component: TaskLayoutComponent): boolean {
    return !this.hidden.has(component)
  }


  areTagsShown(): boolean {
    return this.tagsVisible
  }

  hide(component: TaskLayoutComponent): void {
    this.hidden.add(component)
  }

  show(component: TaskLayoutComponent): void {
    this.hidden.delete(component)
  }

  setVisibility(component: TaskLayoutComponent, visible: boolean): void {
    if (visible) this.show(component)
    else this.hide(component)
  }

  setTagsVisibility(visible: boolean): void {
    this.tagsVisible = visible
  }

  hideAllDateComponents(): void {
    for (const component of DATE_COMPONENTS) this.hide(component)
  }

  /** Components in declaration order, which is also the order they are written back in. */
  get shownComponents(): TaskLayoutComponent[] {
    return TASK_LAYOUT_COMPONENTS.filter((component) => this.isShown(component))
  }
}
