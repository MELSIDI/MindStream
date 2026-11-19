import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface RelevantFileSnippet {
  relativePath: string;
  content: string;
}

export interface WorkspaceContext {
  hasWorkspace: boolean;
  workspaceName: string;
  fileTree: string[];
  packageJsonSummary: string | null;
  activeFilePath: string | null;
  activeFileSnippet: string | null;
  relevantFiles: RelevantFileSnippet[];
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.next',
  'build',
  'coverage',
  '.vscode',
  '.turbo',
]);

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.cs',
  '.json',
  '.md',
  '.css',
  '.html',
  '.yaml',
  '.yml',
]);

export class WorkspaceAnalyzer {
  public async analyze(goalPrompt: string): Promise<WorkspaceContext> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const activeEditor = vscode.window.activeTextEditor;

    if (!folder) {
      return {
        hasWorkspace: false,
        workspaceName: 'Nouveau Projet',
        fileTree: [],
        packageJsonSummary: null,
        activeFilePath: activeEditor ? path.basename(activeEditor.document.uri.fsPath) : null,
        activeFileSnippet: activeEditor
          ? activeEditor.document.getText().slice(0, 3500)
          : null,
        relevantFiles: [],
      };
    }

    const rootPath = folder.uri.fsPath;
    const fileTree = await this.walkFiles(rootPath, rootPath, 80);
    const packageJsonSummary = await this.readPackageJsonSummary(rootPath);

    let activeFilePath: string | null = null;
    let activeFileSnippet: string | null = null;
    if (activeEditor && activeEditor.document.uri.scheme === 'file') {
      activeFilePath = path
        .relative(rootPath, activeEditor.document.uri.fsPath)
        .replace(/\\/g, '/');
      activeFileSnippet = activeEditor.document.getText().slice(0, 4000);
    }

    const keywords = goalPrompt
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3);

    const candidates = fileTree
      .filter((rel) => {
        if (rel === activeFilePath) {
          return false;
        }
        const ext = path.extname(rel).toLowerCase();
        return TEXT_EXTENSIONS.has(ext);
      })
      .map((rel) => {
        const lower = rel.toLowerCase();
        let score = 0;
        for (const kw of keywords) {
          if (lower.includes(kw)) {
            score += 3;
          }
        }
        if (lower.includes('readme') || lower.includes('index') || lower.includes('app')) {
          score += 1;
        }
        return { rel, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    const relevantFiles: RelevantFileSnippet[] = [];
    for (const item of candidates) {
      try {
        const full = path.join(rootPath, item.rel);
        const content = (await fs.readFile(full, 'utf8')).slice(0, 2500);
        relevantFiles.push({ relativePath: item.rel, content });
      } catch {
        // Skip unreadable file.
      }
    }

    return {
      hasWorkspace: true,
      workspaceName: folder.name,
      fileTree,
      packageJsonSummary,
      activeFilePath,
      activeFileSnippet,
      relevantFiles,
    };
  }

  private async walkFiles(
    rootDir: string,
    currentDir: string,
    limit: number,
  ): Promise<string[]> {
    const collected: string[] = [];

    const visit = async (dir: string): Promise<void> => {
      if (collected.length >= limit) {
        return;
      }
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (collected.length >= limit) {
          return;
        }
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) {
            continue;
          }
          await visit(path.join(dir, entry.name));
        } else if (entry.isFile()) {
          const rel = path.relative(rootDir, path.join(dir, entry.name)).replace(/\\/g, '/');
          collected.push(rel);
        }
      }
    };

    await visit(currentDir);
    return collected;
  }

  private async readPackageJsonSummary(rootDir: string): Promise<string | null> {
    try {
      const raw = await fs.readFile(path.join(rootDir, 'package.json'), 'utf8');
      const parsed = JSON.parse(raw) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      return JSON.stringify(
        {
          name: parsed.name,
          dependencies: Object.keys(parsed.dependencies ?? {}),
          devDependencies: Object.keys(parsed.devDependencies ?? {}),
          scripts: Object.keys(parsed.scripts ?? {}),
        },
        null,
        2,
      );
    } catch {
      return null;
    }
  }
}
