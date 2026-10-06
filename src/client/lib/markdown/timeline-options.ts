import { infoFlag, infoOption } from './info-string';

export type TimelineStatus = 'todo' | 'doing' | 'done' | 'milestone' | 'error';
export type TimelineMarker = 'dot' | 'number';

export interface TimelineItem {
  status: TimelineStatus;
  time: string;
  title: string;
}

export interface TimelineOptions {
  dense: boolean;
  status: boolean;
  marker: TimelineMarker;
}

export const TIMELINE_OPTION_DEFAULTS: TimelineOptions = { dense: false, status: true, marker: 'dot' };

const STATUS_WORDS = new Map<string, TimelineStatus>([
  ['', 'todo'],
  ['todo', 'todo'],
  ['doing', 'doing'],
  ['wip', 'doing'],
  ['…', 'doing'],
  ['~', 'doing'],
  ['done', 'done'],
  ['x', 'done'],
  ['✓', 'done'],
  ['milestone', 'milestone'],
  ['*', 'milestone'],
  ['★', 'milestone'],
  ['error', 'error'],
  ['err', 'error'],
  ['!', 'error'],
  ['×', 'error'],
  ['✗', 'error'],
]);

const STATUS_MARKER = /^\[([^\]\n]*)\][ \t]*/;
const FIRST_WORD = /^(\S+)(?:[ \t]+([\s\S]*))?$/;
const OPTION_GROUP = /^(.*?)[ \t]*\{([^{}]+)\}[ \t]*$/;
const DATETIME = /^\d{4}-\d{2}(?:-\d{2})?$/;

/**
 * An unrecognised bracket group is left where it is, so `[2024] Annual report` keeps its year rather
 * than spending it on a status the author never wrote.
 */
export function parseTimelineItem(head: string): TimelineItem {
  const line = head.trim();
  const marked = STATUS_MARKER.exec(line);
  const status = marked ? STATUS_WORDS.get(marked[1]!.trim().toLowerCase()) : undefined;
  const rest = marked && status ? line.slice(marked[0].length).trim() : line;
  const parts = FIRST_WORD.exec(rest);
  const candidate = parts?.[1] ?? '';
  const isTime = /^\d/.test(candidate) || /^v\d/i.test(candidate);
  return {
    status: status ?? 'todo',
    time: isTime ? candidate : '',
    title: (isTime ? parts?.[2] ?? '' : rest).trim(),
  };
}

export function isTimelineDateTime(value: string): boolean {
  return DATETIME.test(value);
}

export function splitTimelineInfo(info: string): { title: string, options: TimelineOptions } {
  const trimmed = info.trim();
  const group = OPTION_GROUP.exec(trimmed);
  if (group) {
    const options = readOptionGroup(group[2]!);
    if (options)
      return { title: group[1]!.trim(), options };
  }
  return { title: trimmed, options: TIMELINE_OPTION_DEFAULTS };
}

function readOptionGroup(inner: string): TimelineOptions | null {
  const next: TimelineOptions = { ...TIMELINE_OPTION_DEFAULTS };
  for (const token of inner.split(/\s+/).filter(Boolean)) {
    if (infoFlag(token) === 'dense') {
      next.dense = true;
      continue;
    }
    const option = infoOption(token);
    if (!option) return null;
    const value = option.value.toLowerCase();
    if (option.key === 'status') {
      if (value !== 'on' && value !== 'off') return null;
      next.status = value === 'on';
      continue;
    }
    if (option.key === 'marker') {
      if (value !== 'dot' && value !== 'number') return null;
      next.marker = value;
      continue;
    }
    return null;
  }
  return next;
}
