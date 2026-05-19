import {
  RequestError,
  type AgentSideConnection,
  type Agent,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type ClientCapabilities,
} from '@agentclientprotocol/sdk';
import { execute, type AmpOptions, type StreamMessage } from '@ampcode/sdk';
import { convertAcpMcpServersToAmpConfig, type AmpMcpConfig } from './mcp-config.js';
import { toAcpNotifications } from './to-acp.js';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import packageJson from '../package.json';

const PACKAGE_VERSION: string = packageJson.version;

const AMP_MODES = ['smart', 'rush', 'deep'] as const;
export type AmpMode = (typeof AMP_MODES)[number];

const AMP_ACP_THINKING_ENV = 'AMP_ACP_THINKING';
const AMP_ACP_DANGEROUSLY_ALLOW_ALL_ENV = 'AMP_ACP_DANGEROUSLY_ALLOW_ALL';

// Work around @ampcode/sdk@0.1.0-2026-05-19 + @ampcode/cli@0.0.1779181266 mismatch:
// the SDK's resolveLocalAmpPackageCommand() runs `node <bin/amp.exe>`, but the new
// CLI's bin file is the native binary itself (not a JS wrapper). Point the SDK at
// the binary via AMP_CLI_PATH so it spawns it directly.
if (!process.env.AMP_CLI_PATH) {
  try {
    const req = createRequire(import.meta.url);
    const pkgJsonPath = req.resolve('@ampcode/cli/package.json');
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { bin?: { amp?: string } };
    if (pkgJson.bin?.amp) {
      const binPath = path.join(path.dirname(pkgJsonPath), pkgJson.bin.amp);
      if (fs.existsSync(binPath)) {
        process.env.AMP_CLI_PATH = binPath;
      }
    }
  } catch {
    // @ampcode/cli not resolvable at runtime (e.g. compiled binary build).
    // The SDK will fall back to $AMP_HOME/bin/amp or PATH lookup.
  }
}

interface SessionState {
  threadId: string | null;
  controller: AbortController | null;
  cancelled: boolean;
  active: boolean;
  mode: AmpMode;
  mcpConfig: AmpMcpConfig;
  cwd: string;
}

export interface AmpOptionsInput {
  cwd: string;
  mode: AmpMode;
  mcpConfig: AmpMcpConfig;
  threadId: string | null;
}

interface InitializeResponseWithAgentInfo extends InitializeResponse {
  agentInfo: {
    name: string;
    title: string;
    version: string;
  };
}

export class AmpAcpAgent implements Agent {
  private client: AgentSideConnection;
  sessions = new Map<string, SessionState>();
  private clientCapabilities?: ClientCapabilities;

  constructor(client: AgentSideConnection) {
    this.client = client;
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponseWithAgentInfo> {
    this.clientCapabilities = request.clientCapabilities;
    console.info(`[acp] amp-acp v${PACKAGE_VERSION} initialized`);
    return {
      protocolVersion: 1,
      agentInfo: {
        name: 'amp-acp',
        title: 'Amp ACP Agent',
        version: PACKAGE_VERSION,
      },
      agentCapabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
      },
      authMethods: [
        {
          id: 'setup',
          name: 'Amp API Key Setup',
          description: 'Run interactive setup to configure your Amp API key',
          _meta: {
            'terminal-auth': {
              command: getTerminalAuthCommand(),
              args: ['--setup'],
              label: 'Amp API Key Setup',
            },
          },
        },
      ],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = `S-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const mcpConfig = convertAcpMcpServersToAmpConfig(params.mcpServers);

    this.sessions.set(sessionId, {
      threadId: null,
      controller: null,
      cancelled: false,
      active: false,
      mode: 'smart',
      mcpConfig,
      cwd: params.cwd || process.cwd(),
    });

    const result: NewSessionResponse = {
      sessionId,
      modes: {
        currentModeId: 'smart',
        availableModes: [
          { id: 'smart', name: 'Smart', description: 'Balanced mode with full capabilities' },
          { id: 'rush', name: 'Rush', description: 'Faster responses with streamlined tool usage' },
          { id: 'deep', name: 'Deep', description: 'Extended reasoning for complex tasks' },
        ],
      },
    };

    setImmediate(async () => {
      try {
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              {
                name: 'init',
                description: 'Generate an AGENTS.md file for the project',
              },
            ],
          },
        });
      } catch (e) {
        console.error('[acp] failed to send available_commands_update', e);
      }
    });

    return result;
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    if (process.env.AMP_API_KEY) {
      return {};
    }
    throw RequestError.authRequired();
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error('Session not found');
    s.cancelled = false;
    s.active = true;

    let textInput = '';
    for (const chunk of params.prompt) {
      switch (chunk.type) {
        case 'text':
          if (chunk.text.trim() === '/init') {
            textInput += `Please analyze this codebase and create an AGENTS.md file containing:
1. Build/lint/test commands - especially for running a single test
2. Architecture and codebase structure information, including important subprojects, internal APIs, databases, etc.
3. Code style guidelines, including imports, conventions, formatting, types, naming conventions, error handling, etc.

The file you create will be given to agentic coding tools (such as yourself) that operate in this repository. Make it about 20 lines long.

If there are Cursor rules (in .cursor/rules/ or .cursorrules), Claude rules (CLAUDE.md), Windsurf rules (.windsurfrules), Cline rules (.clinerules), Goose rules (.goosehints), or Copilot rules (in .github/copilot-instructions.md), make sure to include them. Also, first check if there is an existing AGENTS.md or AGENT.md file, and if so, update it instead of overwriting it.`;
          } else {
            textInput += chunk.text;
          }
          break;
        case 'resource_link':
          textInput += `\n${chunk.uri}\n`;
          break;
        case 'resource':
          if ('text' in chunk.resource) {
            textInput += `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>\n`;
          }
          break;
        case 'image':
          break;
        default:
          break;
      }
    }

    const options = buildAmpOptions({
      cwd: s.cwd,
      mode: s.mode,
      mcpConfig: s.mcpConfig,
      threadId: s.threadId,
    });

    const controller = new AbortController();
    s.controller = controller;

    try {
      for await (const message of execute({ prompt: textInput, options, signal: controller.signal })) {
        if (!s.threadId && message.session_id) {
          s.threadId = message.session_id;
        }

        if (message.type === 'assistant') {
          for (const n of toAcpNotifications(message, params.sessionId)) {
            try {
              await this.client.sessionUpdate(n);
            } catch (e) {
              console.error('[acp] sessionUpdate failed', e);
            }
          }
        }

        if (message.type === 'result' && message.is_error) {
          if (typeof message.error === 'string' && isAuthError(message.error)) {
            console.error('[amp] Auth error in result, requesting authentication:', message.error);
            throw RequestError.authRequired();
          }
          await this.client.sessionUpdate({
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Error: ${message.error}` } },
          });
        }
      }

      return { stopReason: s.cancelled ? 'cancelled' : 'end_turn' };
    } catch (err) {
      if (s.cancelled || (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted')))) {
        return { stopReason: 'cancelled' };
      }
      if (err instanceof Error && isAuthError(err.message)) {
        console.error('[amp] Auth error, requesting authentication:', err.message);
        throw RequestError.authRequired();
      }
      console.error('[amp] Execution error:', err);
      throw err;
    } finally {
      s.active = false;
      s.cancelled = false;
      s.controller = null;
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const s = this.sessions.get(params.sessionId);
    if (!s) return;
    if (s.active && s.controller) {
      s.cancelled = true;
      s.controller.abort();
    }
  }

  async setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse> {
    console.warn('[amp-acp] setSessionModel not supported by @ampcode/sdk; ignoring', params.modelId);
    return {};
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error('Session not found');
    if (!isAmpMode(params.modeId)) {
      throw new RequestError(-32602, `Unknown mode: ${params.modeId}`);
    }
    s.mode = params.modeId;
    return {};
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> { return this.client.readTextFile(params); }
  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> { return this.client.writeTextFile(params); }
}

export function isAmpMode(value: unknown): value is AmpMode {
  return typeof value === 'string' && (AMP_MODES as readonly string[]).includes(value);
}

export function readBooleanEnv(
  name: string,
  defaultValue: boolean,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === '') return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return defaultValue;
}

export function buildAmpOptions(
  { cwd, mode, mcpConfig, threadId }: AmpOptionsInput,
  env: Record<string, string | undefined> = process.env,
): AmpOptions {
  const options: AmpOptions = {
    cwd,
    env: { TERM: 'dumb' },
    mode,
    thinking: readBooleanEnv(AMP_ACP_THINKING_ENV, true, env),
    ...(Object.keys(mcpConfig).length > 0 ? { mcpConfig } : {}),
    ...(threadId ? { continue: threadId } : {}),
  };

  if (readBooleanEnv(AMP_ACP_DANGEROUSLY_ALLOW_ALL_ENV, false, env)) {
    options.dangerouslyAllowAll = true;
  }

  return options;
}

export function isAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('invalid or missing api key') ||
    lower.includes("run 'amp login'") ||
    lower.includes('authentication') ||
    lower.includes('unauthorized') ||
    lower.includes('no api key found') ||
    (lower.includes('api key') && lower.includes('login flow')) ||
    (lower.includes('api key') && (lower.includes('missing') || lower.includes('invalid')));
}

export function getTerminalAuthCommand(
  argv1: string | undefined = process.argv[1],
  execPath: string = process.execPath,
): string {
  const resolvedArgv1 = argv1 ? path.resolve(argv1) : '';
  if (!resolvedArgv1 || resolvedArgv1.startsWith('/$bunfs/')) {
    return execPath;
  }
  return resolvedArgv1;
}
