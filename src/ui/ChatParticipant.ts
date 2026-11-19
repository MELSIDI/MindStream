import * as vscode from 'vscode';
import { extractJsonObject, validateAndNormalizePlan } from '../ai/AIProvider';
import {
  buildPlanGenerationSystemPrompt,
  buildPlanGenerationUserPrompt,
} from '../ai/Prompts';
import { WorkspaceAnalyzer } from '../ai/WorkspaceAnalyzer';
import { LiveAgentSessionDriver } from '../bridge/LiveAgentSessionDriver';
import { FileStep, SpeedMode } from '../types/session';

interface ChatRequestLike {
  command?: string;
  prompt: string;
  model?: {
    sendRequest(
      messages: Array<{ content: string }>,
      options: Record<string, unknown>,
      token: vscode.CancellationToken,
    ): Promise<{ text: AsyncIterable<string> }>;
  };
}

interface ChatStreamLike {
  markdown(value: string): void;
}

interface ChatNamespaceLike {
  createChatParticipant(
    id: string,
    handler: (
      request: ChatRequestLike,
      context: unknown,
      stream: ChatStreamLike,
      token: vscode.CancellationToken,
    ) => Promise<void>,
  ): vscode.Disposable & { iconPath?: vscode.Uri };
}

const VALID_SPEEDS = new Set<SpeedMode>(['0.5x', '1x', '2x', '3x', 'auto']);

export function registerMindStreamChatParticipant(
  extensionUri: vscode.Uri,
  liveDriver: LiveAgentSessionDriver,
  handlers: {
    getLanguage: () => 'fr' | 'en';
    onDemo: () => Promise<void>;
    onPause: () => void;
    onResume: () => Promise<void>;
    onSkip: () => Promise<void>;
    onStop: () => void;
    onSetSpeed: (speed: SpeedMode) => void;
    onFileFastPause: (filePath?: string) => Promise<void>;
  },
): vscode.Disposable | null {
  const chatNs = (vscode as unknown as { chat?: ChatNamespaceLike }).chat;
  if (!chatNs || typeof chatNs.createChatParticipant !== 'function') {
    return null;
  }

  const analyzer = new WorkspaceAnalyzer();

  const participant = chatNs.createChatParticipant(
    'mindstream.pair',
    async (request, _ctx, stream, token) => {
      const lang = handlers.getLanguage();
      const cmd = request.command?.toLowerCase();
      const promptTrimmed = request.prompt.trim();

      if (cmd === 'demo') {
        await handlers.onDemo();
        stream.markdown(
          lang === 'fr'
            ? 'Démo FocusFlow lancée à vitesse humaine dans l’éditeur.'
            : 'FocusFlow demo launched at human pace in the editor.',
        );
        return;
      }

      if (cmd === 'pause') {
        handlers.onPause();
        stream.markdown(lang === 'fr' ? '⏸ MindStream mis en pause.' : '⏸ MindStream paused.');
        return;
      }

      if (cmd === 'resume') {
        await handlers.onResume();
        stream.markdown(lang === 'fr' ? '▶ Reprise en cours.' : '▶ Resumed.');
        return;
      }

      if (cmd === 'skip') {
        await handlers.onSkip();
        stream.markdown(lang === 'fr' ? '⏭ Bloc passé.' : '⏭ Skipped to next block.');
        return;
      }

      if (cmd === 'stop') {
        handlers.onStop();
        stream.markdown(lang === 'fr' ? '⏹ Session arrêtée.' : '⏹ Session stopped.');
        return;
      }

      if (cmd === 'speed') {
        const arg = promptTrimmed.toLowerCase() as SpeedMode;
        if (VALID_SPEEDS.has(arg)) {
          handlers.onSetSpeed(arg);
          stream.markdown(`🎚️ MindStream: **${arg}**`);
        } else {
          stream.markdown(
            lang === 'fr'
              ? 'Vitesses disponibles : `0.5x`, `1x`, `2x`, `3x`, `auto`.'
              : 'Available speeds: `0.5x`, `1x`, `2x`, `3x`, `auto`.',
          );
        }
        return;
      }

      if (cmd === 'file') {
        await handlers.onFileFastPause(promptTrimmed || undefined);
        stream.markdown(
          lang === 'fr'
            ? `🎯 Implémentation rapide + pause activée${promptTrimmed ? ` sur \`${promptTrimmed}\`` : ''}.`
            : `🎯 Fast + Pause activated${promptTrimmed ? ` on \`${promptTrimmed}\`` : ''}.`,
        );
        return;
      }

      if (!promptTrimmed) {
        stream.markdown(
          lang === 'fr'
            ? 'Décrivez ce que vous voulez coder avec `@mindstream` ou tapez `/MindStream` dans votre chat.'
            : 'Describe what to build with `@mindstream` or include `/MindStream` in your chat prompt.',
        );
        return;
      }

      if (!request.model) {
        stream.markdown(
          lang === 'fr'
            ? 'Aucun modèle de chat actif fourni par l’hôte. Utilisez directement `/MindStream` dans Antigravity ou configurez le serveur MCP `mindstream-driver`.'
            : 'No host chat model provided. Use `/MindStream` in Antigravity or connect the `mindstream-driver` MCP server.',
        );
        return;
      }

      stream.markdown(
        lang === 'fr'
          ? '🔍 Analyse du projet et préparation du plan MindStream…\n\n'
          : '🔍 Researching workspace and building MindStream plan…\n\n',
      );

      const wsCtx = await analyzer.analyze(promptTrimmed);
      const fullPrompt = `${buildPlanGenerationSystemPrompt(lang)}\n\n${buildPlanGenerationUserPrompt(promptTrimmed, wsCtx, lang)}`;

      const msgBuilder = (
        vscode as unknown as {
          LanguageModelChatMessage?: { User(content: string): { content: string } };
        }
      ).LanguageModelChatMessage;

      const response = await request.model.sendRequest(
        [msgBuilder ? msgBuilder.User(fullPrompt) : { content: fullPrompt }],
        {},
        token,
      );

      let raw = '';
      for await (const chunk of response.text) {
        raw += chunk;
      }

      const plan = validateAndNormalizePlan(extractJsonObject(raw), promptTrimmed, lang);
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      stream.markdown(`**${plan.title}**\n\n${plan.research.summary}\n`);
      await liveDriver.startSession({
        title: plan.title,
        goal: plan.goal,
        language: lang,
        workspaceRoot,
        researchSummary: plan.research.summary,
        findings: plan.research.findings,
        architectureDecisions: plan.research.architectureDecisions,
        spokenIntro: plan.research.spokenIntro,
        plannedFiles: plan.steps
          .filter((s): s is FileStep => s.kind === 'file')
          .map((s) => s.filePath),
      });

      for (const step of plan.steps) {
        if (token.isCancellationRequested) {
          liveDriver.stop();
          return;
        }
        if (step.kind === 'checkpoint') {
          await liveDriver.askCheckpoint({
            title: step.title,
            question: step.question,
            rationale: step.rationale,
            relatedFilePath: step.relatedFilePath,
            options: step.options.map((o) => ({
              id: o.id,
              label: o.label,
              description: o.description,
              recommended: o.recommended,
            })),
          });
          continue;
        }
        for (const block of step.blocks) {
          const res = await liveDriver.writeBlock({
            filePath: step.filePath,
            workspaceRoot,
            languageId: step.languageId,
            title: block.title,
            category: block.category,
            importance: block.importance,
            code: block.code,
            narration: block.narration,
            shortCue: block.shortCue,
            rationale: block.rationale,
          });
          if (res.status === 'stopped') {
            return;
          }
          if (res.status === 'interrupted' && res.question) {
            stream.markdown(
              `\n\n> **Barge-in (${res.filePath}:${res.lineNumber})** : ${res.question}\n`,
            );
            if (res.remainingCode) {
              await liveDriver.writeBlock({
                filePath: step.filePath,
                workspaceRoot,
                languageId: step.languageId,
                title: `${block.title} (suite)`,
                category: block.category,
                importance: block.importance,
                code: res.remainingCode,
                narration: '',
              });
            }
          }
        }
      }

      await liveDriver.finishSession(
        lang === 'fr' ? 'Implémentation terminée.' : 'Implementation complete.',
      );
      stream.markdown(
        lang === 'fr' ? '\n✅ Session MindStream terminée.' : '\n✅ MindStream session finished.',
      );
    },
  );

  participant.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg');
  return participant;
}
