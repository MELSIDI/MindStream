import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  AIProvider,
  AIProviderChoice,
  AIProviderFactory,
  SECRET_GEMINI_API_KEY,
  SECRET_OPENAI_API_KEY,
} from './ai/AIProvider';
import { WorkspaceAnalyzer } from './ai/WorkspaceAnalyzer';
import { BridgeServer } from './bridge/BridgeServer';
import { LiveAgentSessionDriver } from './bridge/LiveAgentSessionDriver';
import { DemoQAEngine } from './demo/DemoQAEngine';
import { buildDemoSessionPlan } from './demo/DemoSessionBuilder';
import { EditorChoreographer } from './editor/EditorChoreographer';
import { EditorDecorator } from './editor/EditorDecorator';
import { PlaybackEngine } from './engine/PlaybackEngine';
import { CheckpointStep, SessionUIState, SpeedMode } from './types/session';
import { registerCodePaceChatParticipant } from './ui/ChatParticipant';
import { SidebarViewProvider } from './ui/SidebarViewProvider';
import { StatusBarController } from './ui/StatusBarController';
import { TTSProviderSetting, VoiceCoordinator } from './voice/VoiceCoordinator';

function readConfig() {
  const cfg = vscode.workspace.getConfiguration('codepace');
  return {
    language: (cfg.get<'fr' | 'en'>('language') ?? 'fr') as 'fr' | 'en',
    defaultSpeed: (cfg.get<SpeedMode>('defaultSpeed') ?? '1x') as SpeedMode,
    aiProvider: (cfg.get<AIProviderChoice>('aiProvider') ?? 'auto') as AIProviderChoice,
    geminiModel: cfg.get<string>('geminiModel') ?? 'gemini-4-hydrogen',
    openaiBaseUrl: cfg.get<string>('openaiBaseUrl') ?? 'https://api.openai.com/v1',
    openaiModel: cfg.get<string>('openaiModel') ?? 'gpt-4o-mini',
    ttsProvider: (cfg.get<TTSProviderSetting>('ttsProvider') ?? 'auto') as TTSProviderSetting,
    geminiTtsVoice: cfg.get<string>('geminiTtsVoice') ?? 'Kore',
    voiceRateMultiplier: cfg.get<number>('voiceRateMultiplier') ?? 1.0,
    autoResearchIntro: cfg.get<boolean>('autoResearchIntro') ?? true,
    showInlineAnnotations: cfg.get<boolean>('showInlineAnnotations') ?? true,
  };
}

async function copyDirRecursive(srcDir: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const initialCfg = readConfig();

  const decorator = new EditorDecorator(context.extensionUri);
  decorator.setShowInlineAnnotations(initialCfg.showInlineAnnotations);

  const editorChoreographer = new EditorChoreographer(decorator);
  const voiceCoordinator = new VoiceCoordinator();
  const demoQA = new DemoQAEngine();
  const analyzer = new WorkspaceAnalyzer();
  const statusBar = new StatusBarController();

  let activeAIProvider: AIProvider | null = null;
  let activeChannel: 'demo' | 'mcp' = 'demo';
  let activeCheckpointQuickPick: vscode.QuickPick<vscode.QuickPickItem & { optionId?: string; isCustom?: boolean }> | null = null;

  const engine = new PlaybackEngine(editorChoreographer, voiceCoordinator, demoQA, {
    language: initialCfg.language,
    defaultSpeed: initialCfg.defaultSpeed,
    voiceRateMultiplier: initialCfg.voiceRateMultiplier,
    autoResearchIntro: initialCfg.autoResearchIntro,
    providerLabel: 'Demo',
  });

  const liveDriver = new LiveAgentSessionDriver(editorChoreographer, voiceCoordinator, {
    language: initialCfg.language,
    defaultSpeed: initialCfg.defaultSpeed,
    voiceRateMultiplier: initialCfg.voiceRateMultiplier,
    providerLabel: 'Chat /CodePace',
  });

  const bridgeServer = new BridgeServer(liveDriver, () =>
    (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
  );

  const getCurrentUIState = (): SessionUIState => {
    if (liveDriver.isActive() || activeChannel === 'mcp') {
      return liveDriver.getUIState();
    }
    return engine.getUIState();
  };

  const broadcastState = () => {
    const state = getCurrentUIState();
    statusBar.update(state);
    sidebarProvider.postState(state);
  };

  const showCheckpointQuickPick = (step: CheckpointStep) => {
    activeCheckpointQuickPick?.dispose();
    const isFr = readConfig().language === 'fr';
    const qp = vscode.window.createQuickPick<
      vscode.QuickPickItem & { optionId?: string; isCustom?: boolean }
    >();
    activeCheckpointQuickPick = qp;
    qp.title = `CodePace · ${step.title}`;
    qp.placeholder = step.question;
    qp.ignoreFocusOut = true;

    const items: Array<vscode.QuickPickItem & { optionId?: string; isCustom?: boolean }> =
      step.options.map((o) => ({
        label: o.recommended ? `$(star-full) ${o.label}` : o.label,
        description: o.description,
        optionId: o.id,
      }));
    items.push({
      label: isFr ? '$(edit) Réponse personnalisée…' : '$(edit) Custom response…',
      description: isFr
        ? 'Saisir votre propre directive pour le modèle'
        : 'Type your own architectural instruction',
      isCustom: true,
      optionId: step.options.find((o) => o.recommended)?.id ?? step.options[0]?.id,
    });

    qp.items = items;
    qp.onDidAccept(async () => {
      const selected = qp.selectedItems[0];
      qp.hide();
      if (!selected) {
        return;
      }
      if (selected.isCustom) {
        const reply = await vscode.window.showInputBox({
          prompt: step.question,
          placeHolder: isFr ? 'Votre consigne…' : 'Your instruction…',
          ignoreFocusOut: true,
        });
        liveDriver.resolveCheckpoint(selected.optionId ?? '', reply);
      } else if (selected.optionId) {
        liveDriver.resolveCheckpoint(selected.optionId);
      }
    });
    qp.onDidHide(() => {
      if (activeCheckpointQuickPick === qp) {
        activeCheckpointQuickPick = null;
      }
      qp.dispose();
    });
    qp.show();
  };

  const syncProviderSettings = async () => {
    const cfg = readConfig();
    const geminiApiKey = await context.secrets.get(SECRET_GEMINI_API_KEY);
    const openaiApiKey = await context.secrets.get(SECRET_OPENAI_API_KEY);

    decorator.setShowInlineAnnotations(cfg.showInlineAnnotations);
    voiceCoordinator.updateSettings({
      ttsProvider: cfg.ttsProvider,
      geminiApiKey: geminiApiKey ?? null,
      geminiVoice: cfg.geminiTtsVoice,
    });

    activeAIProvider = await AIProviderFactory.resolve({
      choice: cfg.aiProvider,
      geminiApiKey,
      geminiModel: cfg.geminiModel,
      openaiApiKey,
      openaiBaseUrl: cfg.openaiBaseUrl,
      openaiModel: cfg.openaiModel,
    });

    engine.updateConfig({
      language: cfg.language,
      defaultSpeed: cfg.defaultSpeed,
      voiceRateMultiplier: cfg.voiceRateMultiplier,
      autoResearchIntro: cfg.autoResearchIntro,
      providerLabel: activeAIProvider?.name ?? 'Demo (Offline)',
    });

    liveDriver.updateConfig({
      language: cfg.language,
      defaultSpeed: cfg.defaultSpeed,
      voiceRateMultiplier: cfg.voiceRateMultiplier,
      providerLabel: 'Chat /CodePace',
    });
  };

  const installPluginBundle = async (silent = false) => {
    const isFr = readConfig().language === 'fr';
    const srcDir = path.join(context.extensionPath, 'agent-plugin');
    const destDir = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'codepace');

    try {
      await fs.access(srcDir);
      await copyDirRecursive(srcDir, destDir);
      if (!silent) {
        void vscode.window.showInformationMessage(
          isFr
            ? `Plugin /CodePace installé dans ${destDir}. Tapez /CodePace dans votre chat Antigravity (ou redémarrez une nouvelle conversation si déjà ouverte).`
            : `/CodePace plugin installed to ${destDir}. Type /CodePace in Antigravity chat.`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!silent) {
        void vscode.window.showErrorMessage(`CodePace plugin install error: ${msg}`);
      }
    }
  };

  const startDemoSession = async () => {
    const cfg = readConfig();
    liveDriver.stop();
    activeChannel = 'demo';
    editorChoreographer.resetSession(true);
    engine.setQuestionResponder(demoQA);
    engine.updateConfig({
      language: cfg.language,
      providerLabel: 'Demo (Offline)',
    });

    const demoPlan = buildDemoSessionPlan(cfg.language);
    await engine.loadSession(demoPlan, true);
  };

  const startLiveSessionLegacy = async (goalPrompt: string) => {
    const cleanPrompt = goalPrompt.trim();
    if (!cleanPrompt) {
      return;
    }

    await syncProviderSettings();
    const cfg = readConfig();

    if (!activeAIProvider) {
      await startDemoSession();
      return;
    }

    liveDriver.stop();
    activeChannel = 'demo';
    engine.setResearching(cleanPrompt);

    try {
      const wsContext = await analyzer.analyze(cleanPrompt);
      const plan = await activeAIProvider.generatePlan(
        cleanPrompt,
        wsContext,
        cfg.language,
      );
      editorChoreographer.resetSession(false);
      engine.setQuestionResponder(activeAIProvider);
      engine.updateConfig({ providerLabel: activeAIProvider.name });
      await engine.loadSession(plan, false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      engine.stop();
      void vscode.window.showErrorMessage(`CodePace AI Error: ${message}`);
    }
  };

  const configureApiKey = async () => {
    const isFr = readConfig().language === 'fr';
    const picked = await vscode.window.showQuickPick(
      [
        {
          id: 'gemini',
          label: '$(sparkle) Google Gemini API Key',
          description: isFr
            ? 'Optionnel — uniquement si vous n’utilisez pas /CodePace depuis le chat'
            : 'Optional — only needed outside /CodePace chat integration',
        },
        {
          id: 'openai',
          label: '$(plug) OpenAI / OpenRouter / Groq API Key',
          description: 'Optional fallback provider',
        },
        {
          id: 'clear',
          label: '$(trash) Effacer les clés',
          description: isFr ? 'Supprimer les secrets enregistrés' : 'Clear stored secrets',
        },
      ],
      {
        placeHolder: isFr ? 'Configurer une clé optionnelle' : 'Optional API key configuration',
      },
    );

    if (!picked) {
      return;
    }

    if (picked.id === 'clear') {
      await context.secrets.delete(SECRET_GEMINI_API_KEY);
      await context.secrets.delete(SECRET_OPENAI_API_KEY);
      await syncProviderSettings();
      return;
    }

    const apiKey = await vscode.window.showInputBox({
      prompt: 'API Key (SecretStorage)',
      password: true,
      ignoreFocusOut: true,
    });
    if (apiKey && apiKey.trim()) {
      await context.secrets.store(
        picked.id === 'gemini' ? SECRET_GEMINI_API_KEY : SECRET_OPENAI_API_KEY,
        apiKey.trim(),
      );
      await syncProviderSettings();
    }
  };

  const triggerBargeInFromCommand = async () => {
    const isFr = readConfig().language === 'fr';
    if (liveDriver.isActive() || activeChannel === 'mcp') {
      const snapshot = await liveDriver.interruptWithPrompt();
      if (!snapshot) {
        return;
      }
      const question = await vscode.window.showInputBox({
        prompt: isFr
          ? `✋ Interrompu sur ${snapshot.filePath}:${snapshot.lineNumber} — Posez votre question (Échap pour rester en pause)`
          : `✋ Interrupted at ${snapshot.filePath}:${snapshot.lineNumber} — Ask your question (Esc to stay paused)`,
        placeHolder: isFr
          ? 'Ex: Pourquoi tu fais ça ici ?'
          : 'E.g., Why are you doing this here?',
        ignoreFocusOut: true,
      });
      if (question && question.trim()) {
        liveDriver.submitBargeInQuestion(question.trim(), 'text');
      } else {
        liveDriver.cancelBargeInToPause();
      }
      return;
    }

    await engine.interrupt();
    await sidebarProvider.reveal(false);
    sidebarProvider.focusBargeInInput();
  };

  const handleImplementFileAndPause = async (target?: string | vscode.Uri) => {
    const state = getCurrentUIState();
    const isFr = state.language === 'fr';

    if (state.playbackState === 'idle') {
      void vscode.window.showInformationMessage(
        isFr
          ? 'Aucune session active. Tapez /CodePace dans le chat ou lancez la Démo.'
          : 'No active session. Type /CodePace in chat or launch the Demo.',
      );
      return;
    }

    let resolvedPath: string | undefined;
    if (typeof target === 'string') {
      resolvedPath = target;
    } else if (target instanceof vscode.Uri) {
      resolvedPath = target.fsPath;
    } else {
      resolvedPath =
        vscode.window.activeTextEditor?.document.uri.fsPath ??
        state.currentFilePath ??
        undefined;
    }

    if (liveDriver.isActive() || activeChannel === 'mcp') {
      liveDriver.implementFileAndPause(resolvedPath);
      return;
    }

    const ok = await engine.implementFileAndPause(resolvedPath);
    if (!ok) {
      void vscode.window.showWarningMessage(
        isFr
          ? 'Ce fichier ne fait pas partie des étapes restantes.'
          : 'File not found in remaining session steps.',
      );
    }
  };

  const togglePlayPauseUnified = async () => {
    if (liveDriver.isActive() || activeChannel === 'mcp') {
      liveDriver.togglePlayPause();
    } else {
      await engine.togglePlayPause();
    }
  };

  const setSpeedUnified = (speed: SpeedMode) => {
    engine.setSpeed(speed);
    liveDriver.setSpeed(speed);
  };

  const cycleSpeedUnified = () => {
    if (liveDriver.isActive() || activeChannel === 'mcp') {
      return liveDriver.cycleSpeed();
    }
    return engine.cycleSpeed();
  };

  const skipBlockUnified = async () => {
    if (liveDriver.isActive() || activeChannel === 'mcp') {
      liveDriver.skipBlock();
    } else {
      await engine.skipBlock();
    }
  };

  const stopSessionUnified = () => {
    activeCheckpointQuickPick?.hide();
    liveDriver.stop();
    engine.stop();
    activeChannel = 'demo';
  };

  const toggleMuteUnified = () => {
    if (liveDriver.isActive() || activeChannel === 'mcp') {
      liveDriver.toggleMute();
    } else {
      engine.toggleMute();
    }
  };

  const sidebarProvider = new SidebarViewProvider(context.extensionUri, voiceCoordinator, {
    onStartDemo: startDemoSession,
    onStartLiveSession: startLiveSessionLegacy,
    onStartPlayback: () => engine.start(),
    onTogglePlayPause: togglePlayPauseUnified,
    onSetSpeed: setSpeedUnified,
    onPreviousBlock: () => engine.previousBlock(),
    onSkipBlock: skipBlockUnified,
    onStopSession: stopSessionUnified,
    onToggleMute: toggleMuteUnified,
    onImplementFileAndPause: (filePath) => handleImplementFileAndPause(filePath),
    onBargeInTrigger: async () => {
      if (liveDriver.isActive() || activeChannel === 'mcp') {
        await liveDriver.interruptWithPrompt();
        sidebarProvider.focusBargeInInput();
      } else {
        await engine.interrupt();
        sidebarProvider.focusBargeInInput();
      }
    },
    onBargeInQuestion: async (question, source) => {
      if (liveDriver.isActive() || activeChannel === 'mcp') {
        liveDriver.submitBargeInQuestion(question, source);
      } else {
        await engine.askQuestion(question, source);
      }
    },
    onBargeInAudioQuestion: async (base64Audio, mimeType) => {
      if (activeAIProvider?.transcribeAudio) {
        try {
          const transcript = await activeAIProvider.transcribeAudio(
            base64Audio,
            mimeType,
            readConfig().language,
          );
          if (transcript) {
            if (liveDriver.isActive() || activeChannel === 'mcp') {
              liveDriver.submitBargeInQuestion(transcript, 'voice');
            } else {
              await engine.askQuestion(transcript, 'voice');
            }
            return;
          }
        } catch {
          // Ignore transcription error.
        }
      }
    },
    onResumeAfterBargeIn: async () => {
      if (liveDriver.isActive() || activeChannel === 'mcp') {
        liveDriver.resume();
      } else {
        await engine.resume();
      }
    },
    onResolveCheckpoint: async (optionId, customReply) => {
      if (liveDriver.isActive() || activeChannel === 'mcp') {
        activeCheckpointQuickPick?.hide();
        liveDriver.resolveCheckpoint(optionId, customReply);
      } else {
        await engine.resolveCheckpoint(optionId, customReply);
      }
    },
    onInstallPlugin: () => installPluginBundle(false),
    onConfigureApiKey: configureApiKey,
    onOpenSettings: () => {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'codepace');
    },
    getLatestState: getCurrentUIState,
  });

  liveDriver.setPromptHooks({
    onCheckpointPromptNeeded: (step) => {
      showCheckpointQuickPick(step);
    },
  });

  voiceCoordinator.setOnMetadataChanged(() => {
    engine.notifyVoiceMetadataChanged();
    liveDriver.notifyVoiceMetadataChanged();
  });

  const unsubDemo = engine.onStateChange((state) => {
    if (state.playbackState !== 'idle' && state.playbackState !== 'completed') {
      activeChannel = 'demo';
    }
    if (!liveDriver.isActive() && activeChannel === 'demo') {
      statusBar.update(state);
      sidebarProvider.postState(state);
    }
  });

  const unsubMcp = liveDriver.onStateChange((state) => {
    if (state.playbackState !== 'idle') {
      activeChannel = 'mcp';
      engine.stop();
    } else if (activeChannel === 'mcp') {
      activeChannel = 'demo';
    }
    if (state.playbackState !== 'checkpoint') {
      activeCheckpointQuickPick?.hide();
    }
    broadcastState();
  });

  const chatParticipantDisposable = registerCodePaceChatParticipant(
    context.extensionUri,
    liveDriver,
    {
      getLanguage: () => readConfig().language,
      onDemo: startDemoSession,
      onPause: () => {
        if (liveDriver.isActive() || activeChannel === 'mcp') liveDriver.pause();
        else engine.pause();
      },
      onResume: async () => {
        if (liveDriver.isActive() || activeChannel === 'mcp') liveDriver.resume();
        else await engine.resume();
      },
      onSkip: skipBlockUnified,
      onStop: stopSessionUnified,
      onSetSpeed: setSpeedUnified,
      onFileFastPause: (fp) => handleImplementFileAndPause(fp),
    },
  );

  if (chatParticipantDisposable) {
    context.subscriptions.push(chatParticipantDisposable);
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarViewProvider.viewType,
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    statusBar,
    editorChoreographer,
    {
      dispose: () => {
        unsubDemo();
        unsubMcp();
        activeCheckpointQuickPick?.dispose();
        liveDriver.stop();
        engine.stop();
        voiceCoordinator.dispose();
        void bridgeServer.dispose();
      },
    },
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void bridgeServer.updateWorkspaces();
    }),
    vscode.window.onDidChangeWindowState((windowState) => {
      void bridgeServer.setFocused(windowState.focused);
    }),
    vscode.workspace.onDidChangeConfiguration((ev) => {
      if (ev.affectsConfiguration('codepace')) {
        void syncProviderSettings();
      }
    }),
    vscode.commands.registerCommand('codepace.openStudio', () =>
      sidebarProvider.reveal(false),
    ),
    vscode.commands.registerCommand('codepace.quickMenu', async () => {
      const isFr = readConfig().language === 'fr';
      const choice = await vscode.window.showQuickPick(
        [
          {
            id: 'demo',
            label: isFr
              ? '$(play) Lancer la Démo FocusFlow (Sans clé API)'
              : '$(play) Launch FocusFlow Demo (No API key)',
            description: isFr
              ? 'Démonstration complète dans votre éditeur'
              : 'Full interactive demo in your editor',
          },
          {
            id: 'hud',
            label: isFr
              ? '$(layout-sidebar-left) Ouvrir le Mini-HUD CodePace'
              : '$(layout-sidebar-left) Open CodePace Mini-HUD',
            description: isFr
              ? 'Contrôles compacts et choix de voix'
              : 'Compact controls and voice picker',
          },
          {
            id: 'plugin',
            label: isFr
              ? '$(plug) Installer le plugin /CodePace (Antigravity & MCP)'
              : '$(plug) Install /CodePace Plugin (Antigravity & MCP)',
            description: isFr
              ? 'Active /CodePace dans votre chat existant'
              : 'Enables /CodePace directly inside your existing chat',
          },
          {
            id: 'info',
            label: '$(comment) Astuce : utilisez /CodePace dans le chat',
            description: isFr
              ? 'Ex: « Implémente le projet ... /CodePace »'
              : 'E.g.: "Implement project ... /CodePace"',
          },
        ],
        {
          placeHolder: 'CodePace',
        },
      );
      if (!choice) return;
      if (choice.id === 'demo') await startDemoSession();
      else if (choice.id === 'hud') await sidebarProvider.reveal(false);
      else if (choice.id === 'plugin') await installPluginBundle(false);
      else {
        void vscode.window.showInformationMessage(
          isFr
            ? 'Ajoutez simplement /CodePace à la fin de n’importe quel prompt dans votre chat Antigravity ou VS Code !'
            : 'Simply append /CodePace to any prompt in your Antigravity or VS Code chat!',
        );
      }
    }),
    vscode.commands.registerCommand('codepace.startDemo', startDemoSession),
    vscode.commands.registerCommand('codepace.startSession', async () => {
      const isFr = readConfig().language === 'fr';
      const prompt = await vscode.window.showInputBox({
        prompt: isFr
          ? 'Que voulez-vous coder avec CodePace ? (Astuce : tapez /CodePace directement dans le chat !)'
          : 'What do you want to code with CodePace? (Tip: just type /CodePace in chat!)',
        ignoreFocusOut: true,
      });
      if (prompt) {
        await startLiveSessionLegacy(prompt);
      }
    }),
    vscode.commands.registerCommand('codepace.togglePlayPause', togglePlayPauseUnified),
    vscode.commands.registerCommand('codepace.cycleSpeed', () => {
      const next = cycleSpeedUnified();
      void vscode.window.setStatusBarMessage(`CodePace: ${next}`, 1600);
    }),
    vscode.commands.registerCommand('codepace.setSpeed', async () => {
      const isFr = readConfig().language === 'fr';
      const picked = await vscode.window.showQuickPick<
        vscode.QuickPickItem & { value: SpeedMode }
      >(
        [
          { value: '0.5x', label: '0.5x', description: isFr ? 'Lent & détaillé' : 'Slow & detailed' },
          { value: '1x', label: '1x', description: isFr ? 'Humain synchronisé' : 'Human synced' },
          { value: '2x', label: '2x', description: isFr ? 'Accéléré' : 'Fast' },
          { value: '3x', label: '3x', description: isFr ? 'Turbo' : 'Turbo' },
          {
            value: 'auto',
            label: '✨ Auto',
            description: isFr
              ? 'Rapide sur boilerplate, lent sur logique clé'
              : 'Fast on boilerplate, thoughtful on core logic',
          },
        ],
        { placeHolder: 'CodePace Speed' },
      );
      if (picked) {
        setSpeedUnified(picked.value);
      }
    }),
    vscode.commands.registerCommand('codepace.bargeIn', triggerBargeInFromCommand),
    vscode.commands.registerCommand(
      'codepace.implementFileAndPause',
      (uri?: vscode.Uri) => handleImplementFileAndPause(uri),
    ),
    vscode.commands.registerCommand('codepace.skipBlock', skipBlockUnified),
    vscode.commands.registerCommand('codepace.stopSession', stopSessionUnified),
    vscode.commands.registerCommand('codepace.configureApiKey', configureApiKey),
    vscode.commands.registerCommand('codepace.toggleMute', toggleMuteUnified),
    vscode.commands.registerCommand('codepace.installAntigravityPlugin', () =>
      installPluginBundle(false),
    ),
  );

  void syncProviderSettings();
  void bridgeServer
    .start()
    .then(() => bridgeServer.setFocused(vscode.window.state.focused))
    .catch((err) => {
      console.error('[CodePace] BridgeServer failed to start:', err);
    });
}

export function deactivate(): void {
  // Handled by context.subscriptions disposables.
}
