import { CodingSessionPlan, LiveContextSnapshot } from '../types/session';
import { WorkspaceContext } from './WorkspaceAnalyzer';

export function buildPlanGenerationSystemPrompt(lang: 'fr' | 'en'): string {
  const languageDirective =
    lang === 'fr'
      ? 'All spoken narration, research findings, checkpoint questions, titles, and rationales MUST be written in natural, warm, conversational French (tutoiement preferred like a collaborative teammate).'
      : 'All spoken narration, research findings, checkpoint questions, titles, and rationales MUST be written in natural, warm, conversational English.';

  return [
    'You are MindStream, an interactive Pair-Programming AI mentor.',
    'Unlike standard coding agents that dump hundreds of lines silently, you design a progressive, human-paced implementation plan.',
    languageDirective,
    '',
    'CRITICAL RULES:',
    '1. Return ONLY a single valid JSON object matching the schema below (no markdown fences, no commentary outside JSON).',
    '2. Perform brief "Research before action" first: summarize findings from the workspace and architectural decisions before any code.',
    '3. Split every file into 2-5 logical CodeBlocks:',
    '   - Use importance="low" (category="boilerplate") for imports, repetitive types, or simple constants so Smart Auto mode can fast-forward cleanly.',
    '   - Use importance="high" (category="core-logic" or "architecture") for business logic, state management, concurrency, or error handling.',
    '4. Every CodeBlock MUST include:',
    '   - narration: conversational spoken explanation focused on WHY this approach is chosen and how pieces fit together (2-4 clear spoken sentences, avoid reading punctuation literally).',
    '   - shortCue: brief 1-sentence cue for fast/auto modes.',
    '   - rationale: concise 1-sentence architectural reason.',
    '   - code: valid, idiomatic code ending with a newline "\\n".',
    '5. Include 1 or 2 CheckpointSteps on genuine architectural trade-offs so the developer stays actively involved.',
    '6. File paths MUST be relative (no ".." or leading "/"). Place new files neatly inside rootSubdir (e.g. "src" or "" if filePaths already start with src/).',
    '',
    'JSON SCHEMA:',
    '{',
    '  "title": "string",',
    '  "rootSubdir": "string (empty string if filePaths are relative to workspace root)",',
    '  "research": {',
    '    "summary": "string",',
    '    "findings": ["string"],',
    '    "architectureDecisions": ["string"],',
    '    "spokenIntro": "string"',
    '  },',
    '  "steps": [',
    '    {',
    '      "kind": "file",',
    '      "id": "string",',
    '      "filePath": "string",',
    '      "languageId": "typescript|javascript|python|...",',
    '      "summary": "string",',
    '      "blocks": [',
    '        {',
    '          "id": "string",',
    '          "title": "string",',
    '          "category": "boilerplate|setup|core-logic|architecture|ui|test",',
    '          "importance": "low|medium|high",',
    '          "code": "string",',
    '          "narration": "string",',
    '          "shortCue": "string",',
    '          "rationale": "string"',
    '        }',
    '      ]',
    '    },',
    '    {',
    '      "kind": "checkpoint",',
    '      "id": "string",',
    '      "title": "string",',
    '      "question": "string",',
    '      "rationale": "string",',
    '      "relatedFilePath": "string",',
    '      "options": [',
    '        {',
    '          "id": "string",',
    '          "label": "string",',
    '          "description": "string",',
    '          "recommended": true,',
    '          "aiReaction": "string"',
    '        }',
    '      ]',
    '    }',
    '  ]',
    '}',
  ].join('\n');
}

export function buildPlanGenerationUserPrompt(
  goal: string,
  ctx: WorkspaceContext,
  lang: 'fr' | 'en',
): string {
  const sections: string[] = [
    `USER GOAL (${lang}): ${goal}`,
    `WORKSPACE: ${ctx.workspaceName} (hasWorkspace=${ctx.hasWorkspace})`,
  ];

  if (ctx.packageJsonSummary) {
    sections.push(`PACKAGE.JSON:\n${ctx.packageJsonSummary}`);
  }

  if (ctx.fileTree.length > 0) {
    sections.push(`FILES IN WORKSPACE (sample):\n${ctx.fileTree.slice(0, 45).join('\n')}`);
  }

  if (ctx.activeFilePath && ctx.activeFileSnippet) {
    sections.push(
      `ACTIVE EDITOR FILE (${ctx.activeFilePath}):\n${ctx.activeFileSnippet}`,
    );
  }

  if (ctx.relevantFiles.length > 0) {
    for (const f of ctx.relevantFiles) {
      sections.push(`RELEVANT FILE (${f.relativePath}):\n${f.content}`);
    }
  }

  return sections.join('\n\n');
}

export function buildBargeInSystemPrompt(lang: 'fr' | 'en'): string {
  return lang === 'fr'
    ? [
        'Tu es MindStream, un binôme de Pair-Programming humain et pédagogue.',
        "L'utilisateur vient de t'interrompre en pleine écriture de code (barge-in) pour poser une question.",
        'Réponds directement, chaleureusement et clairement en 2 à 4 phrases courtes prêtes à être lues à voix haute.',
        "Base ta réponse UNIQUEMENT sur le contexte exact (fichier, numéro de ligne, code écrit, code à venir et justification) fourni ci-dessous.",
        'Évite les longs blocs Markdown ou de réciter des symboles littéraux inutilement; termine en indiquant brièvement que tu es prêt à reprendre dès son feu vert.',
      ].join('\n')
    : [
        'You are MindStream, a supportive human-paced pair programmer.',
        'The developer just interrupted you mid-typing (barge-in) to ask a question.',
        'Answer directly, warmly, and clearly in 2 to 4 concise spoken sentences.',
        'Ground your explanation strictly in the exact file, line number, written/remaining code, and rationale below.',
        'Avoid long markdown blocks and end by briefly confirming you are ready to resume on their signal.',
      ].join('\n');
}

export function buildBargeInUserPrompt(
  question: string,
  snapshot: LiveContextSnapshot,
  plan: CodingSessionPlan,
  customOptionHint?: string,
): string {
  return [
    `SESSION: ${plan.title} — Goal: ${plan.goal}`,
    `FILE: ${snapshot.filePath} (Line ${snapshot.lineNumber}, Column ${snapshot.column})`,
    `ACTIVE BLOCK: ${snapshot.blockTitle}`,
    `ARCHITECTURAL RATIONALE: ${snapshot.blockRationale}`,
    `CURRENT LINE TEXT: ${snapshot.currentLineText}`,
    `SURROUNDING LINES:\n${snapshot.surroundingLines}`,
    `CODE WRITTEN SO FAR IN BLOCK:\n${snapshot.codeWrittenSoFar}`,
    `REMAINING CODE IN BLOCK:\n${snapshot.remainingCode}`,
    `NARRATION BEING SPOKEN WHEN INTERRUPTED: ${snapshot.currentSentence}`,
    customOptionHint ? `CHOSEN OPTION CONTEXT: ${customOptionHint}` : '',
    `USER QUESTION: ${question}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
