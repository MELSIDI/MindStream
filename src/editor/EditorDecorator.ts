import * as vscode from 'vscode';
import { PlaybackState } from '../types/session';

export class EditorDecorator implements vscode.Disposable {
  private readonly activeBlockDecoration: vscode.TextEditorDecorationType;
  private readonly speakingLineDecoration: vscode.TextEditorDecorationType;
  private readonly pausedLineDecoration: vscode.TextEditorDecorationType;
  private readonly interruptedLineDecoration: vscode.TextEditorDecorationType;
  private readonly checkpointLineDecoration: vscode.TextEditorDecorationType;

  private showInlineAnnotations = true;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.activeBlockDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(99, 102, 241, 0.08)',
      borderWidth: '0 0 0 2px',
      borderStyle: 'solid',
      borderColor: 'rgba(99, 102, 241, 0.45)',
      isWholeLine: true,
    });

    this.speakingLineDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(99, 102, 241, 0.20)',
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: '#6366F1',
      isWholeLine: true,
      gutterIconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'gutter-speaking.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: '#6366F1',
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });

    this.pausedLineDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(245, 158, 11, 0.16)',
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: '#F59E0B',
      isWholeLine: true,
      gutterIconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'gutter-paused.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: '#F59E0B',
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });

    this.interruptedLineDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(244, 63, 94, 0.18)',
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: '#F43F5E',
      isWholeLine: true,
      gutterIconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'gutter-interrupted.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: '#F43F5E',
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });

    this.checkpointLineDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(16, 185, 129, 0.16)',
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: '#10B981',
      isWholeLine: true,
      gutterIconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'gutter-checkpoint.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: '#10B981',
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });
  }

  public setShowInlineAnnotations(enabled: boolean): void {
    this.showInlineAnnotations = enabled;
  }

  public updateDecorations(
    editor: vscode.TextEditor,
    state: PlaybackState,
    lineNumber1Based: number,
    inlineLabel?: string,
    blockRange?: { startLine: number; endLine: number },
  ): void {
    const lineCount = Math.max(1, editor.document.lineCount);
    const activeLine = Math.min(lineCount - 1, Math.max(0, lineNumber1Based - 1));
    const lineEnd = editor.document.lineAt(activeLine).range.end;
    const activeRange = new vscode.Range(new vscode.Position(activeLine, 0), lineEnd);

    // Clear all state decorations on this editor first.
    editor.setDecorations(this.activeBlockDecoration, []);
    editor.setDecorations(this.speakingLineDecoration, []);
    editor.setDecorations(this.pausedLineDecoration, []);
    editor.setDecorations(this.interruptedLineDecoration, []);
    editor.setDecorations(this.checkpointLineDecoration, []);

    if (state === 'idle') {
      return;
    }

    if (blockRange) {
      const start = Math.min(lineCount - 1, Math.max(0, blockRange.startLine - 1));
      const end = Math.min(lineCount - 1, Math.max(start, blockRange.endLine - 1));
      const blockBandRange = new vscode.Range(
        new vscode.Position(start, 0),
        editor.document.lineAt(end).range.end,
      );
      editor.setDecorations(this.activeBlockDecoration, [blockBandRange]);
    }

    const decorationOpt: vscode.DecorationOptions = {
      range: activeRange,
      renderOptions:
        this.showInlineAnnotations && inlineLabel
          ? {
              after: {
                contentText: `  ${inlineLabel}`,
                color: new vscode.ThemeColor('editorCodeLens.foreground'),
                fontStyle: 'italic',
                margin: '0 0 0 12px',
              },
            }
          : undefined,
    };

    if (state === 'playing') {
      editor.setDecorations(this.speakingLineDecoration, [decorationOpt]);
    } else if (state === 'paused') {
      editor.setDecorations(this.pausedLineDecoration, [decorationOpt]);
    } else if (state === 'interrupted') {
      editor.setDecorations(this.interruptedLineDecoration, [decorationOpt]);
    } else if (state === 'checkpoint' || state === 'completed') {
      editor.setDecorations(this.checkpointLineDecoration, [decorationOpt]);
    }
  }

  public clearAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.activeBlockDecoration, []);
      editor.setDecorations(this.speakingLineDecoration, []);
      editor.setDecorations(this.pausedLineDecoration, []);
      editor.setDecorations(this.interruptedLineDecoration, []);
      editor.setDecorations(this.checkpointLineDecoration, []);
    }
  }

  public dispose(): void {
    this.activeBlockDecoration.dispose();
    this.speakingLineDecoration.dispose();
    this.pausedLineDecoration.dispose();
    this.interruptedLineDecoration.dispose();
    this.checkpointLineDecoration.dispose();
  }
}
