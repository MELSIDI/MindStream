import { GoogleGenAI } from '@google/genai';
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

export class GeminiProvider implements AIProvider {
  public readonly name: string;
  private readonly client: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly model = 'gemini-4-hydrogen',
  ) {
    this.client = new GoogleGenAI({ apiKey });
    this.name = `Gemini (${model})`;
  }

  public async generatePlan(
    goal: string,
    context: WorkspaceContext,
    lang: 'fr' | 'en',
  ): Promise<CodingSessionPlan> {
    const interaction = await this.client.interactions.create({
      model: this.model,
      system_instruction: buildPlanGenerationSystemPrompt(lang),
      input: buildPlanGenerationUserPrompt(goal, context, lang),
      response_format: {
        type: 'text',
        mime_type: 'application/json',
      },
    });

    const text = interaction.output_text ?? '';
    const parsed = extractJsonObject(text);
    return validateAndNormalizePlan(parsed, goal, lang);
  }

  public async answerQuestion(
    question: string,
    snapshot: LiveContextSnapshot,
    plan: CodingSessionPlan,
    customOptionHint?: string,
  ): Promise<string> {
    const answerLang = detectLanguage(question, plan.language).language;
    const interaction = await this.client.interactions.create({
      model: this.model,
      system_instruction: buildBargeInSystemPrompt(answerLang),
      input: buildBargeInUserPrompt(question, snapshot, plan, customOptionHint),
    });

    const text = (interaction.output_text ?? '').trim();
    if (!text) {
      throw new Error('Empty response from Gemini.');
    }
    return text;
  }

  public async transcribeAudio(
    base64Audio: string,
    mimeType: string,
    lang: 'fr' | 'en',
  ): Promise<string> {
    const interaction = await this.client.interactions.create({
      model: 'gemini-3.5-transcribe',
      input: [
        {
          type: 'text',
          text:
            lang === 'fr'
              ? 'Transcris fidèlement la question du développeur en français.'
              : 'Accurately transcribe the developer question in English.',
        },
        {
          type: 'audio',
          data: base64Audio,
          mime_type: mimeType,
        },
      ],
    });

    return (interaction.output_text ?? '').trim();
  }
}
