import { indentOf } from './types';

const MERMAID_HEADERS = new Set([
  'graph',
  'flowchart',
  'sequencediagram',
  'classdiagram',
  'statediagram',
  'erdiagram',
  'gantt',
  'pie',
  'gitgraph',
  'mindmap',
  'timeline',
  'quadrantchart',
  'xychart',
  'journey',
  'requirementdiagram',
  'sankey',
  'packet',
  'blockdiagram',
  'architecturediagram',
  'routediagram',
  'ishikawa',
  'kanban',
  'treemap',
]);

const MERMAID_BLOCK_OPEN = /^(subgraph|alt|opt|loop|par|critical|rect|menu|task|section|state|column|parallel|case|box)\b/;
const MERMAID_BRANCH = /^(else|and)\b/;
const MERMAID_BRANCH_CLOSE = /^(end\b|\})/;

function firstWord(line: string): string {
  return (line.split(/[\s\n]/)[0] ?? '').toLowerCase().replace(/[;:]$/, '');
}

export function formatMermaid(code: string, tabSize: number): string {
  const indent = indentOf(tabSize);
  const result: string[] = [];
  let depth = 0;

  const pushBlank = (): void => {
    if (result.length > 0 && result[result.length - 1] !== '') result.push('');
  };

  for (const raw of code.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) {
      pushBlank();
      continue;
    }

    if (depth === 0 && MERMAID_HEADERS.has(firstWord(trimmed))) {
      result.push(trimmed);
      depth = 1;
      continue;
    }

    if (trimmed.startsWith('%%')) {
      result.push(`${indent.repeat(Math.max(0, depth))}${trimmed}`);
      continue;
    }

    const isClose = MERMAID_BRANCH_CLOSE.test(trimmed);
    const isBranch = MERMAID_BRANCH.test(trimmed);
    const level = isClose || isBranch ? Math.max(0, depth - 1) : depth;
    result.push(`${indent.repeat(level)}${trimmed}`);

    const opens = isBranch || MERMAID_BLOCK_OPEN.test(trimmed) || /\{\s*$/.test(trimmed);
    if (isClose) depth = Math.max(0, depth - 1);
    else if (opens) depth++;
  }

  return result.join('\n');
}

export function formatDiff(code: string): string {
  return code.split(/\r?\n/).map((line) => line.trimEnd()).join('\n');
}

function isFenceLine(line: string): boolean {
  return /^ {0,3}(`{3,}|~{3,})/.test(line);
}

export function formatMarkdown(code: string): string {
  const result: string[] = [];
  let fence: string | null = null;

  const pushBlank = (): void => {
    if (result.length > 0 && result[result.length - 1] !== '') result.push('');
  };

  for (const raw of code.split(/\r?\n/)) {
    if (fence) {
      result.push(raw);
      if (raw.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    if (isFenceLine(raw)) {
      fence = raw.trimStart().slice(0, 3);
      result.push(raw);
      continue;
    }
    if (!raw.trim()) {
      pushBlank();
      continue;
    }
    result.push(raw.endsWith('  ') ? `${raw.trimEnd()}  ` : raw.trimEnd());
  }

  return result.join('\n');
}

export function formatGeneric(code: string): string {
  const result: string[] = [];

  const pushBlank = (): void => {
    if (result.length > 0 && result[result.length - 1] !== '') result.push('');
  };

  for (const raw of code.split(/\r?\n/)) {
    if (!raw.trim()) pushBlank();
    else result.push(raw.trimEnd());
  }

  return result.join('\n');
}
