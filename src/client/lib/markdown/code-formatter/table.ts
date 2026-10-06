type Alignment = 'left' | 'right' | 'center' | 'none';

function splitRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);

  for (const ch of body) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function isTableLine(line: string): boolean {
  return line.trim().includes('|');
}

function delimiterAlignment(cell: string): Alignment | null {
  const match = /^(:?)-{1,}(:?)$/.exec(cell.trim());
  if (!match) return null;
  if (match[1] && match[2]) return 'center';
  if (match[1]) return 'left';
  if (match[2]) return 'right';
  return 'none';
}

function isDelimiterRow(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => delimiterAlignment(cell) !== null);
}

function delimiterCell(alignment: Alignment, width: number): string {
  const dashes = '-'.repeat(Math.max(3, width));
  if (alignment === 'center') return `:${dashes}:`;
  if (alignment === 'left') return `:${dashes}`;
  if (alignment === 'right') return `${dashes}:`;
  return dashes;
}

function padCell(cell: string, width: number, alignment: Alignment): string {
  const slack = Math.max(0, width - cell.length);
  if (alignment === 'right') return ' '.repeat(slack) + cell;
  if (alignment === 'center') {
    const left = Math.floor(slack / 2);
    return ' '.repeat(left) + cell + ' '.repeat(slack - left);
  }
  return cell + ' '.repeat(slack);
}

function alignBlock(block: string[]): string[] {
  const rows = block.map(splitRow);
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }

  const alignments: Alignment[] = (rows[1] ?? []).map((cell) => delimiterAlignment(cell) ?? 'none');

  return rows.map((row, rowIndex) => {
    const cells = row.map((cell, index) => {
      const width = widths[index] ?? cell.length;
      const alignment = alignments[index] ?? 'none';
      return rowIndex === 1 ? delimiterCell(alignment, width) : padCell(cell, width, alignment);
    });
    return `| ${cells.join(' | ')} |`;
  });
}

export function formatTable(code: string): string {
  const lines = code.split(/\r?\n/);
  const result: string[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!isTableLine(lines[index]!)) {
      result.push(lines[index]!.trimEnd());
      index++;
      continue;
    }
    let end = index;
    while (end < lines.length && isTableLine(lines[end]!)) end++;
    const block = lines.slice(index, end);
    result.push(...(block.length >= 2 && isDelimiterRow(block[1]!) ? alignBlock(block) : block.map((line) => line.trimEnd())));
    index = end;
  }

  return result.join('\n');
}
