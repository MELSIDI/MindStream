import * as path from 'node:path';
import {
  LiveCheckpointParams,
  StartLiveSessionParams,
  WriteLiveBlockParams,
} from '../bridge/LiveAgentSessionDriver';
import { SpeedMode } from '../types/session';
import { BridgeClient } from './bridgeClient';
import { StandaloneFallback } from './standaloneFallback';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const MCP_TOOLS = [
  {
    name: 'mindstream_start_session',
    description:
      'Initialize a synchronized MindStream pair-programming session in the IDE after doing research. Presents findings briefly and starts progressive voice-explained coding.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short session title.' },
        goal: { type: 'string', description: 'User feature or task goal.' },
        language: {
          type: 'string',
          enum: ['fr', 'en'],
          description: 'Language matching the user prompt.',
        },
        workspaceRoot: {
          type: 'string',
          description: 'Absolute path to the active project workspace root.',
        },
        researchSummary: {
          type: 'string',
          description: 'Concise summary of codebase research before editing.',
        },
        findings: {
          type: 'array',
          items: { type: 'string' },
          description: 'Key files or patterns discovered.',
        },
        architectureDecisions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Short design decisions.',
        },
        spokenIntro: {
          type: 'string',
          description: 'Brief 2-sentence spoken greeting & plan intro.',
        },
        plannedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered list of relative file paths to create or update.',
        },
      },
      required: ['title', 'goal'],
    },
  },
  {
    name: 'mindstream_write_block',
    description:
      'Write a logical code block progressively into the editor while narrating WHY it is written, why its variables/parameters exist, and tracking the active line. Supports skeleton-first editing via `inside-container` (`class Foo`, `<body>`) and `insert-before`.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Relative path inside workspaceRoot (or absolute path).',
        },
        workspaceRoot: { type: 'string' },
        languageId: { type: 'string' },
        title: { type: 'string', description: 'Short block label shown in status bar.' },
        category: {
          type: 'string',
          enum: ['boilerplate', 'setup', 'core-logic', 'architecture', 'ui', 'test'],
        },
        importance: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description:
            '"low" for imports/boilerplate (Auto accelerates silently), "high" for business logic (Auto slows & narrates).',
        },
        code: {
          type: 'string',
          description: 'Exact code snippet for this logical block (end with newline).',
        },
        narration: {
          type: 'string',
          description:
            'Warm spoken explanation of WHY this block/function/class exists, why its variables exist, and how it connects to the project (2-4 natural sentences).',
        },
        shortCue: {
          type: 'string',
          description: '1-sentence summary used in 3x or Auto boilerplate mode.',
        },
        rationale: {
          type: 'string',
          description: '1-sentence architectural reason.',
        },
        insertMode: {
          type: 'string',
          enum: [
            'append',
            'replace-file',
            'replace-target',
            'insert-before',
            'inside-container',
          ],
          description:
            '"append" (EOF, default), "replace-file", "replace-target", "insert-before" (right before anchorText), or "inside-container" (inside `class Foo { }` or `<body></body>` right before closing brace/tag).',
        },
        targetText: {
          type: 'string',
          description: 'Exact existing snippet to replace when insertMode="replace-target".',
        },
        anchorText: {
          type: 'string',
          description:
            'Container header or anchor text (e.g. "class SnakeGame", "<body>", "<head>", "function render") used by insertMode="inside-container" or "insert-before".',
        },
      },
      required: ['filePath', 'title', 'code', 'narration'],
    },
  },
  {
    name: 'mindstream_checkpoint',
    description:
      'Ask the developer a quick interactive micro-validation question on an architectural choice before implementing a critical decision.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        question: { type: 'string' },
        rationale: { type: 'string' },
        relatedFilePath: { type: 'string' },
        workspaceRoot: {
          type: 'string',
          description: 'Absolute path to the active project workspace root.',
        },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              description: { type: 'string' },
              recommended: { type: 'boolean' },
            },
            required: ['label'],
          },
        },
      },
      required: ['title', 'question', 'options'],
    },
  },
  {
    name: 'mindstream_speak',
    description:
      'Speak a contextual explanation or barge-in answer aloud through MindStream without writing code.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        waitForCompletion: { type: 'boolean' },
        workspaceRoot: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'mindstream_control',
    description:
      'Adjust MindStream playback controls programmatically from chat commands (speed, pause, resume, skip, stop, mute, file_fast_pause, status).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'pause',
            'resume',
            'skip',
            'stop',
            'mute',
            'unmute',
            'set_speed',
            'file_fast_pause',
            'status',
          ],
        },
        speed: {
          type: 'string',
          enum: ['0.5x', '1x', '2x', '3x', 'auto'],
        },
        filePath: { type: 'string' },
        workspaceRoot: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'mindstream_finish_session',
    description:
      'Complete the MindStream pair-programming session cleanly and clear temporary editor highlights.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        spokenOutro: { type: 'string' },
        workspaceRoot: { type: 'string' },
      },
      required: ['summary'],
    },
  },
];

export class MindStreamMcpServer {
  private readonly bridgeClient = new BridgeClient();
  private readonly standalone = new StandaloneFallback();
  private useContentLength = false;
  private buffer = Buffer.alloc(0);

  private activeWorkspaceRoot: string | undefined;
  private pinnedBridgeId: string | undefined;

  public start(): void {
    process.stdin.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.processBuffer();
    });

    process.stdin.on('end', () => {
      this.standalone.dispose();
      process.exit(0);
    });

    process.on('SIGINT', () => {
      this.standalone.dispose();
      process.exit(0);
    });
  }

  private processBuffer(): void {
    while (this.buffer.length > 0) {
      const asAsciiPrefix = this.buffer
        .subarray(0, Math.min(32, this.buffer.length))
        .toString('ascii');
      if (asAsciiPrefix.startsWith('Content-Length:')) {
        this.useContentLength = true;
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          return;
        }
        const header = this.buffer.subarray(0, headerEnd).toString('ascii');
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
          this.buffer = this.buffer.subarray(headerEnd + 4);
          continue;
        }
        const bodyLen = Number.parseInt(match[1], 10);
        const totalLen = headerEnd + 4 + bodyLen;
        if (this.buffer.length < totalLen) {
          return;
        }
        const body = this.buffer.subarray(headerEnd + 4, totalLen).toString('utf8');
        this.buffer = this.buffer.subarray(totalLen);
        void this.handleMessageString(body);
      } else {
        const nlIdx = this.buffer.indexOf('\n');
        if (nlIdx === -1) {
          return;
        }
        const line = this.buffer.subarray(0, nlIdx).toString('utf8').trim();
        this.buffer = this.buffer.subarray(nlIdx + 1);
        if (line.length > 0) {
          void this.handleMessageString(line);
        }
      }
    }
  }

  private async handleMessageString(raw: string): Promise<void> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      return;
    }

    if (req.id === undefined || req.id === null) {
      return;
    }

    try {
      const result = await this.dispatch(req);
      this.sendResponse({ jsonrpc: '2.0', id: req.id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendResponse({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32603, message },
      });
    }
  }

  private async dispatch(req: JsonRpcRequest): Promise<unknown> {
    switch (req.method) {
      case 'initialize': {
        const clientVersion =
          typeof req.params?.protocolVersion === 'string'
            ? req.params.protocolVersion
            : '2024-11-05';
        return {
          protocolVersion: clientVersion,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'mindstream-driver',
            version: '0.2.1',
          },
        };
      }

      case 'ping':
        return {};

      case 'tools/list':
        return { tools: MCP_TOOLS };

      case 'tools/call': {
        const name = String(req.params?.name ?? '');
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const resultObj = await this.executeTool(name, args);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(resultObj),
            },
          ],
        };
      }

      default:
        throw new Error(`Unsupported MCP method: ${req.method}`);
    }
  }

  private resolveTargetWorkspace(args: Record<string, unknown>): string | undefined {
    if (typeof args.workspaceRoot === 'string' && args.workspaceRoot.trim().length > 0) {
      return args.workspaceRoot.trim();
    }
    if (typeof args.filePath === 'string' && path.isAbsolute(args.filePath)) {
      return path.dirname(args.filePath);
    }
    if (typeof args.relatedFilePath === 'string' && path.isAbsolute(args.relatedFilePath)) {
      return path.dirname(args.relatedFilePath);
    }
    return this.activeWorkspaceRoot;
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const workspaceRoot = this.resolveTargetWorkspace(args);

    switch (name) {
      case 'mindstream_start_session': {
        const params = args as unknown as StartLiveSessionParams;
        this.activeWorkspaceRoot = workspaceRoot;
        this.pinnedBridgeId = undefined;

        const res = await this.bridgeClient.callBridge(
          '/session/start',
          'POST',
          params,
          workspaceRoot,
        );
        if (res.ok) {
          this.pinnedBridgeId = res.bridgeId;
          return { bridgeMode: 'ide', ...res.data };
        }
        return this.standalone.startSession(params);
      }

      case 'mindstream_write_block': {
        const params = args as unknown as WriteLiveBlockParams;
        if (workspaceRoot && !this.activeWorkspaceRoot) {
          this.activeWorkspaceRoot = workspaceRoot;
        }
        const res = await this.bridgeClient.callBridge(
          '/session/write-block',
          'POST',
          params,
          workspaceRoot,
          this.pinnedBridgeId,
        );
        if (res.ok) {
          this.pinnedBridgeId = res.bridgeId;
          return { bridgeMode: 'ide', ...res.data };
        }
        return this.standalone.writeBlock(params);
      }

      case 'mindstream_checkpoint': {
        const params = args as unknown as LiveCheckpointParams;
        const res = await this.bridgeClient.callBridge(
          '/session/checkpoint',
          'POST',
          params,
          workspaceRoot,
          this.pinnedBridgeId,
        );
        if (res.ok) {
          this.pinnedBridgeId = res.bridgeId;
          return { bridgeMode: 'ide', ...res.data };
        }
        return this.standalone.checkpoint(params);
      }

      case 'mindstream_speak': {
        const res = await this.bridgeClient.callBridge(
          '/session/speak',
          'POST',
          args,
          workspaceRoot,
          this.pinnedBridgeId,
        );
        if (res.ok) {
          this.pinnedBridgeId = res.bridgeId;
          return { bridgeMode: 'ide', ...res.data };
        }
        return this.standalone.speak(
          String(args.text ?? ''),
          typeof args.waitForCompletion === 'boolean' ? args.waitForCompletion : true,
        );
      }

      case 'mindstream_control': {
        const res = await this.bridgeClient.callBridge(
          '/session/control',
          'POST',
          args,
          workspaceRoot,
          this.pinnedBridgeId,
        );
        if (res.ok) {
          this.pinnedBridgeId = res.bridgeId;
          return { bridgeMode: 'ide', ...res.data };
        }
        return this.standalone.control(String(args.action ?? 'status'), {
          speed: args.speed as SpeedMode | undefined,
          filePath: typeof args.filePath === 'string' ? args.filePath : undefined,
        });
      }

      case 'mindstream_finish_session': {
        const res = await this.bridgeClient.callBridge(
          '/session/finish',
          'POST',
          args,
          workspaceRoot,
          this.pinnedBridgeId,
        );
        this.pinnedBridgeId = undefined;
        if (res.ok) {
          return { bridgeMode: 'ide', ...res.data };
        }
        return this.standalone.finishSession(
          typeof args.spokenOutro === 'string' ? args.spokenOutro : undefined,
        );
      }

      default:
        throw new Error(`Unknown MindStream MCP tool: ${name}`);
    }
  }

  private sendResponse(payload: unknown): void {
    const json = JSON.stringify(payload);
    if (this.useContentLength) {
      const byteLen = Buffer.byteLength(json, 'utf8');
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
    } else {
      process.stdout.write(`${json}\n`);
    }
  }
}

new MindStreamMcpServer().start();
