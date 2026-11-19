import * as vscode from 'vscode';
import { CodingSessionPlan, LiveContextSnapshot } from '../types/session';
import {
  AIProvider,
  extractJsonObject,
  validateAndNormalizePlan,
} from './AIProvider';
import {
  buildBargeInSystemPrompt,
  buildBargeInUserPrompt,
  buildPlanGenerationSystemPrompt,
  buildPlanGenerationUserPrompt,
} from './Prompts';
import { WorkspaceContext } from './WorkspaceAnalyzer';

interface LMMessage {
  content: string;
}

interface LMChatModel {
  id: string;
  name?: string;
  sendRequest(
    messages: LMMessage[],
    options: Record<string, unknown>,
    token: vscode.CancellationToken,
  ): Promise<{ text: AsyncIterable<string> }>;
}

interface VscodeLmNamespace {
  selectChatModels?(selector?: Record<string, unknown>): Promise<LMChatModel[]>;
  LanguageModelChatMessage?: {
    User(content: string): LMMessage;
    Assistant(content: string): LMMessage;
  };
}

function getLmNamespace(): VscodeLmNamespace | null {
  const ns = (vscode as unknown as { lm?: VscodeLmNamespace }).lm;
  if (!ns || typeof ns.selectChatModels !== 'function') {
    return null;
  }
  return ns;
}

export class VSCodeLMProvider implements AIProvider {
  public readonly name = 'VS Code / IDE Language Model';

  public static async isAvailable(): Promise<boolean> {
    const ns = getLmNamespace();
    if (!ns?.selectChatModels) {
      return false;
    }
    try {
      const models = await ns.selectChatModels();
      return models.length > 0;
    } catch {
      return false;
    }
  }

  public async generatePlan(
    goal: string,
    context: WorkspaceContext,
    lang: 'fr' | 'en',
  ): Promise<CodingSessionPlan> {
    const prompt = `${buildPlanGenerationSystemPrompt(lang)}\n\n${buildPlanGenerationUserPrompt(goal, context, lang)}`;
    const raw = await this.sendPrompt(prompt);
    const parsed = extractJsonObject(raw);
    return validateAndNormalizePlan(parsed, goal, lang);
  }

  public async answerQuestion(
    question: string,
    snapshot: LiveContextSnapshot,
    plan: CodingSessionPlan,
    customOptionHint?: string,
  ): Promise<string> {
    const prompt = `${buildBargeInSystemPrompt(plan.language)}\n\n${buildBargeInUserPrompt(question, snapshot, plan, customOptionHint)}`;
    return (await this.sendPrompt(prompt)).trim();
  }

  private async sendPrompt(prompt: string): Promise<string> {
    const ns = getLmNamespace();
    if (!ns?.selectChatModels) {
      throw new Error('VS Code Language Model API is not available in this host.');
    }

    const models = await ns.selectChatModels();
    const model = models[0];
    if (!model) {
      throw new Error('No IDE language model available.');
    }

    const msgBuilder = (
      vscode as unknown as {
        LanguageModelChatMessage?: { User(content: string): LMMessage };
      }
    ).LanguageModelChatMessage;

    const messages: LMMessage[] = [
      msgBuilder ? msgBuilder.User(prompt) : { content: prompt },
    ];

    const tokenSource = new vscode.CancellationTokenSource();
    try {
      const response = await model.sendRequest(messages, {}, tokenSource.token);
      let out = '';
      for await (const chunk of response.text) {
        out += chunk;
      }
      return out;
    } finally {
      tokenSource.dispose();
    }
  }
}
