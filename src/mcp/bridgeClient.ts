import * as path from 'node:path';
import { BridgeEntry, BridgeRegistry } from '../bridge/BridgeRegistry';

function normalizeDir(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function matchesWorkspace(entry: BridgeEntry, targetDir?: string): boolean {
  if (!targetDir) {
    return false;
  }
  const normalizedTarget = normalizeDir(targetDir);
  return entry.workspaceRoots.some((root) => {
    const normRoot = normalizeDir(root);
    return (
      normalizedTarget === normRoot ||
      normalizedTarget.startsWith(normRoot + '/') ||
      normRoot.startsWith(normalizedTarget + '/')
    );
  });
}

export class BridgeClient {
  constructor(private readonly registry = new BridgeRegistry()) {}

  public async findHealthyBridge(
    workspaceRoot?: string,
    pinnedBridgeId?: string,
  ): Promise<BridgeEntry | null> {
    const candidates = await this.registry.listLiveBridges();
    if (candidates.length === 0) {
      return null;
    }

    const searchTarget = workspaceRoot;
    const score = (entry: BridgeEntry): number => {
      let s = 0;
      if (searchTarget && matchesWorkspace(entry, searchTarget)) {
        s += 1000;
      }
      if (pinnedBridgeId && entry.id === pinnedBridgeId) {
        s += 100;
      }
      if (entry.focused) {
        s += 10;
      }
      return s;
    };

    const sorted = [...candidates].sort((a, b) => {
      const diff = score(b) - score(a);
      if (diff !== 0) {
        return diff;
      }
      return b.updatedAt - a.updatedAt;
    });

    for (const candidate of sorted) {
      if (await this.checkHealth(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  public async callBridge<T = Record<string, unknown>>(
    endpointPath: string,
    method: 'GET' | 'POST',
    body?: unknown,
    workspaceRoot?: string,
    pinnedBridgeId?: string,
  ): Promise<
    { ok: true; data: T; bridgeId: string } | { ok: false; reason: string }
  > {
    const bridge = await this.findHealthyBridge(workspaceRoot, pinnedBridgeId);
    if (!bridge) {
      return { ok: false, reason: 'no-bridge' };
    }

    try {
      const response = await fetch(`http://127.0.0.1:${bridge.port}${endpointPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${bridge.token}`,
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      });

      const data = (await response.json()) as T & { error?: string };
      if (!response.ok) {
        return {
          ok: false,
          reason: data?.error || `HTTP ${response.status}`,
        };
      }

      return { ok: true, data, bridgeId: bridge.id };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async checkHealth(entry: BridgeEntry): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 700);
    try {
      const res = await fetch(`http://127.0.0.1:${entry.port}/health`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${entry.token}` },
        signal: ctrl.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
