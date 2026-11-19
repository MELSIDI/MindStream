export interface ContainerInsertionResult {
  matched: boolean;
  insertOffset: number;
  deleteLength: number;
  prefixToInsert: string;
  suffixToInsert: string;
}

export function normalizeLineEndings(text: string, eol: '\n' | '\r\n'): string {
  return text.replace(/\r\n|\r|\n/g, eol);
}

function getLineStart(text: string, offset: number): number {
  const prevNl = text.lastIndexOf('\n', Math.max(0, offset - 1));
  return prevNl === -1 ? 0 : prevNl + 1;
}

/**
 * Finds the offset immediately before `anchorText` in `fullText`, normalizing
 * line endings to match the target document.
 */
export function findBeforeAnchorOffset(
  fullText: string,
  anchorText: string,
  eol: '\n' | '\r\n',
): { matched: boolean; insertOffset: number } {
  const normAnchor = normalizeLineEndings(anchorText, eol);
  if (!normAnchor) {
    return { matched: false, insertOffset: fullText.length };
  }
  const idx = fullText.indexOf(normAnchor);
  if (idx === -1) {
    return { matched: false, insertOffset: fullText.length };
  }
  return { matched: true, insertOffset: idx };
}

/**
 * Finds the insertion offset inside a named container (HTML/XML element like
 * `<body>` or brace-delimited construct like `class SnakeGame`, `function render`).
 * Safely expands single-line empty containers (`class Foo { }` or `<body></body>`).
 */
export function findContainerInsertionPoint(
  fullText: string,
  anchorText: string,
  eol: '\n' | '\r\n',
  hasTrailingNewline = false,
): ContainerInsertionResult {
  const trimmed = anchorText.trim();
  if (!trimmed) {
    return {
      matched: false,
      insertOffset: fullText.length,
      deleteLength: 0,
      prefixToInsert: '',
      suffixToInsert: '',
    };
  }

  const htmlMatch = /^<([a-zA-Z][\w:-]*)(?:\s[^>]*)?>$/.exec(trimmed);
  if (htmlMatch) {
    return findHtmlContainerInsertion(
      fullText,
      trimmed,
      htmlMatch[1],
      eol,
      hasTrailingNewline,
    );
  }

  return findBraceContainerInsertion(fullText, trimmed, eol, hasTrailingNewline);
}

function findHtmlContainerInsertion(
  fullText: string,
  normAnchor: string,
  tagName: string,
  eol: '\n' | '\r\n',
  hasTrailingNewline: boolean,
): ContainerInsertionResult {
  let openIdx = fullText.indexOf(normAnchor);
  let openEnd = openIdx !== -1 ? openIdx + normAnchor.length : -1;

  if (openIdx === -1) {
    const fallbackRe = new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*>`, 'i');
    const found = fallbackRe.exec(fullText);
    if (!found) {
      return {
        matched: false,
        insertOffset: fullText.length,
        deleteLength: 0,
        prefixToInsert: '',
        suffixToInsert: '',
      };
    }
    openIdx = found.index;
    openEnd = openIdx + found[0].length;
  }

  // Self-closing tag cannot be entered as a container.
  if (fullText.slice(openIdx, openEnd).trimEnd().endsWith('/>')) {
    return {
      matched: false,
      insertOffset: fullText.length,
      deleteLength: 0,
      prefixToInsert: '',
      suffixToInsert: '',
    };
  }

  const tagRe = new RegExp(`<(\\/)?${escapeRegExp(tagName)}(?:\\s[^>]*)?>`, 'gi');
  tagRe.lastIndex = openEnd;

  let depth = 1;
  let closeIdx = -1;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(fullText)) !== null) {
    const raw = match[0];
    const isClosing = Boolean(match[1]);
    const isSelfClosing = !isClosing && raw.trimEnd().endsWith('/>');
    if (isSelfClosing) {
      continue;
    }
    if (isClosing) {
      depth -= 1;
      if (depth === 0) {
        closeIdx = match.index;
        break;
      }
    } else {
      depth += 1;
    }
  }

  if (closeIdx === -1) {
    return {
      matched: false,
      insertOffset: fullText.length,
      deleteLength: 0,
      prefixToInsert: '',
      suffixToInsert: '',
    };
  }

  const closeLineStart = getLineStart(fullText, closeIdx);
  const leadingOnCloseLine = fullText.slice(closeLineStart, closeIdx);

  if (closeLineStart >= openEnd && /^[ \t]*$/.test(leadingOnCloseLine)) {
    const between = fullText.slice(openEnd, closeLineStart);
    const needsPrefixNl = between.length > 0 && !between.endsWith('\n');
    return {
      matched: true,
      insertOffset: closeLineStart,
      deleteLength: 0,
      prefixToInsert: needsPrefixNl ? eol : '',
      suffixToInsert: '',
    };
  }

  // Single-line container such as <body></body> or <div>text</div>
  const inner = fullText.slice(openEnd, closeIdx);
  if (/^[ \t]*$/.test(inner)) {
    return {
      matched: true,
      insertOffset: openEnd,
      deleteLength: inner.length,
      prefixToInsert: eol,
      suffixToInsert: hasTrailingNewline ? '' : eol,
    };
  }

  return {
    matched: true,
    insertOffset: closeIdx,
    deleteLength: 0,
    prefixToInsert: eol,
    suffixToInsert: hasTrailingNewline ? '' : eol,
  };
}

function findBraceContainerInsertion(
  fullText: string,
  rawAnchor: string,
  eol: '\n' | '\r\n',
  hasTrailingNewline: boolean,
): ContainerInsertionResult {
  const normAnchor = normalizeLineEndings(rawAnchor, eol);
  const anchorIdx = fullText.indexOf(normAnchor);
  if (anchorIdx === -1) {
    return {
      matched: false,
      insertOffset: fullText.length,
      deleteLength: 0,
      prefixToInsert: '',
      suffixToInsert: '',
    };
  }

  const openBraceIdx = findOpeningBrace(fullText, anchorIdx);
  if (openBraceIdx === -1) {
    return {
      matched: false,
      insertOffset: fullText.length,
      deleteLength: 0,
      prefixToInsert: '',
      suffixToInsert: '',
    };
  }

  const closeBraceIdx = findMatchingClosingBrace(fullText, openBraceIdx);
  if (closeBraceIdx === -1) {
    return {
      matched: false,
      insertOffset: fullText.length,
      deleteLength: 0,
      prefixToInsert: '',
      suffixToInsert: '',
    };
  }

  const closeLineStart = getLineStart(fullText, closeBraceIdx);
  const leadingOnCloseLine = fullText.slice(closeLineStart, closeBraceIdx);

  if (closeLineStart > openBraceIdx && /^[ \t]*$/.test(leadingOnCloseLine)) {
    const between = fullText.slice(openBraceIdx + 1, closeLineStart);
    const needsPrefixNl = between.length > 0 && !between.endsWith('\n');
    return {
      matched: true,
      insertOffset: closeLineStart,
      deleteLength: 0,
      prefixToInsert: needsPrefixNl ? eol : '',
      suffixToInsert: '',
    };
  }

  // Single-line container such as `class SnakeGame { }` or `class SnakeGame {}`
  const inner = fullText.slice(openBraceIdx + 1, closeBraceIdx);
  if (/^[ \t]*$/.test(inner)) {
    return {
      matched: true,
      insertOffset: openBraceIdx + 1,
      deleteLength: inner.length,
      prefixToInsert: eol,
      suffixToInsert: hasTrailingNewline ? '' : eol,
    };
  }

  return {
    matched: true,
    insertOffset: closeBraceIdx,
    deleteLength: 0,
    prefixToInsert: eol,
    suffixToInsert: hasTrailingNewline ? '' : eol,
  };
}

function findOpeningBrace(text: string, fromIdx: number): number {
  let i = fromIdx;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') {
      return i;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i = skipLineComment(text, i);
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i = skipBlockComment(text, i);
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipQuotedString(text, i, ch);
      continue;
    }
    if (ch === '`') {
      i = skipTemplateLiteral(text, i);
      continue;
    }
    i += 1;
  }
  return -1;
}

function findMatchingClosingBrace(text: string, openBraceIdx: number): number {
  let depth = 1;
  let i = openBraceIdx + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i = skipLineComment(text, i);
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i = skipBlockComment(text, i);
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipQuotedString(text, i, ch);
      continue;
    }
    if (ch === '`') {
      i = skipTemplateLiteral(text, i);
      continue;
    }
    i += 1;
  }
  return -1;
}

function skipLineComment(text: string, start: number): number {
  const nl = text.indexOf('\n', start + 2);
  return nl === -1 ? text.length : nl + 1;
}

function skipBlockComment(text: string, start: number): number {
  const end = text.indexOf('*/', start + 2);
  return end === -1 ? text.length : end + 2;
}

function skipQuotedString(text: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      return i + 1;
    }
    i += 1;
  }
  return text.length;
}

function skipTemplateLiteral(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      return i + 1;
    }
    if (ch === '$' && text[i + 1] === '{') {
      const exprClose = findMatchingClosingBrace(text, i + 1);
      if (exprClose === -1) {
        return text.length;
      }
      i = exprClose + 1;
      continue;
    }
    i += 1;
  }
  return text.length;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
