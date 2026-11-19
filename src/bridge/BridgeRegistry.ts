import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface BridgeEntry {
  id: string;
  pid: number;
  port: number;
  token: string;
  workspaceRoots: string[];
  focused?: boolean;
  updatedAt: number;
}

interface BridgeRegistryFile {
  bridges: BridgeEntry[];
}

export function getDefaultRegistryPath(): string {
  return (
    process.env.CODEPACE_REGISTRY_PATH ||
    path.join(os.homedir(), '.codepace', 'bridges.json')
  );
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists even if signaling is denied.
    return code === 'EPERM';
  }
}

export class BridgeRegistry {
  constructor(private readonly filePath = getDefaultRegistryPath()) {}

  public async registerBridge(entry: BridgeEntry): Promise<void> {
    const current = await this.readRaw();
    const alive = current.bridges.filter(
      (b) => b.id !== entry.id && isPidAlive(b.pid),
    );
    alive.push(entry);
    await this.writeRaw({ bridges: alive });
  }

  public async unregisterBridge(id: string): Promise<void> {
    const current = await this.readRaw();
    const next = current.bridges.filter((b) => b.id !== id && isPidAlive(b.pid));
    await this.writeRaw({ bridges: next });
  }

  public async listLiveBridges(): Promise<BridgeEntry[]> {
    const current = await this.readRaw();
    return current.bridges
      .filter((b) => isPidAlive(b.pid))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async readRaw(): Promise<BridgeRegistryFile> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<BridgeRegistryFile>;
      return {
        bridges: Array.isArray(parsed.bridges) ? parsed.bridges : [],
      };
    } catch {
      return { bridges: [] };
    }
  }

  private async writeRaw(data: BridgeRegistryFile): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    try {
      await fs.rename(tmpPath, this.filePath);
    } catch {
      await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8');
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }
}
