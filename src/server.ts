import {
  RequestError,
  type AgentSideConnection,
  type Agent,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
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

type AssistantStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | null;
type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
import { convertAcpMcpServersToAmpConfig, type AmpMcpConfig } from './mcp-config.js';
import { toAcpNotifications } from './to-acp.js';
import {
  getSessionStorePaths,
  recordSession,
  lookupSession,
  appendLogEntry,
  readLog,
  type SessionStorePaths,
} from './session-store.js';
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

function buildModeState(currentModeId: AmpMode): NonNullable<NewSessionResponse['modes']> {
  return {
    currentModeId,
    availableModes: [
      { id: 'smart', name: 'Smart', description: 'Balanced mode with full capabilities' },
      { id: 'rush', name: 'Rush', description: 'Faster responses with streamlined tool usage' },
      { id: 'deep', name: 'Deep', description: 'Extended reasoning for complex tasks' },
    ],
  };
}

export class AmpAcpAgent implements Agent {
  private client: AgentSideConnection;
  sessions = new Map<string, SessionState>();
  private clientCapabilities?: ClientCapabilities;
  private storePaths: SessionStorePaths;

  constructor(client: AgentSideConnection, storePaths: SessionStorePaths = getSessionStorePaths()) {
    this.client = client;
    this.storePaths = storePaths;
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
        loadSession: true,
        // image is intentionally omitted: @ampcode/sdk's ExecuteOptions.prompt only
        // accepts string | AsyncIterable<UserInputMessage>, and UserInputMessage
        // content is text-only. Advertising image:true would be a false promise.
        promptCapabilities: { embeddedContext: true },
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
      modes: buildModeState('smart'),
    };

    setImmediate(async () => {
      await this.sendAvailableCommandsUpdate(sessionId);
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

    const { text: textInput, warnings } = parsePrompt(params.prompt);

    for (const text of warnings) {
      try {
        await this.client.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        });
      } catch (e) {
        console.error('[acp] failed to send warning chunk', e);
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

    let lastAssistantStopReason: AssistantStopReason = null;
    let lastResult: StreamMessage | null = null;

    try {
      for await (const message of execute({ prompt: textInput, options, signal: controller.signal })) {
        if (!s.threadId && message.session_id) {
          s.threadId = message.session_id;
          this.persistSessionEntry(params.sessionId, s);
        }

        this.appendToSessionLog(params.sessionId, message);

        if (message.type === 'assistant') {
          lastAssistantStopReason = message.message?.stop_reason ?? lastAssistantStopReason;
          for (const n of toAcpNotifications(message, params.sessionId)) {
            try {
              await this.client.sessionUpdate(n);
            } catch (e) {
              console.error('[acp] sessionUpdate failed', e);
            }
          }
        } else if (message.type === 'user') {
          for (const n of toAcpNotifications(message, params.sessionId)) {
            try {
              await this.client.sessionUpdate(n);
            } catch (e) {
              console.error('[acp] sessionUpdate failed', e);
            }
          }
        }

        if (message.type === 'result') {
          lastResult = message;
          if (message.is_error) {
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
      }

      return { stopReason: mapStopReason({ cancelled: s.cancelled, result: lastResult, lastAssistantStopReason }) };
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
    this.persistSessionEntry(params.sessionId, s);
    try {
      await this.client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: params.modeId },
      });
    } catch (e) {
      console.error('[acp] failed to send current_mode_update', e);
    }
    return {};
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const entry = lookupSession(this.storePaths, params.sessionId);
    if (!entry) {
      throw new RequestError(-32602, `Session not found: ${params.sessionId}`);
    }
    const mode: AmpMode = isAmpMode(entry.mode) ? entry.mode : 'smart';
    const mcpConfig = convertAcpMcpServersToAmpConfig(params.mcpServers);
    this.sessions.set(params.sessionId, {
      threadId: entry.threadId,
      controller: null,
      cancelled: false,
      active: false,
      mode,
      mcpConfig,
      cwd: params.cwd || process.cwd(),
    });
    // Refresh lastUsedMs so this session isn't evicted while it's actively used.
    recordSession(this.storePaths, params.sessionId, { threadId: entry.threadId, mode });
    await this.replaySessionLog(params.sessionId);
    await this.sendAvailableCommandsUpdate(params.sessionId);
    return { modes: buildModeState(mode) };
  }

  private persistSessionEntry(sessionId: string, s: SessionState): void {
    if (!s.threadId) return;
    try {
      recordSession(this.storePaths, sessionId, { threadId: s.threadId, mode: s.mode });
    } catch (e) {
      console.error('[acp] failed to persist session entry', e);
    }
  }

  private appendToSessionLog(sessionId: string, message: StreamMessage): void {
    try {
      appendLogEntry(this.storePaths, sessionId, message);
    } catch (e) {
      console.error('[acp] failed to append session log', e);
    }
  }

  private async replaySessionLog(sessionId: string): Promise<void> {
    let entries: unknown[];
    try {
      entries = readLog(this.storePaths, sessionId);
    } catch (e) {
      console.error('[acp] failed to read session log', e);
      return;
    }
    for (const entry of entries) {
      const message = entry as StreamMessage;
      if (message.type !== 'assistant' && message.type !== 'user') continue;
      for (const n of toAcpNotifications(message, sessionId)) {
        try {
          await this.client.sessionUpdate(n);
        } catch (e) {
          console.error('[acp] sessionUpdate during replay failed', e);
        }
      }
    }
  }

  private async sendAvailableCommandsUpdate(sessionId: string): Promise<void> {
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

const INIT_PROMPT = `Please analyze this codebase and create an AGENTS.md file containing:
1. Build/lint/test commands - especially for running a single test
2. Architecture and codebase structure information, including important subprojects, internal APIs, databases, etc.
3. Code style guidelines, including imports, conventions, formatting, types, naming conventions, error handling, etc.

The file you create will be given to agentic coding tools (such as yourself) that operate in this repository. Make it about 20 lines long.

If there are Cursor rules (in .cursor/rules/ or .cursorrules), Claude rules (CLAUDE.md), Windsurf rules (.windsurfrules), Cline rules (.clinerules), Goose rules (.goosehints), or Copilot rules (in .github/copilot-instructions.md), make sure to include them. Also, first check if there is an existing AGENTS.md or AGENT.md file, and if so, update it instead of overwriting it.`;

export function parsePrompt(prompt: PromptRequest['prompt']): { text: string; warnings: string[] } {
  let text = '';
  const warnings: string[] = [];
  for (const chunk of prompt) {
    switch (chunk.type) {
      case 'text':
        text += chunk.text.trim() === '/init' ? INIT_PROMPT : chunk.text;
        break;
      case 'resource_link':
        text += `\n${chunk.uri}\n`;
        break;
      case 'resource':
        if ('text' in chunk.resource) {
          text += `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>\n`;
        } else {
          const mime = 'mimeType' in chunk.resource && chunk.resource.mimeType ? chunk.resource.mimeType : 'unknown mime';
          warnings.push(`[amp-acp] Dropped binary attachment "${chunk.resource.uri}" (${mime}) — @ampcode/sdk only accepts text input.`);
        }
        break;
      case 'image':
        warnings.push('[amp-acp] Image attachments are not supported by @ampcode/sdk (text-only input). Dropped.');
        break;
      default:
        break;
    }
  }
  return { text, warnings };
}

export function mapStopReason(
  args: { cancelled: boolean; result: StreamMessage | null; lastAssistantStopReason: AssistantStopReason },
): AcpStopReason {
  if (args.cancelled) return 'cancelled';
  const r = args.result;
  if (r && r.type === 'result') {
    if (r.is_error && r.subtype === 'error_max_turns') return 'max_turn_requests';
    // error_during_execution (and any other future error subtype) falls through to
    // end_turn: the error text has already been streamed as an agent_message_chunk,
    // and ACP's 'refusal' is reserved for model-side refusals, not runtime errors.
  }
  if (args.lastAssistantStopReason === 'max_tokens') return 'max_tokens';
  return 'end_turn';
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
