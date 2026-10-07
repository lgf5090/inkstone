import { indentOf, padAt } from './types';

const PH_HEAD = '__inkstone_css_';
const PH_TAIL = '__';
const PH_PATTERN = /__inkstone_css_(\d+)__/g;
const MASKED = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/\*[\s\S]*?\*\/|url\([^)]*\))/g;
const ONE_LINE_RULE = /^([^{}]*?)\{\s*([^{}]+?)\s*\}$/;

function maskLiterals(line: string): { masked: string, blocks: string[] } {
  const blocks: string[] = [];
  const masked = line.replace(MASKED, (match) => {
    blocks.push(match);
    return PH_HEAD + (blocks.length - 1) + PH_TAIL;
  });
  return { masked, blocks };
}

function restoreLiterals(line: string, blocks: string[]): string {
  return line.replace(PH_PATTERN, (match, index: string) => blocks[Number(index)] ?? match);
}

function braceDelta(masked: string): number {
  let diff = 0;
  for (const ch of masked) {
    if (ch === '{') diff++;
    else if (ch === '}') diff--;
  }
  return diff;
}

function spaceBeforeBraces(masked: string): string {
  let out = '';
  for (const ch of masked) {
    if (ch === '{') {
      const head = out.trimEnd();
      const prev = head.slice(-1);
      out = prev && prev !== '#' && prev !== '{' ? `${head} {` : `${out}${ch}`;
      continue;
    }
    out += ch;
  }
  return out;
}

function spaceDeclarations(body: string, keepTrailingSemicolon: boolean): string {
  const parts = body.split(';').map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) return body;
  const joined = parts.map((part) => part.replace(/\s*:\s*/, ': ')).join('; ');
  return keepTrailingSemicolon ? `${joined};` : joined;
}

export function formatStyles(code: string, tabSize: number): string {
  const indent = indentOf(tabSize);
  const rawLines = code.split(/\r?\n/);
  const result: string[] = [];
  let depth = 0;
  let inComment = false;

  const pushBlank = (): void => {
    if (result.length > 0 && result[result.length - 1] !== '') result.push('');
  };

  for (const raw of rawLines) {
    const trimmed = raw.trim();

    if (inComment) {
      result.push(raw);
      if (trimmed.includes('*/')) inComment = false;
      continue;
    }

    if (!trimmed) {
      pushBlank();
      continue;
    }

    if (trimmed.startsWith('/*') && !trimmed.includes('*/')) {
      inComment = true;
      result.push(raw);
      continue;
    }

    const { masked, blocks } = maskLiterals(trimmed);
    const rule = ONE_LINE_RULE.exec(masked);

    if (rule) {
      const selector = spaceBeforeBraces(`${rule[1]!.trimEnd()} {`);
      result.push(`${padAt(indent, depth)}${restoreLiterals(selector, blocks)}`);
      const body = spaceDeclarations(rule[2]!.trim(), rule[2]!.trim().endsWith(';'));
      result.push(`${padAt(indent, depth + 1)}${restoreLiterals(body, blocks)}`);
      result.push(`${padAt(indent, depth)}${restoreLiterals('}', blocks)}`);
      continue;
    }

    let processed = masked;
    if (processed.includes(':') && !processed.startsWith('@') && !processed.includes('{') && processed.endsWith(';')) {
      processed = spaceDeclarations(processed, true);
    }
    processed = spaceBeforeBraces(processed);

    const currentIndent = processed.startsWith('}') ? Math.max(0, depth - 1) : depth;
    result.push(`${padAt(indent, currentIndent)}${restoreLiterals(processed, blocks)}`);
    depth = Math.max(0, depth + braceDelta(processed));
  }

  return result.join('\n');
}
