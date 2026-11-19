import { describe, expect, it } from 'vitest';
import {
  findBeforeAnchorOffset,
  findContainerInsertionPoint,
  normalizeLineEndings,
} from '../src/editor/ContainerLocator';

function applyContainerEdit(
  text: string,
  anchor: string,
  insertion: string,
  eol: '\n' | '\r\n',
): string {
  const hasTrailingNewline = insertion.endsWith('\n') || insertion.endsWith('\r');
  const res = findContainerInsertionPoint(text, anchor, eol, hasTrailingNewline);
  if (!res.matched) {
    return text + normalizeLineEndings(insertion, eol);
  }
  const normInsertion = normalizeLineEndings(insertion, eol);
  return (
    text.slice(0, res.insertOffset) +
    res.prefixToInsert +
    normInsertion +
    res.suffixToInsert +
    text.slice(res.insertOffset + res.deleteLength)
  );
}

describe('ContainerLocator', () => {
  it('expands a single-line empty class shell `class SnakeGame { }` and inserts cleanly inside', () => {
    const initial = 'export class SnakeGame { }\n';
    const withField = applyContainerEdit(
      initial,
      'class SnakeGame',
      '  private score = 0;\n',
      '\n',
    );

    expect(withField).toBe(
      ['export class SnakeGame {', '  private score = 0;', '}', ''].join('\n'),
    );

    const withMethod = applyContainerEdit(
      withField,
      'class SnakeGame',
      '  public reset() {\n    this.score = 0;\n  }\n',
      '\n',
    );

    expect(withMethod).toBe(
      [
        'export class SnakeGame {',
        '  private score = 0;',
        '  public reset() {',
        '    this.score = 0;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('ignores braces inside strings, comments, and template literals when locating class end', () => {
    const initial = [
      'class Parser {',
      '  // comment with stray }',
      '  private braceStr = "}";',
      '  private tpl = `val=${({ a: 1 }).a}}`;',
      '}',
      '',
    ].join('\n');

    const updated = applyContainerEdit(
      initial,
      'class Parser',
      '  parse() { return true; }\n',
      '\n',
    );

    expect(updated).toBe(
      [
        'class Parser {',
        '  // comment with stray }',
        '  private braceStr = "}";',
        '  private tpl = `val=${({ a: 1 }).a}}`;',
        '  parse() { return true; }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('handles single-line and nested multi-line HTML tags under CRLF line endings', () => {
    const htmlSingle = '<!DOCTYPE html>\r\n<html>\r\n<body></body>\r\n</html>\r\n';
    const withMain = applyContainerEdit(
      htmlSingle,
      '<body>',
      '  <main><div id="app"></div></main>\r\n',
      '\r\n',
    );

    expect(withMain).toBe(
      [
        '<!DOCTYPE html>',
        '<html>',
        '<body>',
        '  <main><div id="app"></div></main>',
        '</body>',
        '</html>',
        '',
      ].join('\r\n'),
    );

    const withFooter = applyContainerEdit(
      withMain,
      '<body>',
      '  <footer>Ready</footer>\r\n',
      '\r\n',
    );

    expect(withFooter).toBe(
      [
        '<!DOCTYPE html>',
        '<html>',
        '<body>',
        '  <main><div id="app"></div></main>',
        '  <footer>Ready</footer>',
        '</body>',
        '</html>',
        '',
      ].join('\r\n'),
    );
  });

  it('locates insert-before anchors accurately in CRLF documents', () => {
    const text = 'const a = 1;\r\nfunction run() {}\r\n';
    const res = findBeforeAnchorOffset(text, 'function run()', '\r\n');
    expect(res.matched).toBe(true);
    expect(text.slice(0, res.insertOffset) + 'const b = 2;\r\n' + text.slice(res.insertOffset)).toBe(
      'const a = 1;\r\nconst b = 2;\r\nfunction run() {}\r\n',
    );
  });
});
