import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { DemoQAEngine } from '../src/demo/DemoQAEngine';
import { buildDemoSessionPlan } from '../src/demo/DemoSessionBuilder';
import { CodingSessionPlan, FileStep, LiveContextSnapshot } from '../src/types/session';

const execFileAsync = promisify(execFile);

function assembleDemoFiles(
  plan: CodingSessionPlan,
  activeVariants: Set<string>,
): Map<string, string> {
  const files = new Map<string, string>();

  for (const step of plan.steps) {
    if (step.kind !== 'file') {
      continue;
    }
    const fileStep = step as FileStep;
    let content = '';
    for (const block of fileStep.blocks) {
      let code = block.code;
      if (block.variants) {
        for (const variantKey of activeVariants) {
          const override = block.variants[variantKey];
          if (override) {
            code = override.code;
            break;
          }
        }
      }
      content += code;
    }
    files.set(fileStep.filePath, content);
  }

  return files;
}

describe('DemoSessionBuilder & DemoQAEngine', () => {
  it('builds complete FR and EN demo plans with research and 2 branching checkpoints', () => {
    const fr = buildDemoSessionPlan('fr');
    const en = buildDemoSessionPlan('en');

    expect(fr.isDemo).toBe(true);
    expect(fr.research.findings.length).toBeGreaterThanOrEqual(3);
    expect(fr.steps.filter((s) => s.kind === 'checkpoint')).toHaveLength(2);
    expect(fr.steps.filter((s) => s.kind === 'file')).toHaveLength(4);

    expect(en.isDemo).toBe(true);
    expect(en.steps.filter((s) => s.kind === 'checkpoint')).toHaveLength(2);
    expect(en.steps.filter((s) => s.kind === 'file')).toHaveLength(4);
  });

  it('answers Barge-in questions accurately using block hints and line-level construct analysis', async () => {
    const plan = buildDemoSessionPlan('fr');
    const qa = new DemoQAEngine();

    const snapshot: LiveContextSnapshot = {
      filePath: 'taskStore.ts',
      lineNumber: 12,
      column: 5,
      blockId: 'store-subscribe',
      blockTitle: 'Abonnement réactif avec fonction de nettoyage',
      blockRationale: 'Évite les fuites mémoire.',
      codeWrittenSoFar: '  public subscribe(listener: StoreListener<readonly FocusTask[]>): () => void {\n    return () => { this.listeners.delete(listener); };',
      remainingCode: '',
      currentLineText: '    return () => {',
      surroundingLines: '▶ 12:     return () => {',
      currentSentence: 'Je retourne une fonction de nettoyage.',
      fullNarration: 'Voici le cœur réactif.',
    };

    const answerSubscribe = await qa.answerQuestion(
      'Pourquoi tu retournes une fonction dans subscribe ici ?',
      snapshot,
      plan,
    );
    expect(answerSubscribe).toContain('closure');
    expect(answerSubscribe).toContain('ligne 12');

    const mapSnapshot: LiveContextSnapshot = {
      ...snapshot,
      blockId: 'store-imports',
      lineNumber: 4,
      currentLineText: '  private readonly tasks = new Map<string, FocusTask>();',
      codeWrittenSoFar: '  private readonly tasks = new Map<string, FocusTask>();',
    };
    const answerMap = await qa.answerQuestion('Pourquoi Map ici ?', mapSnapshot, plan);
    expect(answerMap).toContain('O(1)');
  });

  it('produces valid, runnable TypeScript for both default and alternative checkpoint variants', async () => {
    const plan = buildDemoSessionPlan('fr');
    const variantCombos = [
      new Set<string>(['immutable', 'drift-safe']),
      new Set<string>(['mutable', 'simple-ticks']),
    ];

    for (const combo of variantCombos) {
      const files = assembleDemoFiles(plan, combo);
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstream-demo-verify-'));

      try {
        for (const [relPath, content] of files.entries()) {
          const full = path.join(tmpDir, relPath);
          await fs.writeFile(full, content, 'utf8');
        }

        // 1. Verify TypeScript semantic & syntactic typecheck with strict compiler
        const fileNames = Array.from(files.keys()).map((f) => path.join(tmpDir, f));
        const program = ts.createProgram(fileNames, {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
          types: [],
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          skipLibCheck: true,
        });
        const diagnostics = ts.getPreEmitDiagnostics(program);
        const formatted = diagnostics.map((d) =>
          ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        );
        expect(formatted).toEqual([]);

        // 2. Verify Node 24 executes the generated demoRunner.ts directly
        const { stdout } = await execFileAsync(process.execPath, [
          path.join(tmpDir, 'demoRunner.ts'),
        ]);
        expect(stdout).toContain('FocusFlow prêt:');
        expect(stdout).toContain('[done]');
        expect(stdout).toContain('cycles=1');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    }
  }, 25000);
});
