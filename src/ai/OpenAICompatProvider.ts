import { CodingSessionPlan, LiveContextSnapshot } from '../types/session';
import { detectLanguage } from '../voice/LanguageDetector';
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

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

export class OpenAICompatProvider implements AIProvider {
  public readonly name: string;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.openai.com/v1',
    private readonly model = 'gpt-4o-mini',
  ) {
    this.name = `OpenAI-Compatible (${model})`;
  }

  public async generatePlan(
    goal: string,
    context: WorkspaceContext,
    lang: 'fr' | 'en',
  ): Promise<CodingSessionPlan> {
    const raw = await this.chat(
      [
        { role: 'system', content: buildPlanGenerationSystemPrompt(lang) },
        { role: 'user', content: buildPlanGenerationUserPrompt(goal, context, lang) },
      ],
      true,
    );
    const parsed = extractJsonObject(raw);
    return validateAndNormalizePlan(parsed, goal, lang);
  }

  public async answerQuestion(
    question: string,
    snapshot: LiveContextSnapshot,
    plan: CodingSessionPlan,
    customOptionHint?: string,
  ): Promise<string> {
    const answerLang = detectLanguage(question, plan.language).language;
    return (
      await this.chat(
        [
          { role: 'system', content: buildBargeInSystemPrompt(answerLang) },
          {
            role: 'user',
            content: buildBargeInUserPrompt(question, snapshot, plan, customOptionHint),
          },
        ],
        false,
      )
    ).trim();
  }

  private async chat(
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    jsonMode: boolean,
  ): Promise<string> {
    const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: jsonMode ? 0.35 : 0.45,
    };

    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });

    const data = (await res.json()) as ChatCompletionResponse;
    if (!res.ok) {
      throw new Error(data.error?.message || `HTTP ${res.status}`);
    }

    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error('Empty response from OpenAI-compatible endpoint.');
    }
    return text;
  }
}
