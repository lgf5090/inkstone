export interface FenceInfo {
  language: string;
  title: string;
  lineNumbers: boolean;
  startLine: number;
  highlightedLines: number[];
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? Math.trunc(value) : min));
}

export function parseLineSpec(source: string): number[] {
  const lines = new Set<number>();
  for (const part of source.split(/[ ,]+/).filter(Boolean).slice(0, 200)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const from = clamp(Number(range[1]), 1, 100000);
      const to = clamp(Number(range[2]), from, Math.min(100000, from + 1000));
      for (let line = from; line <= to; line++)
        lines.add(line);
    }
    else if (/^\d+$/.test(part)) {
      lines.add(clamp(Number(part), 1, 100000));
    }
  }
  return [...lines];
}

function isReservedCodeClass(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[-_]/g, '');
  return ['numberlines', 'linenumbers', 'linenos', 'showlinenumbers'].includes(normalized);
}

function codeMetadataValue(source: string, ...names: string[]): string | null {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const pattern = /(?:^|\s)([A-Za-z][\w-]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  for (const match of source.matchAll(pattern)) {
    if (wanted.has(match[1]!.toLowerCase()))
      return (match[2] ?? match[3] ?? match[4] ?? '').slice(0, 512);
  }
  return null;
}

interface FenceLeadingOptions {
  language: string;
  title: string;
  hasLineNumbers: boolean;
  startLine: number;
  highlighted: number[];
  rest: string;
}

function parseFenceLeadingOptions(rest: string): FenceLeadingOptions | null {
  const leadingCodeOptions = /^\{([^{}]+)\}/.exec(rest);
  if (!leadingCodeOptions || /^\d[\d,\s-]*$/.test(leadingCodeOptions[1]!.trim()))
    return null;
  const classes = [...leadingCodeOptions[1]!.matchAll(/(?:^|\s)\.([A-Za-z][\w-]{0,63})/g)]
    .map((match) => match[1]!);
  const highlighted: number[] = [];
  const highlightAttribute = codeMetadataValue(leadingCodeOptions[1]!, 'hl_lines', 'highlight');
  if (highlightAttribute)
    parseLineSpec(highlightAttribute).forEach((line) => highlighted.push(line));
  const startAttribute = codeMetadataValue(leadingCodeOptions[1]!, 'start', 'startfrom');
  return {
    language: classes.find((className) => !isReservedCodeClass(className))?.toLowerCase() ?? '',
    title: codeMetadataValue(leadingCodeOptions[1]!, 'title') ?? '',
    hasLineNumbers: classes.some(isReservedCodeClass),
    startLine: startAttribute && /^\d+$/.test(startAttribute) ? clamp(Number(startAttribute), 1, 100000) : 1,
    highlighted,
    rest: rest.slice(leadingCodeOptions[0].length).trim(),
  };
}

interface FenceTrailingOptions {
  title: string;
  lineNumbers: 'disable' | 'enable' | null;
  startLine: number | null;
  highlighted: number[];
}

function parseFenceTrailingOptions(rest: string, initialTitle: string): FenceTrailingOptions {
  let title = initialTitle;
  const titleMatch = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|([^\s]+))/.exec(rest);
  if (titleMatch)
    title = titleMatch[1] ?? titleMatch[2] ?? titleMatch[3] ?? '';
  const bracketTitle = /(?:^|\s)\[([^\]\n]+)\]/.exec(rest);
  if (!title && bracketTitle)
    title = bracketTitle[1]!.trim();
  const hasLineNumbersDisable = /(?:^|[\s{])\.?(?:line-?numbers|linenos|number-?lines|show-?line-?numbers)=(?:"?false"?|0)(?=[\s}]|$)/i.test(rest);
  const hasLineNumbersEnable = /(?:^|[\s{])\.?(?:line-?numbers|linenos|number-?lines|show-?line-?numbers)(?:=(?:"?true"?|1))?(?=[\s}]|$)/i.test(rest);
  const lineNumbers = hasLineNumbersDisable ? 'disable' : hasLineNumbersEnable ? 'enable' : null;
  const start = /(?:^|\s)(?:start|startFrom)=(?:"(\d+)"|'(\d+)'|(\d+))/.exec(rest);
  const startLine = start ? clamp(Number(start[1] ?? start[2] ?? start[3]), 1, 100000) : null;
  const highlighted = new Set<number>();
  for (const highlight of rest.matchAll(/(?:^|\s)\{(\d[\d,\s-]*)\}/g)) {
    parseLineSpec(highlight[1]!).forEach((line) => highlighted.add(line));
  }
  const highlightNamed = /(?:^|\s)(?:hl_lines|highlight)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/.exec(rest);
  if (highlightNamed) {
    parseLineSpec(highlightNamed[1] ?? highlightNamed[2] ?? highlightNamed[3] ?? '').forEach((line) => highlighted.add(line));
  }
  return { title, lineNumbers, startLine, highlighted: [...highlighted] };
}

export function parseFenceInfo(source: string): FenceInfo {
  let rest = source.trim();
  let language = '';
  let title = '';
  let hasLineNumbers = false;
  let startLine = 1;
  const highlighted = new Set<number>();
  const leading = parseFenceLeadingOptions(rest);
  if (leading) {
    language = leading.language;
    title = leading.title;
    hasLineNumbers = leading.hasLineNumbers;
    startLine = leading.startLine;
    leading.highlighted.forEach((line) => highlighted.add(line));
    rest = leading.rest;
  }
  if (!language) {
    const lang = /^([^\s{]+)/.exec(rest);
    if (lang) {
      language = lang[1]!.toLowerCase();
      rest = rest.slice(lang[0].length).trim();
    }
  }
  const trailing = parseFenceTrailingOptions(rest, title);
  title = trailing.title;
  if (trailing.lineNumbers === 'disable')
    hasLineNumbers = false;
  else if (trailing.lineNumbers === 'enable')
    hasLineNumbers = true;
  if (trailing.startLine !== null)
    startLine = trailing.startLine;
  trailing.highlighted.forEach((line) => highlighted.add(line));
  return {
    language,
    title,
    lineNumbers: hasLineNumbers,
    startLine,
    highlightedLines: [...highlighted].sort((a, b) => a - b),
  };
}
