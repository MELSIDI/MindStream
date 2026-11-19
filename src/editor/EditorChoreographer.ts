import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  AppendChunkOptions,
  AppendChunkResult,
  IEditorAdapter,
} from '../engine/PlaybackEngine';
import { PlaybackState } from '../types/session';
import {
  findBeforeAnchorOffset,
  findContainerInsertionPoint,
  normalizeLineEndings,
} from './ContainerLocator';
import { EditorDecorator } from './EditorDecorator';

export class EditorChoreographer implements IEditorAdapter, vscode.Disposable {
  private readonly sessionUris = new Map<string, vscode.Uri>();
  private readonly fileOffsets = new Map<string, number>();
  private readonly initializedFiles = new Set<string>();
  private clearExistingOnFirstOpen = false;
  private editQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly decorator: EditorDecorator) {}

  public resetSession(clearExistingOnFirstOpen: boolean): void {
    this.sessionUris.clear();
    this.fileOffsets.clear();
    this.initializedFiles.clear();
    this.clearExistingOnFirstOpen = clearExistingOnFirstOpen;
    this.decorator.clearAll();
  }

  public resolveFileUri(
    filePath: string,
    rootSubdir: string,
    workspaceRoot?: string,
  ): vscode.Uri {
    if (path.isAbsolute(filePath)) {
      return vscode.Uri.file(filePath);
    }

    const cleanSegments = filePath
      .replace(/\\/g, '/')
      .split('/')
      .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..');

    const rootSegments = rootSubdir
      .replace(/\\/g, '/')
      .split('/')
      .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..');

    if (workspaceRoot && workspaceRoot.trim().length > 0) {
      return vscode.Uri.file(path.join(workspaceRoot, ...rootSegments, ...cleanSegments));
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      return vscode.Uri.joinPath(workspaceFolder.uri, ...rootSegments, ...cleanSegments);
    }

    const fallbackBase = path.join(os.tmpdir(), 'mindstream-workspace', ...rootSegments);
    return vscode.Uri.file(path.join(fallbackBase, ...cleanSegments));
  }

  public async openFile(
    filePath: string,
    _languageId: string,
    rootSubdir: string,
    workspaceRoot?: string,
  ): Promise<void> {
    return this.enqueue(async () => {
      const uri =
        this.sessionUris.get(filePath) ??
        this.resolveFileUri(filePath, rootSubdir, workspaceRoot);
      this.sessionUris.set(filePath, uri);

      await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });

      const firstTimeInSession = !this.initializedFiles.has(filePath);
      if (firstTimeInSession) {
        this.initializedFiles.add(filePath);

        let fileExists = false;
        try {
          await fs.access(uri.fsPath);
          fileExists = true;
        } catch {
          fileExists = false;
        }

        if (!fileExists) {
          await fs.writeFile(uri.fsPath, '', 'utf8');
          this.fileOffsets.set(filePath, 0);
        } else if (this.clearExistingOnFirstOpen) {
          await fs.writeFile(uri.fsPath, '', 'utf8');
          this.fileOffsets.set(filePath, 0);
        }
      }

      const doc = await vscode.workspace.openTextDocument(uri);
      if (firstTimeInSession && !this.fileOffsets.has(filePath)) {
        const initialLen = doc.getText().length;
        this.fileOffsets.set(filePath, initialLen);
        if (initialLen > 0 && !doc.getText().endsWith('\n')) {
          const editor = await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.One,
            preserveFocus: true,
          });
          const eol = this.getDocEol(editor.document);
          await editor.edit(
            (eb) => eb.insert(doc.positionAt(initialLen), eol + eol),
            { undoStopBefore: false, undoStopAfter: false },
          );
          this.fileOffsets.set(filePath, editor.document.getText().length);
          return;
        }
      }

      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: true,
        preview: false,
      });
    });
  }

  public async prepareEditTarget(
    filePath: string,
    insertMode:
      | 'append'
      | 'replace-file'
      | 'replace-target'
      | 'insert-before'
      | 'inside-container',
    targetOrAnchorText?: string,
    hasTrailingNewline = false,
  ): Promise<{ matched: boolean }> {
    return this.enqueue(async () => {
      const editor = await this.ensureEditorForFile(filePath);
      const doc = editor.document;
      const fullText = doc.getText();
      const eol = this.getDocEol(doc);

      if (insertMode === 'append') {
        this.fileOffsets.set(filePath, fullText.length);
        return { matched: true };
      }

      if (insertMode === 'replace-file') {
        if (fullText.length > 0) {
          const fullRange = new vscode.Range(
            doc.positionAt(0),
            doc.positionAt(fullText.length),
          );
          await editor.edit((eb) => eb.delete(fullRange), {
            undoStopBefore: true,
            undoStopAfter: false,
          });
        }
        this.fileOffsets.set(filePath, 0);
        return { matched: true };
      }

      if (insertMode === 'replace-target') {
        if (!targetOrAnchorText) {
          this.fileOffsets.set(filePath, fullText.length);
          return { matched: false };
        }

        const normTarget = normalizeLineEndings(targetOrAnchorText, eol);
        const idx = fullText.indexOf(normTarget);
        if (idx === -1) {
          this.fileOffsets.set(filePath, fullText.length);
          return { matched: false };
        }

        const startPos = doc.positionAt(idx);
        const endPos = doc.positionAt(idx + normTarget.length);
        await editor.edit((eb) => eb.delete(new vscode.Range(startPos, endPos)), {
          undoStopBefore: true,
          undoStopAfter: false,
        });
        this.fileOffsets.set(filePath, idx);
        return { matched: true };
      }

      if (insertMode === 'insert-before') {
        const res = findBeforeAnchorOffset(fullText, targetOrAnchorText ?? '', eol);
        this.fileOffsets.set(filePath, res.insertOffset);
        return { matched: res.matched };
      }

      // inside-container
      const container = findContainerInsertionPoint(
        fullText,
        targetOrAnchorText ?? '',
        eol,
        hasTrailingNewline,
      );
      if (!container.matched) {
        this.fileOffsets.set(filePath, fullText.length);
        return { matched: false };
      }

      if (
        container.deleteLength > 0 ||
        container.prefixToInsert.length > 0 ||
        container.suffixToInsert.length > 0
      ) {
        const startPos = doc.positionAt(container.insertOffset);
        const endPos = doc.positionAt(container.insertOffset + container.deleteLength);
        await editor.edit(
          (eb) =>
            eb.replace(
              new vscode.Range(startPos, endPos),
              container.prefixToInsert + container.suffixToInsert,
            ),
          { undoStopBefore: true, undoStopAfter: false },
        );
        this.fileOffsets.set(
          filePath,
          container.insertOffset + container.prefixToInsert.length,
        );
      } else {
        this.fileOffsets.set(filePath, container.insertOffset);
      }
      return { matched: true };
    });
  }

  public async appendChunk(
    filePath: string,
    chunk: string,
    options: AppendChunkOptions,
  ): Promise<AppendChunkResult> {
    return this.enqueue(async () => {
      const editor = await this.ensureEditorForFile(filePath);
      const doc = editor.document;
      const eol = this.getDocEol(doc);
      const normalizedChunk = normalizeLineEndings(chunk, eol);

      let activeBeforeLen = doc.getText().length;
      const trackedOffset = this.fileOffsets.get(filePath) ?? activeBeforeLen;
      let activeInsertOffset = Math.min(Math.max(0, trackedOffset), activeBeforeLen);

      if (normalizedChunk.length > 0) {
        let applied = await editor.edit(
          (editBuilder) => {
            editBuilder.insert(
              editor.document.positionAt(activeInsertOffset),
              normalizedChunk,
            );
          },
          {
            undoStopBefore: options.isBlockStart,
            undoStopAfter: options.isBlockEnd,
          },
        );

        if (!applied) {
          activeBeforeLen = editor.document.getText().length;
          activeInsertOffset = Math.min(Math.max(0, trackedOffset), activeBeforeLen);
          applied = await editor.edit(
            (editBuilder) => {
              editBuilder.insert(
                editor.document.positionAt(activeInsertOffset),
                normalizedChunk,
              );
            },
            {
              undoStopBefore: options.isBlockStart,
              undoStopAfter: options.isBlockEnd,
            },
          );
        }

        if (applied) {
          const afterLen = editor.document.getText().length;
          const actualDelta = Math.max(0, afterLen - activeBeforeLen);
          this.fileOffsets.set(filePath, activeInsertOffset + actualDelta);
        }
      }

      const newOffset =
        this.fileOffsets.get(filePath) ?? editor.document.getText().length;
      const clampedEndOffset = Math.min(
        Math.max(0, newOffset),
        editor.document.getText().length,
      );
      const cursorPos = editor.document.positionAt(clampedEndOffset);

      editor.selection = new vscode.Selection(cursorPos, cursorPos);
      editor.revealRange(
        new vscode.Range(cursorPos, cursorPos),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport,
      );

      if (options.isBlockEnd) {
        const wasAtEof =
          (this.fileOffsets.get(filePath) ?? 0) >= editor.document.getText().length;
        await editor.document.save();
        if (wasAtEof) {
          this.fileOffsets.set(filePath, editor.document.getText().length);
        }
      }

      return this.extractSnapshotAtLine(editor.document, cursorPos.line, cursorPos.character);
    });
  }

  public async getContextSnapshot(filePath: string): Promise<{
    lineNumber: number;
    column: number;
    currentLineText: string;
    surroundingLines: string;
  } | null> {
    const uri = this.sessionUris.get(filePath);
    if (!uri) {
      return null;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const trackedOffset = this.fileOffsets.get(filePath) ?? doc.getText().length;
      const clampedOffset = Math.min(Math.max(0, trackedOffset), doc.getText().length);
      const pos = doc.positionAt(clampedOffset);
      return this.extractSnapshotAtLine(doc, pos.line, pos.character);
    } catch {
      return null;
    }
  }

  public async setVisualState(
    filePath: string | null,
    lineNumber: number,
    state: PlaybackState,
    inlineLabel?: string,
    blockRange?: { startLine: number; endLine: number },
  ): Promise<void> {
    if (!filePath) {
      this.decorator.clearAll();
      return;
    }

    const uri = this.sessionUris.get(filePath);
    if (!uri) {
      return;
    }

    const editor = vscode.window.visibleTextEditors.find(
      (ed) => ed.document.uri.toString() === uri.toString(),
    );
    if (!editor) {
      return;
    }

    this.decorator.updateDecorations(editor, state, lineNumber, inlineLabel, blockRange);
  }

  public clearDecorations(): void {
    this.decorator.clearAll();
  }

  public getSessionFileUris(): vscode.Uri[] {
    return Array.from(this.sessionUris.values());
  }

  public dispose(): void {
    this.decorator.dispose();
  }

  private async ensureEditorForFile(filePath: string): Promise<vscode.TextEditor> {
    const uri = this.sessionUris.get(filePath);
    if (!uri) {
      throw new Error(`MindStream: No URI registered for file "${filePath}"`);
    }

    const existing = vscode.window.visibleTextEditors.find(
      (ed) => ed.document.uri.toString() === uri.toString(),
    );
    if (existing) {
      return existing;
    }

    const doc = await vscode.workspace.openTextDocument(uri);
    return vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: true,
      preview: false,
    });
  }

  private extractSnapshotAtLine(
    doc: vscode.TextDocument,
    line0Based: number,
    char0Based: number,
  ): AppendChunkResult {
    const safeLine = Math.min(Math.max(0, line0Based), Math.max(0, doc.lineCount - 1));
    const currentLineText = doc.lineAt(safeLine).text;
    const startLine = Math.max(0, safeLine - 4);
    const endLine = Math.min(doc.lineCount - 1, safeLine + 2);
    const lines: string[] = [];

    for (let i = startLine; i <= endLine; i++) {
      const marker = i === safeLine ? '▶' : ' ';
      lines.push(`${marker} ${i + 1}: ${doc.lineAt(i).text}`);
    }

    return {
      lineNumber: safeLine + 1,
      column: char0Based + 1,
      currentLineText,
      surroundingLines: lines.join('\n'),
    };
  }

  private getDocEol(doc: vscode.TextDocument): '\n' | '\r\n' {
    return doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.editQueue.then(task, task);
    this.editQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
