import { describe, expect, it } from 'vitest';
import { formatCode, formatCodeResult } from './code-formatter';

describe('formatCode - data formats', () => {
  it('formats JSON with proper indentation', () => {
    const raw = '{"a":1,"b":[2,3],"c":{"d":true}}';
    expect(formatCode(raw, 'json')).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ],\n  "c": {\n    "d": true\n  }\n}');
  });

  it('keeps empty containers on one line', () => {
    expect(formatCode('{"a":{},"b":[],"c":[1]}', 'json')).toBe('{\n  "a": {},\n  "b": [],\n  "c": [\n    1\n  ]\n}');
  });

  it('preserves number literals that JSON.parse would rewrite', () => {
    const raw = '{"big":12345678901234567890,"one":1.0,"exp":1e10,"neg":0}';
    const formatted = formatCode(raw, 'json');
    expect(formatted).toContain('"big": 12345678901234567890');
    expect(formatted).toContain('"one": 1.0');
    expect(formatted).toContain('"exp": 1e10');
  });

  it('keeps a URL inside a JSON string when the document also carries a comment', () => {
    const raw = '{\n  // seen\n  "url": "https://example.com/a"\n}';
    const formatted = formatCode(raw, 'jsonc');
    expect(formatted).toContain('"url": "https://example.com/a"');
    expect(formatted).toContain('// seen');
  });

  it('leaves a document that is not JSON alone', () => {
    const raw = 'just some prose with a trailing }';
    expect(formatCode(raw, 'json')).toBe(raw);
  });

  it('formats YAML code preserving document structure', () => {
    const code = 'name: inkstone\nversion: 1\nfeatures:\n  - markdown\n  - diagrams';
    const formatted = formatCode(code, 'yaml');
    expect(formatted).toContain('name: inkstone');
    expect(formatted).toContain('features:');
    expect(formatted).toContain('  - markdown');
  });

  it('keeps YAML comments and the scalar text a value round-trip would lose', () => {
    const code = '# lead\nversion: 1.0\nname: inkstone';
    const formatted = formatCode(code, 'yaml');
    expect(formatted).toContain('# lead');
    expect(formatted).toContain('version: 1.0');
  });

  it('formats TOML code with spaced key-value pairs', () => {
    const code = '[package]\nname="inkstone"\nversion="0.8.0"';
    expect(formatCode(code, 'toml')).toBe('[package]\nname = "inkstone"\nversion = "0.8.0"');
  });

  it('keeps a multi-line TOML array together', () => {
    const code = 'keywords = [\n  "a",\n  "b"\n]';
    expect(formatCode(code, 'toml')).toBe('keywords = [\n"a",\n"b"\n]');
  });
});

describe('formatCode - markup and styles', () => {
  it('formats HTML with proper hierarchy', () => {
    const raw = '<div><p><span>Hello</span></p></div>';
    expect(formatCode(raw, 'html')).toBe('<div>\n  <p>\n    <span>\n      Hello\n    </span>\n  </p>\n</div>');
  });

  it('restores a masked script block without treating $& as a pattern', () => {
    const raw = '<div><script>var x = "$&$1";</script></div>';
    const formatted = formatCode(raw, 'html');
    expect(formatted).toContain('var x = "$&$1";');
  });

  it('keeps a pre block byte for byte', () => {
    const raw = '<div>\n<pre>\n  keep   this\n</pre>\n</div>';
    expect(formatCode(raw, 'html')).toContain('<pre>\n  keep   this\n</pre>');
  });

  it('does not indent past an unmatched closing tag', () => {
    const raw = '<div>\n</span>\n<p>x</p>\n</div>';
    const formatted = formatCode(raw, 'html');
    expect(formatted).toBe('<div>\n</span>\n  <p>\n    x\n  </p>\n</div>');
  });

  it('formats SQL with uppercase keywords and line breaks', () => {
    const raw = 'select id, name from users where age > 18 order by created_at desc';
    const formatted = formatCode(raw, 'sql');
    expect(formatted).toContain('SELECT id, name');
    expect(formatted).toContain('\nFROM users');
    expect(formatted).toContain('\nWHERE age > 18');
    expect(formatted).toContain('\nORDER BY created_at');
  });

  it('keeps a LEFT OUTER JOIN on one line', () => {
    const raw = 'select * from a left outer join b on a.id = b.id';
    const formatted = formatCode(raw, 'sql');
    expect(formatted).toContain('LEFT OUTER JOIN b');
    expect(formatted).not.toContain('LEFT\n');
  });

  it('honours the keyword case setting', () => {
    const raw = 'select id from t';
    expect(formatCode(raw, 'sql', 2, 'lower')).toContain('select id\nfrom t');
    expect(formatCode(raw, 'sql', 2, 'keep')).toContain('select id\nfrom t');
  });

  it('protects dotted identifiers and keywords in SQL', () => {
    const code = 'SELECT users.offset, users.set FROM users WHERE id = 1';
    expect(formatCode(code, 'sql')).toBe('SELECT users.offset, users.set\nFROM users\nWHERE id = 1');
  });

  it('restores a SQL literal holding a replacement pattern', () => {
    const code = "SELECT name FROM t WHERE name = 'a$&b'";
    expect(formatCode(code, 'sql')).toContain("'a$&b'");
  });

  it('formats CSS with indented rules and spaced properties', () => {
    const code = '.box{\ncolor:red;\nbackground:#fff;\n}';
    expect(formatCode(code, 'css')).toBe('.box {\n  color: red;\n  background: #fff;\n}');
  });

  it('spaces several declarations on one CSS line', () => {
    expect(formatCode('.a{color:red;background:blue;}', 'css')).toBe('.a {\n  color: red; background: blue;\n}');
  });

  it('leaves SCSS interpolation intact', () => {
    const code = '#{$name} {\ncolor: red;\n}';
    expect(formatCode(code, 'scss')).toBe('#{$name} {\n  color: red;\n}');
  });

  it('keeps a multi-line CSS comment verbatim', () => {
    const code = '/* one\n   two */\n.a{color:red;}';
    const formatted = formatCode(code, 'css');
    expect(formatted).toContain('/* one\n   two */');
    expect(formatted).toContain('  color: red;');
  });
});

describe('formatCode - declarations and corrupted paste', () => {
  it('formats corrupted single-line JavaScript/TypeScript from paste', () => {
    const compressed = `export function fuzzyMatch(text: string, query: string): FuzzyMatch | null { 
  if (!query) return { score: 0, ranges: [] }
  const haystack = text.toLowerCase() 
  const needle = query.toLowerCase().trim() 
  if (!needle) return { score: 0, ranges: [] }

  const direct = haystack.indexOf(needle) 
  if (direct >= 0) { 
    let score = 1000 - direct * 2 
    if (direct === 0) score += 300 
    else if (isBoundary(haystack, direct)) 
    score += 150 score += Math.max(0, 120 - text.length) return { score, ranges: [[direct, direct + needle.length]] 
  } 
}`;

    const formatted = formatCode(compressed, 'javascript');
    expect(formatted).toContain('score += 150');
    expect(formatted).toContain('score += Math.max(0, 120 - text.length)');
    expect(formatted).toContain('return { score, ranges: [[direct, direct + needle.length]]');
    expect(formatted.includes('score += 150 score += Math.max')).toBe(false);
  });

  it('does not split const or let declarations onto separate lines in tsx/ts', () => {
    const code = `const name = 'Inkstone'\nconst age=45\nconsole.log(\`Hello, \${name}!\`)`;
    expect(formatCode(code, 'tsx')).toBe(`const name = 'Inkstone'\nconst age = 45\nconsole.log(\`Hello, \${name}!\`)`);
  });

  it('formats code when language parameter includes fence attributes or colons', () => {
    const code = `const name = 'Inkstone'\nconst age=45\nconsole.log(\`Hello, \${name}!\`)`;
    expect(formatCode(code, 'ts title="hello.ts" line-numbers {2}')).toContain('const age = 45');
    expect(formatCode(code, 'ts:hello.ts')).toContain('const age = 45');
    expect(formatCode(code, 'ts[hello.ts]')).toContain('const age = 45');
    expect(formatCode(code, '.ts')).toContain('const age = 45');
  });
});

describe('formatCode - tsx and systems code', () => {
  it('formats TSX elements and properties properly', () => {
    const code = 'export function Card() {\nreturn <div className="card"><span>Inkstone</span></div>\n}';
    const formatted = formatCode(code, 'tsx');
    expect(formatted).toContain('export function Card() {');
    expect(formatted).toContain('return <div className="card"><span>Inkstone</span></div>');
    expect(formatted).toContain('}');
  });

  it('puts a space between a closing bracket and the brace it opens', () => {
    const code = 'function f(){\nif(a){\nreturn 1\n}\nelse{return 2}\n}';
    expect(formatCode(code, 'javascript')).toBe('function f() {\n  if (a) {\n    return 1\n  }\n  else { return 2 }\n}');
  });

  it('formats Go and Rust code with brace indentation', () => {
    const goCode = 'package main\n\nfunc main() {\nfmt.Println("hello")\n}';
    expect(formatCode(goCode, 'go')).toContain('func main() {');
    expect(formatCode(goCode, 'go')).toContain('  fmt.Println("hello")');

    const rustCode = 'fn main() {\nlet mut count = 0;\ncount += 1;\n}';
    const formattedRust = formatCode(rustCode, 'rust');
    expect(formattedRust).toContain('fn main() {');
    expect(formattedRust).toContain('  let mut count = 0;');
    expect(formattedRust).toContain('  count += 1;');
  });

  it('formats TypeScript generics without breaking on angle brackets', () => {
    const code = 'const map = new Map<string, number>()\nconst isValid = a < b && c > d';
    const formatted = formatCode(code, 'typescript');
    expect(formatted).toContain('const map = new Map<string, number>()');
    expect(formatted).toContain('const isValid = a < b && c > d');
  });

  it('formats C++ stream operators and namespace delimiters', () => {
    const code = 'std::cout << "hello" << std::endl;';
    expect(formatCode(code, 'cpp')).toContain('std::cout << "hello" << std::endl;');
  });

  it('does not mistake a regex for a block comment', () => {
    const code = 'const re = /\\*star\\*/\nconst after = 1';
    const formatted = formatCode(code, 'javascript');
    expect(formatted).toContain('const after = 1');
    expect(formatted).not.toContain('/*');
  });

  it('keeps division out of comment state', () => {
    const code = 'const half = total/2\nfunction f() {\nreturn 1\n}';
    const formatted = formatCode(code, 'javascript');
    expect(formatted).toContain('  return 1');
  });
});

describe('formatCode - python and shell scripts', () => {
  it('formats Python code with indentation and operator spacing', () => {
    const code = 'def calculate(a,b):\nif a>b:\nreturn a\nelse:\nreturn b';
    expect(formatCode(code, 'python')).toBe('def calculate(a, b):\n  if a > b:\n    return a\n  else:\n    return b');
  });

  it('does not corrupt python multiline dictionaries', () => {
    const code = 'config = {\n    "host": "localhost",\n    "port": 8080\n}';
    expect(formatCode(code, 'python')).toContain('  "host": "localhost"');
    expect(formatCode(code, 'python')).toContain('  "port": 8080');
    expect(formatCode(code, 'python', 4)).toContain('    "host": "localhost"');
  });

  it('keeps the text of a triple-quoted string that opens mid-line', () => {
    const code = 'msg = """\nhello   world\n"""\nx=1';
    const formatted = formatCode(code, 'python');
    expect(formatted).toContain('hello   world');
    expect(formatted).toContain('x = 1');
  });

  it('formats Shell scripts with indented control flow', () => {
    const code = 'if [ "$flag" = "true" ]; then\necho "enabled"\nelse\necho "disabled"\nfi';
    expect(formatCode(code, 'bash')).toBe('if [ "$flag" = "true" ]; then\n  echo "enabled"\nelse\n  echo "disabled"\nfi');
  });

  it('does not increase shell indentation on echo "do"', () => {
    const code = 'echo "do"\necho "indented?"';
    expect(formatCode(code, 'bash')).toBe('echo "do"\necho "indented?"');
  });

  it('keeps a heredoc body verbatim', () => {
    const code = 'cat <<EOF\n    kept   as-is\n  EOF\nafter=1';
    const formatted = formatCode(code, 'bash');
    expect(formatted).toContain('    kept   as-is');
  });
});

describe('formatCode - lua and ruby scripts', () => {
  it('formats Lua functions and blocks', () => {
    const code = 'function greet(name)\nif name then\nprint("hi")\nend\nend';
    expect(formatCode(code, 'lua')).toBe('function greet(name)\n  if name then\n    print("hi")\n  end\nend');
  });

  it('indents a local function body', () => {
    const code = 'local function f()\nprint(1)\nend';
    expect(formatCode(code, 'lua')).toBe('local function f()\n  print(1)\nend');
  });

  it('keeps a Lua one-liner at the surrounding depth', () => {
    const code = 'local function f()\nif x then return 1 end\nprint(2)\nend';
    expect(formatCode(code, 'lua')).toBe('local function f()\n  if x then return 1 end\n  print(2)\nend');
  });

  it('formats Ruby definitions and blocks', () => {
    const code = 'def greet(name)\nif name\nputs "hi"\nend\nend';
    expect(formatCode(code, 'ruby')).toBe('def greet(name)\n  if name\n    puts "hi"\n  end\nend');
  });
});

describe('formatCode - docker, diagrams and diffs', () => {
  it('formats Dockerfile instructions into uppercase', () => {
    const code = 'from node:20-alpine\nworkdir /app\ncopy . .\nrun npm install';
    expect(formatCode(code, 'dockerfile')).toBe('FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN npm install');
  });

  it('does not uppercase a continuation line that reads like an instruction', () => {
    const code = 'RUN echo \\\ncopy \\ done';
    expect(formatCode(code, 'dockerfile')).toBe('RUN echo \\\ncopy \\ done');
  });

  it('formats Mermaid diagrams with block indentation', () => {
    const code = 'graph TD\nsubgraph Core\nA --> B\nend';
    expect(formatCode(code, 'mermaid')).toBe('graph TD\n  subgraph Core\n    A --> B\n  end');
  });

  it('indents a sequence-diagram loop body', () => {
    const code = 'sequenceDiagram\nAlice->>Bob: hi\nloop every day\nBob->>Alice: ok\nend';
    expect(formatCode(code, 'mermaid')).toBe('sequenceDiagram\n  Alice->>Bob: hi\n  loop every day\n    Bob->>Alice: ok\n  end');
  });

  it('preserves unified diff markers without alteration', () => {
    const code = '--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n-old line\n+new line\n context';
    expect(formatCode(code, 'diff')).toBe(code);
  });

  it('handles empty or whitespace strings gracefully', () => {
    expect(formatCode('', 'typescript')).toBe('');
    expect(formatCode('   \n  \n  ', 'typescript')).toBe('   \n  \n  ');
  });
});

describe('formatCode - string literals and multiline preservation', () => {
  it('preserves spaces inside string literals in tsx/ts', () => {
    expect(formatCode('const text = "Hello       world"', 'typescript')).toBe('const text = "Hello       world"');
  });

  it('preserves multiline template literals in tsx/ts', () => {
    const code = 'const query = `\n  SELECT *\n  FROM users\n  WHERE id = 1\n`';
    expect(formatCode(code, 'typescript')).toBe(code);
  });

  it('does not statement-split a line inside a template literal', () => {
    const code = 'const t = `\n1 return 2\n`';
    expect(formatCode(code, 'typescript')).toBe('const t = `\n1 return 2\n`');
  });

  it('preserves inline html elements and does not break on script tags', () => {
    const code = '<p>Hello <b>world</b> and <i>everyone</i>!</p>';
    expect(formatCode(code, 'html')).toBe('<p>Hello <b>world</b> and <i>everyone</i>!</p>');

    const scriptCode = '<script>\n  if (a < b && c > d) {\n    console.log("yes")\n  }\n</script>';
    expect(formatCode(scriptCode, 'html')).toBe(scriptCode);
  });
});

describe('formatCode - block languages and fallbacks', () => {
  it('formats mindmap and slides blocks gracefully', () => {
    const mindmapCode = '# Central Topic\n## Subtopic 1\n## Subtopic 2';
    expect(formatCode(mindmapCode, 'mindmap')).toBe(mindmapCode);
    const slidesCode = '# Slide 1\nContent 1\n---\n# Slide 2\nContent 2';
    expect(formatCode(slidesCode, 'bento-slides')).toBe(slidesCode);
  });

  it('formats a kanban JSON board body as JSON', () => {
    const code = '{"columns":[{"id":"a","cards":[{"title":"T"}]}]}';
    expect(formatCode(code, 'kanban')).toContain('  "columns": [');
  });

  it('aligns a chart table body instead of running the C formatter over it', () => {
    const code = '| :bar: | Month | Count |\n| --- | --- | --- |\n| 1 | January | 3 |';
    const formatted = formatCode(code, 'chart');
    expect(formatted.split('\n')[0]).toBe('| :bar: | Month   | Count |');
  });

  it('formats a JSON chart config', () => {
    expect(formatCode('{"type":"bar","data":{}}', 'chart')).toBe('{\n  "type": "bar",\n  "data": {}\n}');
  });

  it('collapses runs of blank lines for an unknown language', () => {
    expect(formatCode('a\n\n\n\nb', 'brainfuck')).toBe('a\n\nb');
  });
});

describe('formatCodeResult - reporting and guards', () => {
  it('reports an unchanged body rather than pretending it formatted', () => {
    const result = formatCodeResult('const a = 1', 'javascript', { tabSize: 2 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unchanged');
  });

  it('refuses a body past the ceiling without touching it', () => {
    const huge = `{"a":"${'x'.repeat(600 * 1024)}"}`;
    const result = formatCodeResult(huge, 'json', { tabSize: 2 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('too-large');
    expect(result.text).toBe(huge);
  });

  it('never lets a formatter throw past the boundary', () => {
    const result = formatCodeResult('{"a":1', 'json', { tabSize: Number.NaN });
    expect(result.text).toBe('{"a":1');
  });

  it('honours a tab size beyond the clamp instead of repeating forever', () => {
    expect(formatCode('{"a":{"b":1}}', 'json', 99)).toBe('{\n        "a": {\n                "b": 1\n        }\n}');
  });
});
