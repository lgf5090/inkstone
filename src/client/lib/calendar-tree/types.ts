export type CalendarPeriod =
  | { kind: 'root' }
  | { kind: 'year'; year: number }
  | { kind: 'quarter'; year: number; quarter: number }
  | { kind: 'month'; year: number; month: number }
  | { kind: 'week'; year: number; month: number; week: number }

export type CalendarPeriodKind = CalendarPeriod['kind']

export interface CalendarNode {
    id: string;
    name: string;
    depth: number;
    count: number;
    children: CalendarNode[];
}
