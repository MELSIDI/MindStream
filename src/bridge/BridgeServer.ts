import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { BridgeEntry, BridgeRegistry } from './BridgeRegistry';
import {
  LiveAgentSessionDriver,
  LiveCheckpointParams,
  StartLiveSessionParams,
  WriteLiveBlockParams,
} from './LiveAgentSessionDriver';
import { LanguageSetting, SpeedMode } from '../types/session';

export class BridgeServer {
  private readonly id = `bridge-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  private readonly token = crypto.randomBytes(24).toString('hex');
  private server: http.Server | null = null;
  private port = 0;
  private focused = false;

  constructor(
    private readonly driver: LiveAgentSessionDriver,
    private readonly getWorkspaceRoots: () => string[],
    private readonly registry = new BridgeRegistry(),
  ) {}

  public getPort(): number {
    return this.port;
  }

  public getToken(): string {
    return this.token;
  }

  public async start(): Promise<BridgeEntry> {
    if (this.server) {
      return this.buildEntry();
    }

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    // Long pauses or checkpoints can take minutes while user reads code.
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    const entry = this.buildEntry();
    await this.registry.registerBridge(entry);
    return entry;
  }

  public async updateWorkspaces(): Promise<void> {
    if (!this.server || this.port <= 0) {
      return;
    }
    await this.registry.registerBridge(this.buildEntry());
  }

  public async setFocused(focused: boolean): Promise<void> {
    this.focused = focused;
    if (!this.server || this.port <= 0) {
      return;
    }
    await this.registry.registerBridge(this.buildEntry());
  }

  public async dispose(): Promise<void> {
    await this.registry.unregisterBridge(this.id).catch(() => undefined);
    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
      });
    }
  }

  private buildEntry(): BridgeEntry {
    return {
      id: this.id,
      pid: process.pid,
      port: this.port,
      token: this.token,
      workspaceRoots: this.getWorkspaceRoots(),
      focused: this.focused,
      updatedAt: Date.now(),
    };
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${this.token}`) {
      this.sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    try {
      if (method === 'GET' && url === '/health') {
        this.sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          workspaces: this.getWorkspaceRoots(),
        });
        return;
      }

      if (method === 'GET' && url === '/session/status') {
        const state = this.driver.getUIState();
        this.sendJson(res, 200, {
          playbackState: state.playbackState,
          speedMode: state.speedMode,
          muted: state.muted,
          currentFilePath: state.currentFilePath,
          currentLineNumber: state.currentLineNumber,
          fileStopTarget: state.fileStopTarget,
        });
        return;
      }

      if (method !== 'POST') {
        this.sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      const body = await this.readJsonBody(req);

      if (url === '/session/start') {
        const result = await this.driver.startSession(
          body as unknown as StartLiveSessionParams,
        );
        this.sendJson(res, 200, result);
        return;
      }

      if (url === '/session/write-block') {
        const result = await this.driver.writeBlock(
          body as unknown as WriteLiveBlockParams,
        );
        this.sendJson(res, 200, result);
        return;
      }

      if (url === '/session/checkpoint') {
        const result = await this.driver.askCheckpoint(
          body as unknown as LiveCheckpointParams,
        );
        this.sendJson(res, 200, result);
        return;
      }

      if (url === '/session/speak') {
        const text = typeof body.text === 'string' ? body.text : '';
        const waitForCompletion =
          typeof body.waitForCompletion === 'boolean' ? body.waitForCompletion : true;
        const language =
          body.language === 'auto' || body.language === 'fr' || body.language === 'en'
            ? (body.language as LanguageSetting)
            : undefined;
        const result = await this.driver.speak(text, waitForCompletion, language);
        this.sendJson(res, 200, result);
        return;
      }

      if (url === '/session/control') {
        const action = String(body.action ?? 'status') as Parameters<
          LiveAgentSessionDriver['applyControl']
        >[0];
        const result = this.driver.applyControl(action, {
          speed: body.speed as SpeedMode | undefined,
          filePath: typeof body.filePath === 'string' ? body.filePath : undefined,
        });
        this.sendJson(res, 200, result);
        return;
      }

      if (url === '/session/finish') {
        const summary = typeof body.summary === 'string' ? body.summary : '';
        const spokenOutro =
          typeof body.spokenOutro === 'string' ? body.spokenOutro : undefined;
        const result = await this.driver.finishSession(summary, spokenOutro);
        this.sendJson(res, 200, result);
        return;
      }

      this.sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendJson(res, 500, { error: message });
    }
  }

  private async readJsonBody(
    req: http.IncomingMessage,
  ): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) as Record<string, unknown>;
  }

  private sendJson(
    res: http.ServerResponse,
    statusCode: number,
    payload: unknown,
  ): void {
    const json = JSON.stringify(payload);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
  }
}
