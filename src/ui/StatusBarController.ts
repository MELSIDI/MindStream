import * as vscode from 'vscode';
import { SessionUIState } from '../types/session';

export class StatusBarController implements vscode.Disposable {
  private readonly idleItem: vscode.StatusBarItem;
  private readonly playPauseItem: vscode.StatusBarItem;
  private readonly speedItem: vscode.StatusBarItem;
  private readonly skipItem: vscode.StatusBarItem;
  private readonly fileFastItem: vscode.StatusBarItem;
  private readonly bargeInItem: vscode.StatusBarItem;
  private readonly muteItem: vscode.StatusBarItem;
  private readonly stopItem: vscode.StatusBarItem;
  private readonly tickerItem: vscode.StatusBarItem;

  private lastHasSession: boolean | null = null;

  constructor() {
    this.idleItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 108);
    this.playPauseItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 108);
    this.speedItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 107);
    this.skipItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 106);
    this.fileFastItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 105);
    this.bargeInItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 104);
    this.muteItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 103);
    this.stopItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 102);
    this.tickerItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);

    this.idleItem.command = 'mindstream.quickMenu';
    this.playPauseItem.command = 'mindstream.togglePlayPause';
    this.speedItem.command = 'mindstream.cycleSpeed';
    this.skipItem.command = 'mindstream.skipBlock';
    this.fileFastItem.command = 'mindstream.implementFileAndPause';
    this.bargeInItem.command = 'mindstream.bargeIn';
    this.muteItem.command = 'mindstream.toggleMute';
    this.stopItem.command = 'mindstream.stopSession';
    this.tickerItem.command = 'mindstream.openStudio';
  }

  public update(state: SessionUIState): void {
    const hasSession = state.playbackState !== 'idle';
    if (hasSession !== this.lastHasSession) {
      this.lastHasSession = hasSession;
      void vscode.commands.executeCommand('setContext', 'mindstream.hasSession', hasSession);
    }

    const isFr = state.language === 'fr';

    if (!hasSession) {
      this.playPauseItem.hide();
      this.speedItem.hide();
      this.skipItem.hide();
      this.fileFastItem.hide();
      this.bargeInItem.hide();
      this.muteItem.hide();
      this.stopItem.hide();
      this.tickerItem.hide();

      this.idleItem.text = '$(radio-tower) MindStream';
      this.idleItem.tooltip = isFr
        ? 'Tapez /MindStream dans le chat pour coder à vitesse humaine — cliquez pour les options'
        : 'Type /MindStream in chat to code at human pace — click for quick actions';
      this.idleItem.show();
      return;
    }

    this.idleItem.hide();

    // 1. Play / Pause
    this.playPauseItem.backgroundColor = undefined;
    switch (state.playbackState) {
      case 'playing':
        this.playPauseItem.text = '$(debug-pause)';
        this.playPauseItem.tooltip = isFr ? 'Pause (Ctrl+Alt+P)' : 'Pause (Ctrl+Alt+P)';
        break;
      case 'paused':
        this.playPauseItem.text = '$(play)';
        this.playPauseItem.tooltip = isFr ? 'Reprendre (Ctrl+Alt+P)' : 'Resume (Ctrl+Alt+P)';
        this.playPauseItem.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground',
        );
        break;
      case 'interrupted':
        this.playPauseItem.text = '$(play)';
        this.playPauseItem.tooltip = isFr
          ? 'Barge-in actif — Reprendre (Ctrl+Alt+P)'
          : 'Barge-in active — Resume (Ctrl+Alt+P)';
        this.playPauseItem.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.errorBackground',
        );
        break;
      case 'checkpoint':
        this.playPauseItem.text = '$(milestone)';
        this.playPauseItem.tooltip = isFr
          ? 'Validation technique requise'
          : 'Architecture decision required';
        this.playPauseItem.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground',
        );
        break;
      case 'completed':
        this.playPauseItem.text = '$(check)';
        this.playPauseItem.tooltip = isFr ? 'Session terminée' : 'Session complete';
        break;
      default:
        this.playPauseItem.text = '$(play)';
        this.playPauseItem.tooltip = isFr ? 'Démarrer (Ctrl+Alt+P)' : 'Start (Ctrl+Alt+P)';
        break;
    }
    this.playPauseItem.show();

    // 2. Speed cycler pill
    const speedLabel = state.speedMode === 'auto' ? '$(sparkle) Auto' : `$(dashboard) ${state.speedMode}`;
    const autoBadge =
      state.effectivePace?.autoReason === 'boilerplate'
        ? ' ⚡'
        : state.effectivePace?.autoReason === 'core-logic'
          ? ' 🧠'
          : '';
    this.speedItem.text = `${speedLabel}${autoBadge}`;
    this.speedItem.tooltip = state.effectivePace
      ? `${state.effectivePace.label} (${state.effectivePace.charsPerSecond} car/s) — clic ou Ctrl+Alt+S`
      : isFr
        ? 'Changer de vitesse (Ctrl+Alt+S)'
        : 'Cycle speed (Ctrl+Alt+S)';
    this.speedItem.show();

    // 3. Skip current block
    this.skipItem.text = '$(debug-step-over)';
    this.skipItem.tooltip = isFr
      ? 'Passer au bloc suivant (Ctrl+Alt+N)'
      : 'Skip to next block (Ctrl+Alt+N)';
    if (state.playbackState !== 'completed') {
      this.skipItem.show();
    } else {
      this.skipItem.hide();
    }

    // 4. File-Fast + Pause
    this.fileFastItem.text = state.fileStopTarget ? '$(target) ⏸' : '$(target)';
    this.fileFastItem.tooltip = state.fileStopTarget
      ? isFr
        ? `Mode rapide + pause actif sur ${state.fileStopTarget.filePath}`
        : `Fast + Pause active on ${state.fileStopTarget.filePath}`
      : isFr
        ? 'Coder ce fichier rapidement puis mettre en pause (Ctrl+Alt+F)'
        : 'Implement this file fast then pause (Ctrl+Alt+F)';
    if (state.playbackState !== 'completed') {
      this.fileFastItem.show();
    } else {
      this.fileFastItem.hide();
    }

    // 5. Barge-in
    this.bargeInItem.text =
      state.playbackState === 'interrupted'
        ? '$(comment-discussion) …'
        : isFr
          ? '$(hand) Stop?'
          : '$(hand) Ask?';
    this.bargeInItem.tooltip = isFr
      ? "Interrompre l'IA et poser une question sur la ligne active (Ctrl+Shift+Space)"
      : 'Interrupt AI and ask about current line (Ctrl+Shift+Space)';
    if (state.playbackState !== 'completed') {
      this.bargeInItem.show();
    } else {
      this.bargeInItem.hide();
    }

    // 6. Mute
    this.muteItem.text = state.muted ? '$(mute)' : '$(unmute)';
    this.muteItem.tooltip = state.muted
      ? isFr
        ? 'Activer la voix'
        : 'Unmute voice'
      : isFr
        ? 'Couper la voix'
        : 'Mute voice';
    this.muteItem.show();

    // 7. Stop
    this.stopItem.text = '$(debug-stop)';
    this.stopItem.tooltip = isFr ? 'Arrêter MindStream' : 'Stop MindStream';
    this.stopItem.show();

    // 8. Minimalist live ticker
    if (state.fileStopTarget) {
      this.tickerItem.text = `${state.fileStopTarget.filePath} → ⏸`;
    } else if (state.currentFilePath) {
      const shortTitle = state.currentBlockTitle
        ? ` · ${state.currentBlockTitle.slice(0, 28)}`
        : '';
      this.tickerItem.text = `${state.currentFilePath}:${state.currentLineNumber}${shortTitle}`;
    } else {
      this.tickerItem.text = state.sessionTitle || 'MindStream';
    }
    this.tickerItem.tooltip = isFr
      ? 'Ouvrir le Mini-HUD MindStream'
      : 'Open MindStream Mini-HUD';
    this.tickerItem.show();
  }

  public dispose(): void {
    this.idleItem.dispose();
    this.playPauseItem.dispose();
    this.speedItem.dispose();
    this.skipItem.dispose();
    this.fileFastItem.dispose();
    this.bargeInItem.dispose();
    this.muteItem.dispose();
    this.stopItem.dispose();
    this.tickerItem.dispose();
  }
}
