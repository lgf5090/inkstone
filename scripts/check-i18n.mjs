import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { walkSource } from './lib/scratch-files.mjs';
const root = path.resolve('src/client');
const localeRoot = path.resolve('src/shared/locales');
const failures = [];
const usedKeys = new Set();
const forbiddenCjk = /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u;
const visibleAttributes = new Set(['alt', 'aria-label', 'description', 'hint', 'label', 'placeholder', 'title']);
const allowedHanFragments = new Map([
    [path.resolve('README.md'), ['<a href="./README_ZH.md">\u4e2d\u6587</a>']],
    // The OAuth consent page is a self-contained HTML document with its own
    // language switch (cookie-based); it does not use the React i18n layer.
    [path.resolve('src/worker/routes/mcp-authorize.ts'), [
        'AI \u4e0e MCP',
        '\u6388\u6743',
        '\u9700\u8981\u4e24\u6b65\u9a8c\u8bc1\uff1a\u8bf7\u5728 Inkstone \u767b\u5f55\u9875\u5b8c\u6210\u9a8c\u8bc1\u540e\u518d\u56de\u5230\u6b64\u5904',
        '\u5207\u6362\u4e3a\u82f1\u6587',
        'MCP \u5ba2\u6237\u7aef',
        '\u8bf7\u6c42\u8bbf\u95ee',
        '\u5df2\u767b\u5f55\u4e3a ',
        '\u3002\u4ec5\u53ef\u8bbf\u95ee\u6b64\u8d26\u6237\u7684\u7b14\u8bb0\u3002',
        '\u6743\u9650',
        '\u8bfb\u53d6\u4e0e\u641c\u7d22\u7b14\u8bb0',
        '\u5fc5\u9700\u3002\u8fde\u63a5\u7684 AI \u5ba2\u6237\u7aef\u53ea\u4f1a\u6536\u5230\u5de5\u5177\u9009\u4e2d\u7684\u7b14\u8bb0\u5185\u5bb9\u3002',
        '\u8bfb\u53d6\u4e0e\u641c\u7d22\u7b14\u8bb0\u4e3a\u5fc5\u9700\u6743\u9650',
        '\u65b0\u5efa\u4e0e\u7f16\u8f91\u7b14\u8bb0',
        '\u5199\u5165\u64cd\u4f5c\u5305\u542b\u7248\u672c\u6821\u9a8c\u3001\u5e42\u7b49\u952e\uff0c\u5e76\u4f1a\u4fdd\u7559\u7b14\u8bb0\u5386\u53f2\u7248\u672c\u3002',
        '\u79fb\u5165\u56de\u6536\u7ad9',
        '\u4ec5\u8f6f\u5220\u9664\uff1bMCP \u4e0d\u63d0\u4f9b\u6c38\u4e45\u6e05\u9664\u529f\u80fd\u3002',
        '\u9690\u79c1',
        'Cloudflare \u6258\u7ba1\u9759\u6001\u52a0\u5bc6\u7684\u670d\u52a1\u6570\u636e\u3002\u53ea\u6709\u5de5\u5177\u8bfb\u53d6\u7b14\u8bb0\u65f6\uff0c\u5185\u5bb9\u624d\u4f1a\u53d1\u9001\u7ed9 ${clientName}\uff0c\u4e4b\u540e\u7531\u8be5\u5ba2\u6237\u7aef\u7684\u9690\u79c1\u653f\u7b56\u7ea6\u675f\u3002',
        '\u53d6\u6d88',
        '\u5141\u8bb8\u8bbf\u95ee',
        '\u767b\u5f55\u4ee5\u6388\u6743 ${clientName}',
        '\u5bc6\u7801\u53ea\u4f1a\u53d1\u9001\u5230\u5f53\u524d Inkstone \u90e8\u7f72\u3002',
        'Inkstone \u8d26\u6237',
        '\u7528\u6237\u540d',
        '\u5bc6\u7801',
        '\u767b\u5f55\u5e76\u7ee7\u7eed',
        '\u8fd8\u6ca1\u6709\u8d26\u6237\uff1f\u8bf7\u5148\u5728\u53e6\u4e00\u4e2a\u6807\u7b7e\u9875\u6253\u5f00 Inkstone\u3002',
        '\u767b\u5f55\u5931\u8d25',
        '\u6388\u6743\u5931\u8d25',
        '\u6253\u5f00 Inkstone',
        'MCP \u5df2\u5728 Inkstone \u8bbe\u7f6e\u4e2d\u505c\u7528\u3002',
        '\u672a\u77e5\u7684 OAuth \u5ba2\u6237\u7aef\u3002',
        '\u672a\u6ce8\u518c\u5916\u90e8\u5ba2\u6237\u7aef\uff0c\u6765\u6e90\u5730\u5740 ${host}\uff0c\u8bf7\u6838\u5bf9\u540e\u518d\u6388\u6743\u3002',
        'Inkstone \u4f1a\u8bdd\u5df2\u8fc7\u671f\uff0c\u8bf7\u767b\u5f55\u540e\u91cd\u8bd5\u3002',
        '\u4e2d\u6587',
    ]],
    // The scatter table's own column vocabulary, matched against a note's cells and never rendered.
    // See inputVocabularyConstants for the AST half of the same allowance.
    [path.resolve('src/client/lib/markdown/chart/columns.ts'), [
        '\u6a2a\u5750\u6807',
        '\u7eb5\u5750\u6807',
        '\u5927\u5c0f',
        '\u7cfb\u5217',
        '\u5206\u7ec4',
    ]],
    // The demo data that exercises that vocabulary: the same column words plus two group labels, each
    // written once so the first-occurrence replacement below covers the whole file.
    [path.resolve('src/client/lib/markdown/chart/config.test.ts'), [
        '\u6a2a\u5750\u6807',
        '\u7eb5\u5750\u6807',
        '\u5927\u5c0f',
        '\u7cfb\u5217',
        '\u5206\u7ec4',
        '\u7ec4\u4e00',
        '\u7ec4\u4e8c',
    ]],
    // Slice-chart fixtures: the value column word appears in two tables, and the gate's allowance
    // replaces one occurrence per listed fragment, so it is named twice rather than widened.
    [path.resolve('src/client/lib/markdown/enhance-chart.test.ts'), [
        '\u6570\u503c',
        '\u6570\u503c',
        '\u7532',
        '\u4e59',
        '\u4e19',
        '\u4e00',
        '\u4e8c',
    ]],
    // The timeline fixture is the reference project's own demo text, copied verbatim so the
    // space-free `:::timeline` spelling and the Han titles are exercised as authors write them.
    [path.resolve('src/client/lib/markdown/timeline.test.ts'), [
        '\u53d1\u5c55\u5386\u7a0b',
        '\u53d1\u5c55\u5386\u7a0b',
        '\u9879\u76ee\u5f00\u6e90',
        '\u9879\u76ee\u5f00\u6e90',
        '\u6b63\u5f0f\u5f00\u6e90',
    ]],
    // A built-in template tags its notes with a Han label, so the tag merge has to keep a
    // non-ASCII item in a flow list intact. The gate replaces one occurrence per listed
        // fragment, so the tag is named as many times as the fixture spells it.
    // A tag view is the case that matters for the merge, and the built-in catalog tags in Han,
    // so the fixture spells the tag twice: once going in, once coming back out.
    [path.resolve('src/client/store/new-note.test.ts'), [
        '\u6bcf\u65e5',
        '\u6bcf\u65e5',
    ]],
    [path.resolve('src/client/features/templates/gallery-persist.test.ts'), [
        // The separators a Chinese keyboard produces are the thing under test.
        '\uFF0C',
        '\u3001',
    ]],
    [path.resolve('src/shared/note-template-render.test.ts'), [
        '\u6bcf\u65e5',
        '\u6bcf\u65e5',
        '\u6bcf\u65e5',
        '\u5e74\u5ea6\u8ba1\u5212',
        '\u5e74\u5ea6\u8ba1\u5212',
        // YAML-hostile folder names, which only exist in the language users type them in.
        '\u5de5\u4f5c: \u9879\u76ee',
        '\u5de5\u4f5c: \u9879\u76ee',
        '\u5de5\u4f5c: \u9879\u76ee',
        '\u5de5\u4f5c: \u9879\u76ee',
        '\u5de5\u4f5c: \u9879\u76ee',
        '\u5de5\u4f5c: \u9879\u76ee',
        '\u5de5\u4f5c: \u9879\u76ee',
        '\u4e2d\u6587 \u540d\u79f0',
        '\u4e2d\u6587',
        '\u8349\u7a3f',
    ]],
    [path.resolve('src/client/lib/emoji-catalog.test.ts'), [
        // Icon search has to answer in the language the user types it in, so the probe words are Han.
        '\u6587\u4ef6\u5939',
        '\u6587\u4ef6\u5939',
        'plane \u98de\u673a',
        '\u7ea2 \u70b9',
    ]],
    [path.resolve('src/client/editor/text-format.test.ts'), [
        // The width converter is defined by the characters it swaps, so every case is written in the
        // script under test. Each fragment is listed once per place it is spelled.
        '1. buy\uff08a\uff0cb\uff09',
        '\u4f60\u597d\uff0c\u4e16\u754c.',
        '\u4f60\u597d\uff0c\u4e16\u754c\u3002',
        '\uff21\uff11\uff08\uff58\uff09\u3000\uff31',
        '\u7b2c\u4e09\u3002\u3001\u7ae0',
        '\u7b2c\u4e09.,\u7ae0',
        '`\uff0c\u3002` $\uff0c$ %%\uff0c%% [[\uff0c]] [\uff0c](https://ex.com/\uff0c) \uff0c',
        '`\uff0c\u3002` $\uff0c$ %%\uff0c%% [[\uff0c]] [\uff0c](https://ex.com/\uff0c) ,',
    ]],
    // The layout block's fixtures are the reference plugin's own demo line, copied verbatim so the
    // alternate embed spellings and a Han label are exercised the way an author writes them.
    [path.resolve('src/client/lib/markdown/media-layout.test.ts'), ['\u8bbe\u8ba1\u8349\u56fe', '\u8bbe\u8ba1\u8349\u56fe', '\u8bbe\u8ba1\u8349\u56fe']],
    [path.resolve('src/client/lib/markdown/media-block.test.ts'), ['\u8bbe\u8ba1\u8349\u56fe']],
    [path.resolve('src/client/lib/markdown/media-layout-source.test.ts'), ['\u8bbe\u8ba1\u8349\u56fe']],
]);
/**
 * Named constants that hold the vocabulary a note is written *with* rather than the copy a page renders.
 * A chart table's scatter headers name the columns the author chose, and they must mean the same chart
 * whatever language the reader's interface is in, so they cannot come from the locale catalog. Only these
 * constants' own initializers are exempt — a Han literal anywhere else still fails the gate.
 *
 * `CJK_DATE_FIXTURES` is the same argument in a test: a QuickAdd date format and the heading a reader
 * writes with it are note text the ordering rule has to *read*, so a Chinese user's real headings are
 * what the test must feed it. ASCII would prove the rule on a shape nobody has.
 */
const inputVocabularyConstants = new Set(['SCATTER_HEADER_WORDS', 'EMOJI_ICON_CATEGORIES', 'EMOJI_UNICODE_GROUPS', 'PROTECTED_SPANS', 'HALF_TO_FULL', 'FULL_TO_HALF', 'CJK_DATE_FIXTURES']);
// The built-in note template bodies live in their own file so they stay out of the
// start-up locale chunk. The gate reads them as one catalog with the rest, otherwise
// the two languages would be proven against each other only for the keys that happen
// to sit in the main file.
const noteTemplateBodyFiles = {
    en: [path.join(localeRoot, 'en-US-note-template-content.ts'), 'EN_US_NOTE_TEMPLATE_CONTENT'],
    zh: [path.join(localeRoot, 'zh-CN-note-template-content.ts'), 'ZH_CN_NOTE_TEMPLATE_CONTENT'],
};
function readCatalog(variableFile, variableName, [bodyFile, bodyName]) {
    const messages = readMessages(variableFile, variableName);
    for (const [key, value] of readMessages(bodyFile, bodyName)) {
        if (messages.has(key))
            failures.push(`duplicate message across catalog files: ${key}`);
        messages.set(key, value);
    }
    return messages;
}
const english = readCatalog(path.join(localeRoot, 'en-US.ts'), 'EN_US_MESSAGES', noteTemplateBodyFiles.en);
const chinese = readCatalog(path.join(localeRoot, 'zh-CN.ts'), 'ZH_CN_MESSAGES', noteTemplateBodyFiles.zh);
for (const key of english.keys()) {
    if (!chinese.has(key))
        failures.push(`missing zh-CN message: ${key}`);
    if (!/^[a-z][a-z0-9]*(?:\.[a-z0-9_]+)+$/.test(key))
        failures.push(`invalid English message key: ${key}`);
    if (forbiddenCjk.test(key))
        failures.push(`Chinese text used as a message key: ${key}`);
}
for (const key of chinese.keys()) {
    if (!english.has(key))
        failures.push(`missing en-US message: ${key}`);
}
for (const [key, value] of english) {
    if (forbiddenCjk.test(value))
        failures.push(`untranslated en-US message: ${key}`);
    if (placeholders(value) !== placeholders(chinese.get(key) ?? ''))
        failures.push(`placeholder mismatch: ${key}`);
}
const englishOnlyPaths = [
    path.resolve('src'),
    path.resolve('scripts'),
    path.resolve('tests'),
    path.resolve('public'),
    path.resolve('.github'),
];
for (const file of englishOnlyPaths.flatMap((target) => fs.existsSync(target) ? [...walkSource(target)] : [])) {
    if (file === path.join(localeRoot, 'zh-CN.ts') || file === noteTemplateBodyFiles.zh[0] || !isTextSource(file))
        continue;
    rejectHan(file);
}
for (const file of [
    'index.html',
    'package.json',
    'README.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'vite.config.ts',
    'vitest.config.ts',
    'wrangler.toml',
    ...fs.readdirSync(process.cwd()).filter((name) => /^tsconfig.*\.json$/.test(name)),
]) {
    const target = path.resolve(file);
    if (fs.existsSync(target))
        rejectHan(target);
}
for (const file of walkSource(root)) {
    if (!/\.tsx?$/.test(file) || file.includes(`${path.sep}locales${path.sep}`) || file.endsWith(`${path.sep}i18n.ts`))
        continue;
    const sourceText = fs.readFileSync(file, 'utf8');
    const isTestFile = file.includes('.test.');
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    visit(source);
    function visit(node) {
        if (ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 't' &&
            node.arguments[0]) {
            if (!insideFunction(node))
                report(node, 'module-scope t() freezes the initial locale');
            const argument = node.arguments[0];
            if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
                usedKeys.add(argument.text);
                if (!english.has(argument.text))
                    report(argument, `unknown message key ${JSON.stringify(argument.text)}`);
                if (/\p{Script=Han}/u.test(argument.text))
                    report(argument, 'message keys must be English identifiers');
            }
        }
        if (!isTestFile && ts.isJsxText(node) && /[\p{L}\p{N}]/u.test(node.text) && node.text.trim())
            report(node, `unlocalized JSX text ${JSON.stringify(node.text.trim())}`);
        if (!isTestFile && ts.isJsxAttribute(node) && visibleAttributes.has(node.name.text) && node.initializer && ts.isStringLiteral(node.initializer)) {
            const value = node.initializer.text.trim();
            if (value && !isTechnicalPlaceholder(node.name.text, value))
                report(node, `unlocalized ${node.name.text} attribute ${JSON.stringify(value)}`);
        }
        if (!isTestFile &&
            (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) &&
            /\p{Script=Han}/u.test(node.text) &&
            !insideTranslationCall(node) &&
            !insideInputVocabulary(node)) {
            report(node, JSON.stringify(node.text));
        }
        ts.forEachChild(node, visit);
    }
    function report(node, message) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        failures.push(`${path.relative(process.cwd(), file)}:${position.line + 1}:${position.character + 1} ${message}`);
    }
}
if (failures.length) {
    console.error(`i18n validation failed (${failures.length}):`);
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exit(1);
}
console.log(`i18n check passed: ${english.size} English keys with complete en-US and zh-CN resources`);
function placeholders(value) {
    return [...value.matchAll(/\{[A-Za-z0-9_]+\}/g)].map((match) => match[0]).sort().join('|');
}
function isTechnicalPlaceholder(name, value) {
    return name === 'placeholder' && (/^(?:https?:\/\/|[a-z0-9_.-]+\/?$)/i.test(value) || value === '…' || value === '#rrggbb');
}
function isTextSource(file) {
    return /\.(?:css|html|js|jsx|json|md|mjs|svg|toml|ts|tsx)$/.test(file);
}
function rejectHan(file) {
    const source = blankInputVocabulary(file, fs.readFileSync(file, 'utf8'));
    const checked = (allowedHanFragments.get(file) ?? []).reduce((text, fragment) => text.replace(fragment, ' '.repeat(fragment.length)), source);
    const match = forbiddenCjk.exec(checked);
    if (!match)
        return;
    const before = checked.slice(0, match.index);
    const line = before.split(/\r?\n/).length;
    const column = match.index - Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'));
    failures.push(`${path.relative(process.cwd(), file)}:${line}:${column} Chinese text is allowed only in src/shared/locales/zh-CN.ts`);
}
function blankInputVocabulary(file, source) {
    if (![...inputVocabularyConstants].some((name) => source.includes('const ' + name)))
        return source;
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const spans = [];
    const walk = (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && inputVocabularyConstants.has(node.name.text) && node.initializer)
            spans.push([node.initializer.getStart(sourceFile), node.initializer.getEnd()]);
        ts.forEachChild(node, walk);
    };
    walk(sourceFile);
    let text = source;
    for (const [from, to] of spans.sort((a, b) => b[0] - a[0]))
        text = text.slice(0, from) + text.slice(from, to).replace(/[^\n]/g, ' ') + text.slice(to);
    return text;
}
function insideInputVocabulary(node) {
    let current = node.parent;
    while (current && !ts.isSourceFile(current)) {
        if (ts.isVariableDeclaration(current) &&
            ts.isIdentifier(current.name) &&
            inputVocabularyConstants.has(current.name.text))
            return true;
        current = current.parent;
    }
    return false;
}
function insideTranslationCall(node) {
    let current = node;
    while (current.parent && !ts.isStatement(current.parent) && !ts.isJsxElement(current.parent)) {
        const parent = current.parent;
        if (ts.isCallExpression(parent) &&
            ts.isIdentifier(parent.expression) &&
            parent.expression.text === 't' &&
            parent.arguments[0] &&
            contains(parent.arguments[0], node))
            return true;
        current = parent;
    }
    return false;
}
function contains(parent, child) {
    return child.pos >= parent.pos && child.end <= parent.end;
}
function insideFunction(node) {
    let current = node.parent;
    while (current) {
        if (ts.isFunctionLike(current))
            return true;
        if (ts.isSourceFile(current))
            return false;
        current = current.parent;
    }
    return false;
}
function readMessages(file, variableName) {
    const messages = new Map();
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    visit(source);
    return messages;
    function visit(node) {
        if (ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === variableName &&
            node.initializer) {
            const initializer = unwrap(node.initializer);
            if (!ts.isObjectLiteralExpression(initializer))
                return;
            for (const property of initializer.properties) {
                if (ts.isPropertyAssignment(property) &&
                    (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name)) &&
                    ts.isStringLiteralLike(property.initializer))
                    messages.set(property.name.text, property.initializer.text);
            }
        }
        ts.forEachChild(node, visit);
    }
}
function unwrap(node) {
    while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node))
        node = node.expression;
    return node;
}
