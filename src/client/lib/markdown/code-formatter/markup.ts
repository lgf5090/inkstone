import { indentOf } from './types';

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const PRESERVED_TAGS = ['script', 'style', 'pre', 'textarea'];

const PH_HEAD = '«inkstone-raw-';
const PH_TAIL = '»';
const PH_PATTERN = /«inkstone-raw-(\d+)»/g;

function placeholder(index: number): string {
  return PH_HEAD + index + PH_TAIL;
}

function extractRawBlocks(html: string): { masked: string, blocks: string[] } {
  const blocks: string[] = [];
  const tags = PRESERVED_TAGS.join('|');
  const pattern = new RegExp(
    `(<(?:${tags})\\b[^>]*>[\\s\\S]*?<\\/(?:${tags})>|<!--[\\s\\S]*?-->|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|<!DOCTYPE[^>]*>)`,
    'gi',
  );
  const masked = html.replace(pattern, (match) => {
    blocks.push(match);
    return placeholder(blocks.length - 1);
  });
  return { masked, blocks };
}

/**
 * Placeholders come back out in one pass with a function replacer. A string replacement would read `$&` and
 * `$1` inside the restored text as patterns — a script body holding `"$&"` would be rewritten with a copy of
 * the placeholder — and a loop over the blocks would let a literal that *mentions* a later placeholder have
 * it substituted by that later pass.
 */
function restoreRawBlocks(text: string, blocks: string[]): string {
  return text.replace(PH_PATTERN, (match, index: string) => blocks[Number(index)] ?? match);
}

function hasMixedInlineContent(text: string): boolean {
  if (!text.includes('<') || !text.includes('>')) return false;
  if (/<(div|section|article|header|footer|nav|main|aside|table|ul|ol)\b/i.test(text)) return false;
  const root = /^<([a-zA-Z0-9:-]+)[^>]*>([\s\S]*)<\/([a-zA-Z0-9:-]+)>$/.exec(text.trim());
  if (!root || root[1]!.toLowerCase() !== root[3]!.toLowerCase()) return false;
  const inner = root[2]!;
  if (/^<[a-zA-Z0-9:-]+[^>]*>/.test(inner.trim())) return false;
  return /\S+\s*<[a-zA-Z0-9:-]+[^>]*>/.test(inner);
}

function tokenizeTags(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] === '<') {
      const close = text.indexOf('>', i);
      if (close !== -1) {
        const tag = text.slice(i, close + 1).trim();
        if (tag) tokens.push(tag);
        i = close + 1;
        continue;
      }
    }
    const nextOpen = text.indexOf('<', i);
    const end = nextOpen === -1 ? text.length : nextOpen;
    const value = text.slice(i, end).replace(/\s+/g, ' ').trim();
    if (value) tokens.push(value);
    if (nextOpen === -1) break;
    i = nextOpen;
  }

  return tokens;
}

function formatTokenStream(tokens: string[], indent: string, isHtml: boolean): string {
  const lines: string[] = [];
  const stack: string[] = [];
  const pad = (level: number): string => indent.repeat(Math.max(0, level));

  for (const token of tokens) {
    if (token.startsWith('</')) {
      const name = /^<\/([a-zA-Z0-9:-]+)/.exec(token)?.[1]?.toLowerCase() ?? '';
      const matched = stack.lastIndexOf(name);
      if (matched !== -1) {
        stack.length = matched;
        lines.push(`${pad(matched)}${token}`);
      }
      else {
        lines.push(`${pad(stack.length - 1)}${token}`);
      }
      continue;
    }

    if (token.startsWith('<') && !token.startsWith('<!') && !token.startsWith('<?')) {
      const name = /^<([a-zA-Z0-9:-]+)/.exec(token)?.[1]?.toLowerCase() ?? '';
      const isVoid = token.endsWith('/') || (isHtml && VOID_TAGS.has(name));
      lines.push(`${pad(stack.length)}${token}`);
      if (!isVoid) stack.push(name);
      continue;
    }

    lines.push(`${pad(stack.length)}${token}`);
  }

  return lines.join('\n');
}

export function formatMarkup(code: string, tabSize: number, isHtml = true): string {
  const trimmed = code.trim();
  if (!trimmed) return code;

  const { masked, blocks } = extractRawBlocks(trimmed);

  if (!masked.includes('\n') && hasMixedInlineContent(masked)) {
    if (/^<([a-zA-Z0-9:-]+)[^>]*>[\s\S]*<\/([a-zA-Z0-9:-]+)>$/.exec(masked)) return restoreRawBlocks(masked, blocks);
  }

  return restoreRawBlocks(formatTokenStream(tokenizeTags(masked), indentOf(tabSize), isHtml), blocks);
}
