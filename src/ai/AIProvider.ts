import {
  BlockCategory,
  BlockImportance,
  CheckpointOption,
  CheckpointStep,
  CodeBlock,
  CodingSessionPlan,
  FileStep,
  LiveContextSnapshot,
  SessionStep,
} from '../types/session';
import { WorkspaceContext } from './WorkspaceAnalyzer';

export interface AIProvider {
  readonly name: string;
  generatePlan(
    goal: string,
    context: WorkspaceContext,
    lang: 'fr' | 'en',
  ): Promise<CodingSessionPlan>;
  answerQuestion(
    question: string,
    snapshot: LiveContextSnapshot,
    plan: CodingSessionPlan,
    customOptionHint?: string,
  ): Promise<string>;
  transcribeAudio?(
    base64Audio: string,
    mimeType: string,
    lang: 'fr' | 'en',
  ): Promise<string>;
}

const VALID_CATEGORIES = new Set<BlockCategory>([
  'boilerplate',
  'setup',
  'core-logic',
  'architecture',
  'ui',
  'test',
]);

const VALID_IMPORTANCE = new Set<BlockImportance>(['low', 'medium', 'high']);

export function sanitizeRelativePath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/').trim().replace(/^\/+/, '');
  const segments = normalized.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.length === 0 || segments.some((s) => s === '..')) {
    throw new Error(`Invalid relative file path in AI plan: "${rawPath}"`);
  }
  return segments.join('/');
}

export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const withoutFences = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(withoutFences);
  } catch {
    const firstBrace = withoutFences.indexOf('{');
    const lastBrace = withoutFences.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(withoutFences.slice(firstBrace, lastBrace + 1));
    }
    throw new Error('The AI response did not contain a valid JSON object.');
  }
}

export function validateAndNormalizePlan(
  raw: unknown,
  goal: string,
  lang: 'fr' | 'en',
): CodingSessionPlan {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid AI plan: expected an object.');
  }

  const obj = raw as Record<string, unknown>;
  const rawResearch = (obj.research ?? {}) as Record<string, unknown>;
  const rawSteps = Array.isArray(obj.steps) ? obj.steps : [];

  if (rawSteps.length === 0) {
    throw new Error('Invalid AI plan: steps array is empty.');
  }

  const steps: SessionStep[] = rawSteps.map((rawStep, stepIdx): SessionStep => {
    const step = (rawStep ?? {}) as Record<string, unknown>;
    if (step.kind === 'checkpoint') {
      const rawOptions = Array.isArray(step.options) ? step.options : [];
      const options: CheckpointOption[] = rawOptions
        .filter((o): o is Record<string, unknown> => Boolean(o && typeof o === 'object'))
        .map((o, optIdx) => ({
          id: typeof o.id === 'string' && o.id ? o.id : `opt-${stepIdx}-${optIdx}`,
          label:
            typeof o.label === 'string' && o.label
              ? o.label
              : lang === 'fr'
                ? `Option ${optIdx + 1}`
                : `Option ${optIdx + 1}`,
          description: typeof o.description === 'string' ? o.description : '',
          recommended: Boolean(o.recommended),
          variantKey: typeof o.variantKey === 'string' ? o.variantKey : undefined,
          aiReaction: typeof o.aiReaction === 'string' ? o.aiReaction : undefined,
        }));

      if (options.length === 0) {
        options.push({
          id: `opt-${stepIdx}-continue`,
          label: lang === 'fr' ? 'Valider et continuer' : 'Confirm & continue',
          description: '',
          recommended: true,
        });
      }

      const ck: CheckpointStep = {
        kind: 'checkpoint',
        id: typeof step.id === 'string' && step.id ? step.id : `checkpoint-${stepIdx}`,
        title:
          typeof step.title === 'string' && step.title
            ? step.title
            : lang === 'fr'
              ? 'Validation technique'
              : 'Architecture check-in',
        question:
          typeof step.question === 'string' && step.question
            ? step.question
            : lang === 'fr'
              ? 'Cette approche te convient-elle pour la suite ?'
              : 'Does this approach look good to proceed?',
        rationale: typeof step.rationale === 'string' ? step.rationale : '',
        options,
        relatedFilePath:
          typeof step.relatedFilePath === 'string' && step.relatedFilePath
            ? sanitizeRelativePath(step.relatedFilePath)
            : undefined,
      };
      return ck;
    }

    const filePath = sanitizeRelativePath(
      typeof step.filePath === 'string' && step.filePath
        ? step.filePath
        : `file_${stepIdx + 1}.ts`,
    );

    const rawBlocks = Array.isArray(step.blocks) ? step.blocks : [];
    const blocks: CodeBlock[] = rawBlocks
      .filter((b): b is Record<string, unknown> => Boolean(b && typeof b === 'object'))
      .map((b, bIdx) => {
        const rawCode = typeof b.code === 'string' ? b.code : '';
        const normalizedCode = rawCode.endsWith('\n') || rawCode.length === 0 ? rawCode : `${rawCode}\n`;
        const category = VALID_CATEGORIES.has(b.category as BlockCategory)
          ? (b.category as BlockCategory)
          : 'core-logic';
        const importance = VALID_IMPORTANCE.has(b.importance as BlockImportance)
          ? (b.importance as BlockImportance)
          : undefined;

        return {
          id: typeof b.id === 'string' && b.id ? b.id : `${filePath}-b${bIdx + 1}`,
          title:
            typeof b.title === 'string' && b.title
              ? b.title
              : `${lang === 'fr' ? 'Bloc' : 'Block'} ${bIdx + 1}`,
          category,
          importance,
          code: normalizedCode,
          narration:
            typeof b.narration === 'string' && b.narration
              ? b.narration
              : typeof b.rationale === 'string'
                ? b.rationale
                : '',
          shortCue: typeof b.shortCue === 'string' ? b.shortCue : undefined,
          rationale:
            typeof b.rationale === 'string' && b.rationale
              ? b.rationale
              : typeof b.narration === 'string'
                ? b.narration
                : '',
        };
      })
      .filter((b) => b.code.length > 0);

    if (blocks.length === 0) {
      blocks.push({
        id: `${filePath}-b1`,
        title: filePath,
        category: 'setup',
        importance: 'medium',
        code: `// ${filePath}\n`,
        narration:
          lang === 'fr'
            ? `Initialisation du fichier ${filePath}.`
            : `Initializing ${filePath}.`,
        rationale:
          lang === 'fr'
            ? `Point d'entrée du fichier ${filePath}.`
            : `Initial scaffold for ${filePath}.`,
      });
    }

    const fileStep: FileStep = {
      kind: 'file',
      id: typeof step.id === 'string' && step.id ? step.id : `file-${stepIdx}`,
      filePath,
      languageId:
        typeof step.languageId === 'string' && step.languageId
          ? step.languageId
          : inferLanguageId(filePath),
      summary: typeof step.summary === 'string' ? step.summary : filePath,
      blocks,
    };

    return fileStep;
  });

  const rootSubdirRaw = typeof obj.rootSubdir === 'string' ? obj.rootSubdir.trim() : '';
  const rootSubdir =
    rootSubdirRaw && !rootSubdirRaw.includes('..')
      ? rootSubdirRaw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      : '';

  const findings = Array.isArray(rawResearch.findings)
    ? rawResearch.findings.filter((x): x is string => typeof x === 'string')
    : [];
  const architectureDecisions = Array.isArray(rawResearch.architectureDecisions)
    ? rawResearch.architectureDecisions.filter((x): x is string => typeof x === 'string')
    : [];

  return {
    id: `live-${Date.now()}`,
    title:
      typeof obj.title === 'string' && obj.title
        ? obj.title
        : goal.slice(0, 60),
    goal,
    isDemo: false,
    language: lang,
    rootSubdir,
    research: {
      summary:
        typeof rawResearch.summary === 'string' && rawResearch.summary
          ? rawResearch.summary
          : goal,
      findings,
      architectureDecisions,
      spokenIntro:
        typeof rawResearch.spokenIntro === 'string' && rawResearch.spokenIntro
          ? rawResearch.spokenIntro
          : typeof rawResearch.summary === 'string'
            ? rawResearch.summary
            : goal,
    },
    steps,
  };
}

function inferLanguageId(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx')) return 'javascript';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.html')) return 'html';
  return 'plaintext';
}

export const SECRET_GEMINI_API_KEY = 'codepace.geminiApiKey';
export const SECRET_OPENAI_API_KEY = 'codepace.openaiApiKey';

export type AIProviderChoice = 'auto' | 'gemini' | 'openai-compatible' | 'vscode-lm' | 'demo';

export interface AIProviderSettings {
  choice: AIProviderChoice;
  geminiApiKey?: string;
  geminiModel: string;
  openaiApiKey?: string;
  openaiBaseUrl: string;
  openaiModel: string;
}

import { GeminiProvider } from './GeminiProvider';
import { OpenAICompatProvider } from './OpenAICompatProvider';
import { VSCodeLMProvider } from './VSCodeLMProvider';

export class AIProviderFactory {
  public static async resolve(settings: AIProviderSettings): Promise<AIProvider | null> {
    if (settings.choice === 'demo') {
      return null;
    }

    if (settings.choice === 'gemini') {
      return settings.geminiApiKey
        ? new GeminiProvider(settings.geminiApiKey, settings.geminiModel)
        : null;
    }

    if (settings.choice === 'openai-compatible') {
      if (settings.openaiApiKey || settings.openaiBaseUrl.includes('localhost') || settings.openaiBaseUrl.includes('127.0.0.1')) {
        return new OpenAICompatProvider(
          settings.openaiApiKey ?? '',
          settings.openaiBaseUrl,
          settings.openaiModel,
        );
      }
      return null;
    }

    if (settings.choice === 'vscode-lm') {
      return (await VSCodeLMProvider.isAvailable()) ? new VSCodeLMProvider() : null;
    }

    // Auto resolution order: Gemini -> OpenAI-Compatible -> VS Code LM
    if (settings.geminiApiKey) {
      return new GeminiProvider(settings.geminiApiKey, settings.geminiModel);
    }
    if (settings.openaiApiKey) {
      return new OpenAICompatProvider(
        settings.openaiApiKey,
        settings.openaiBaseUrl,
        settings.openaiModel,
      );
    }
    if (await VSCodeLMProvider.isAvailable()) {
      return new VSCodeLMProvider();
    }

    return null;
  }
}

