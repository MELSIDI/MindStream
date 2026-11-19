import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import {
  ExtensionToWebviewMessage,
  SessionUIState,
  WebviewToExtensionMessage,
} from '../types/session';
import { VoiceCoordinator } from '../voice/VoiceCoordinator';

export interface SidebarActionHandlers {
  onStartDemo: () => Promise<void>;
  onStartLiveSession: (prompt: string) => Promise<void>;
  onStartPlayback: () => Promise<void>;
  onTogglePlayPause: () => Promise<void>;
  onSetSpeed: (speed: '0.5x' | '1x' | '2x' | '3x' | 'auto') => void;
  onPreviousBlock: () => Promise<void>;
  onSkipBlock: () => Promise<void>;
  onStopSession: () => void;
  onToggleMute: () => void;
  onImplementFileAndPause: (filePath: string) => Promise<void>;
  onBargeInTrigger: () => Promise<void>;
  onBargeInQuestion: (
    question: string,
    source: 'voice' | 'text' | 'quick-chip',
  ) => Promise<void>;
  onBargeInAudioQuestion: (base64Audio: string, mimeType: string) => Promise<void>;
  onResumeAfterBargeIn: () => Promise<void>;
  onResolveCheckpoint: (optionId: string, customReply?: string) => Promise<void>;
  onInstallPlugin?: () => Promise<void>;
  onConfigureApiKey: () => Promise<void>;
  onOpenSettings: () => void;
  getLatestState: () => SessionUIState;
}

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codepace.studioView';

  private view: vscode.WebviewView | undefined;
  private isWebviewReady = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly voiceCoordinator: VoiceCoordinator,
    private readonly actions: SidebarActionHandlers,
  ) {
    this.voiceCoordinator.attachWebview((msg) => {
      this.postMessage(msg);
    });
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.isWebviewReady = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    const msgDisposable = webviewView.webview.onDidReceiveMessage(
      async (msg: WebviewToExtensionMessage) => {
        await this.handleMessage(msg);
      },
    );

    webviewView.onDidDispose(() => {
      msgDisposable.dispose();
      if (this.view === webviewView) {
        this.view = undefined;
        this.isWebviewReady = false;
        this.voiceCoordinator.setWebviewReady(false);
      }
    });
  }

  public async reveal(preserveFocus = true): Promise<void> {
    if (this.view) {
      this.view.show(preserveFocus);
      return;
    }
    await vscode.commands.executeCommand('codepace.studioView.focus');
  }

  public postState(state: SessionUIState): void {
    if (!this.isWebviewReady) {
      return;
    }
    this.postMessage({ type: 'stateUpdate', state });
  }

  public focusBargeInInput(): void {
    if (this.isWebviewReady) {
      this.postMessage({ type: 'focusBargeInInput' });
    }
  }

  public postMessage(message: ExtensionToWebviewMessage): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage(message);
  }

  private async handleMessage(msg: WebviewToExtensionMessage): Promise<void> {
    switch (msg.type) {
      case 'webviewReady':
        this.isWebviewReady = true;
        this.voiceCoordinator.setWebviewReady(true);
        this.postState(this.actions.getLatestState());
        break;
      case 'startDemo':
        await this.actions.onStartDemo();
        break;
      case 'startLiveSession':
        await this.actions.onStartLiveSession(msg.prompt);
        break;
      case 'startPlayback':
        await this.actions.onStartPlayback();
        break;
      case 'togglePlayPause':
        await this.actions.onTogglePlayPause();
        break;
      case 'setSpeed':
        this.actions.onSetSpeed(msg.speed);
        break;
      case 'previousBlock':
        await this.actions.onPreviousBlock();
        break;
      case 'skipBlock':
        await this.actions.onSkipBlock();
        break;
      case 'stopSession':
        this.actions.onStopSession();
        break;
      case 'toggleMute':
        this.actions.onToggleMute();
        break;
      case 'implementFileAndPause':
        await this.actions.onImplementFileAndPause(msg.filePath);
        break;
      case 'bargeInTrigger':
        await this.actions.onBargeInTrigger();
        break;
      case 'bargeInQuestion':
        await this.actions.onBargeInQuestion(msg.question, msg.source);
        break;
      case 'bargeInAudioQuestion':
        await this.actions.onBargeInAudioQuestion(msg.base64Audio, msg.mimeType);
        break;
      case 'resumeAfterBargeIn':
        await this.actions.onResumeAfterBargeIn();
        break;
      case 'resolveCheckpoint':
        await this.actions.onResolveCheckpoint(msg.optionId, msg.customReply);
        break;
      case 'selectVoice':
        this.voiceCoordinator.setSelectedVoiceId(msg.voiceId);
        break;
      case 'testVoice': {
        const lang = this.actions.getLatestState().language;
        const sample =
          lang === 'fr'
            ? 'Bonjour ! Je suis CodePace, ton binôme de pair-programming. Prêt à coder ensemble à ton rythme.'
            : 'Hello! I am CodePace, your pair-programming partner. Ready to code at your pace.';
        void this.voiceCoordinator.speakSentences(sample, {
          lang,
          rate: 1.0,
        });
        break;
      }
      case 'configureApiKey':
        await this.actions.onConfigureApiKey();
        break;
      case 'installPlugin':
        if (this.actions.onInstallPlugin) {
          await this.actions.onInstallPlugin();
        }
        break;
      case 'openSettings':
        this.actions.onOpenSettings();
        break;
      case 'ttsVoicesAvailable':
        this.voiceCoordinator.handleWebviewVoices(msg.voices);
        break;
      case 'ttsBoundary':
        this.voiceCoordinator.handleWebviewBoundary(
          msg.utteranceId,
          msg.charIndex,
          msg.charLength,
        );
        break;
      case 'ttsEnded':
        this.voiceCoordinator.handleWebviewEnded(msg.utteranceId);
        break;
      case 'ttsError':
        this.voiceCoordinator.handleWebviewError(msg.utteranceId);
        break;
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'),
    );

    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      'media-src data: blob:',
      `img-src ${webview.cspSource} data:`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CodePace Studio</title>
  <link rel="stylesheet" href="${styleUri.toString()}" />
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}
