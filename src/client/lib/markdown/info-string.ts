export function infoTokens(info: string): string[] {
  const trimmed = info.trim();
  const leading = /^(\{[^{}]*\})\s*/.exec(trimmed);
  if (!leading) return trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const rest = trimmed.slice(leading[0].length);
  return [leading[1]!, ...(rest.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [])];
}

export function isBraceGroup(token: string): boolean {
  return token.startsWith('{') && token.endsWith('}');
}

export function braceTokens(token: string): string[] {
  return isBraceGroup(token)
    ? token.slice(1, -1).trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
    : [];
}

export function infoOption(token: string): { key: string; value: string } | null {
  const clean = token.replace(/^["']|["']$/g, '').trim();
  const separator = clean.indexOf('=');
  if (separator === -1) return null;
  return {
    key: clean.slice(0, separator).toLowerCase().trim(),
    value: clean.slice(separator + 1).trim().replace(/^["']|["']$/g, ''),
  };
}

export function infoFlag(token: string): string {
  return token.replace(/^["']|["']$/g, '').replace(/^\./, '').toLowerCase().trim();
}
