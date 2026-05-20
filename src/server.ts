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
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SessionConfigOption,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type ClientCapabilities,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { execute, threads, type AmpOptions, type StreamMessage } from '@ampcode/sdk';

type AssistantStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | null;
type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
import { convertAcpMcpServersToAmpConfig, type AmpMcpConfig } from './mcp-config.js';
import { isTerminalOutputTool, toAcpNotifications } from './to-acp.js';
import {
  getSessionStorePaths,
  recordSession,
  lookupSession,
  appendLogEntry,
  readLog,
  type SessionStorePaths,
} from './session-store.js';
import {
  AMP_ACP_PERMISSION_PROMPTS_ENV,
  PermissionBroker,
  buildDelegatedPermissions,
  getPermissionRuntimeDir,
  type PermissionDelegateConfig,
} from './permission-broker.js';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { execFile, type ExecFileException } from 'node:child_process';
import packageJson from '../package.json';

const PACKAGE_VERSION: string = packageJson.version;

const AMP_MODES = ['smart', 'rush', 'deep'] as const;
export type AmpMode = (typeof AMP_MODES)[number];
const THINKING_CONFIG_ID = 'thinking';
const THINKING_ON_VALUE = 'on';
const THINKING_OFF_VALUE = 'off';

const AMP_ACP_THINKING_ENV = 'AMP_ACP_THINKING';
const AMP_ACP_DANGEROUSLY_ALLOW_ALL_ENV = 'AMP_ACP_DANGEROUSLY_ALLOW_ALL';
const AMP_ACP_SYSTEM_PROMPT_ENV = 'AMP_ACP_SYSTEM_PROMPT';
const AMP_ACP_TOOLBOX_ENV = 'AMP_ACP_TOOLBOX';
const AMP_ACP_SKILLS_ENV = 'AMP_ACP_SKILLS';
const AMP_ACP_SETTINGS_FILE_ENV = 'AMP_ACP_SETTINGS_FILE';
const AMP_ACP_LOG_LEVEL_ENV = 'AMP_ACP_LOG_LEVEL';
const AMP_ACP_LOG_FILE_ENV = 'AMP_ACP_LOG_FILE';

const AMP_LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'audit'] as const;
type AmpLogLevel = (typeof AMP_LOG_LEVELS)[number];

// `amp usage` may need to reach Amp's API, but an adapter slash command should
// still return promptly instead of pinning the ACP session forever.
const AMP_USAGE_COMMAND_TIMEOUT_MS = 15_000;

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

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  durationMs: number;
  numTurns: number;
}

export interface AmpUsageCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  errorMessage?: string;
}

export type AmpUsageRunner = () => Promise<AmpUsageCommandResult>;

interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  sawCacheCreationInputTokens: boolean;
  sawCacheReadInputTokens: boolean;
  sawUsage: boolean;
}

interface SessionState {
  threadId: string | null;
  controller: AbortController | null;
  cancelled: boolean;
  active: boolean;
  mode: AmpMode;
  thinking: boolean;
  mcpConfig: AmpMcpConfig;
  cwd: string;
  lastUsage: UsageSnapshot | null;
  mcpStatusReported: Map<string, string>;
  permissionDecisions: Map<string, 'allow' | 'reject'>;
}

export interface AmpOptionsInput {
  cwd: string;
  mode: AmpMode;
  mcpConfig: AmpMcpConfig;
  threadId: string | null;
  thinking?: boolean;
  permissionDelegate?: PermissionDelegateConfig | null;
}

interface InitializeResponseWithAgentInfo extends InitializeResponse {
  agentInfo: {
    name: string;
    title: string;
    version: string;
  };
}

interface AmpAcpAgentOptions {
  usageRunner?: AmpUsageRunner;
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

function buildThinkingConfigOption(thinking: boolean): SessionConfigOption {
  return {
    id: THINKING_CONFIG_ID,
    name: 'Thinking',
    description: 'Show Amp thinking output in the transcript',
    type: 'select',
    category: 'thought_level',
    currentValue: thinking ? THINKING_ON_VALUE : THINKING_OFF_VALUE,
    options: [
      { value: THINKING_ON_VALUE, name: 'Thinking on' },
      { value: THINKING_OFF_VALUE, name: 'Thinking off' },
    ],
  };
}

function buildConfigOptions(s: Pick<SessionState, 'thinking'>): SessionConfigOption[] {
  return [buildThinkingConfigOption(s.thinking)];
}

export class AmpAcpAgent implements Agent {
  private client: AgentSideConnection;
  sessions = new Map<string, SessionState>();
  private clientCapabilities?: ClientCapabilities;
  private storePaths: SessionStorePaths;
  private permissionBroker: PermissionBroker;
  private usageRunner: AmpUsageRunner;

  constructor(
    client: AgentSideConnection,
    storePaths: SessionStorePaths = getSessionStorePaths(),
    options: AmpAcpAgentOptions = {},
  ) {
    this.client = client;
    this.storePaths = storePaths;
    this.usageRunner = options.usageRunner ?? runAmpUsageCommand;
    this.permissionBroker = new PermissionBroker(
      client,
      getPermissionRuntimeDir(storePaths.indexFile),
      (sessionId) => this.sessions.get(sessionId),
    );
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
    const thinking = readBooleanEnv(AMP_ACP_THINKING_ENV, true);

    this.sessions.set(sessionId, {
      threadId: null,
      controller: null,
      cancelled: false,
      active: false,
      mode: 'smart',
      thinking,
      mcpConfig,
      cwd: params.cwd || process.cwd(),
      lastUsage: null,
      mcpStatusReported: new Map(),
      permissionDecisions: new Map(),
    });

    const result: NewSessionResponse = {
      sessionId,
      modes: buildModeState('smart'),
      configOptions: [buildThinkingConfigOption(thinking)],
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

    const slash = detectAdapterSlashCommand(textInput);
    if (slash) {
      try {
        await this.handleAdapterSlashCommand(params.sessionId, s, slash);
      } finally {
        s.active = false;
        s.cancelled = false;
        s.controller = null;
      }
      return { stopReason: 'end_turn' };
    }

    const permissionDelegate = readBooleanEnv(AMP_ACP_PERMISSION_PROMPTS_ENV, true)
      ? await this.permissionBroker.prepareSession(params.sessionId)
      : null;

    const options = buildAmpOptions({
      cwd: s.cwd,
      mode: s.mode,
      mcpConfig: s.mcpConfig,
      threadId: s.threadId,
      thinking: s.thinking,
      permissionDelegate,
    });

    const controller = new AbortController();
    s.controller = controller;

    let lastAssistantStopReason: AssistantStopReason = null;
    let lastResult: StreamMessage | null = null;
    let pendingUsage = createUsageAccumulator();
    let pendingToolResultDisplays: SessionNotification[] = [];
    const terminalOutputToolIds = new Set<string>();
    const createTerminalOutput = supportsTerminalOutput(this.clientCapabilities);

    try {
      for await (const message of execute({ prompt: textInput, options, signal: controller.signal })) {
        if (!s.threadId && message.session_id) {
          s.threadId = message.session_id;
          this.persistSessionEntry(params.sessionId, s);
        }

        this.appendToSessionLog(params.sessionId, message);

        if (message.type === 'system' && message.subtype === 'init') {
          await this.surfaceMcpStatus(params.sessionId, s, message.mcp_servers);
        }

        if (message.type === 'assistant') {
          lastAssistantStopReason = message.message?.stop_reason ?? lastAssistantStopReason;
          addUsage(pendingUsage, message.message?.usage);
          rememberTerminalOutputToolCalls(message, terminalOutputToolIds, createTerminalOutput);
          const notifications = prependPendingToolResultDisplays(
            pendingToolResultDisplays,
            toAcpNotifications(message, params.sessionId, { createTerminalOutput, terminalOutputToolIds }),
          );
          pendingToolResultDisplays = [];
          for (const n of notifications) {
            try {
              await this.client.sessionUpdate(n);
            } catch (e) {
              console.error('[acp] sessionUpdate failed', e);
            }
          }
        } else if (message.type === 'user') {
          const notifications = toAcpNotifications(message, params.sessionId, { createTerminalOutput, terminalOutputToolIds });
          const { immediate, deferredDisplays } = splitToolResultDisplayNotifications(notifications);
          pendingToolResultDisplays.push(...deferredDisplays);
          for (const n of immediate) {
            try {
              await this.client.sessionUpdate(n);
            } catch (e) {
              console.error('[acp] sessionUpdate failed', e);
            }
          }
        }

        if (message.type === 'result') {
          for (const n of pendingToolResultDisplays) {
            try {
              await this.client.sessionUpdate(n);
            } catch (e) {
              console.error('[acp] sessionUpdate failed', e);
            }
          }
          pendingToolResultDisplays = [];
          lastResult = message;
          const usage = finishUsageSnapshot(pendingUsage, message);
          if (usage) s.lastUsage = usage;
          pendingUsage = createUsageAccumulator();
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

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new RequestError(-32602, `Session not found: ${params.sessionId}`);
    if (params.configId !== THINKING_CONFIG_ID) {
      throw new RequestError(-32602, `Unknown config option: ${params.configId}`);
    }
    const value = readConfigOptionValue(params);
    if (value !== THINKING_ON_VALUE && value !== THINKING_OFF_VALUE) {
      throw new RequestError(-32602, `Unknown thinking option: ${String(value)}`);
    }
    s.thinking = value === THINKING_ON_VALUE;
    const configOptions = buildConfigOptions(s);
    try {
      await this.client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'config_option_update', configOptions },
      });
    } catch (e) {
      console.error('[acp] failed to send config_option_update', e);
    }
    return { configOptions };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const entry = lookupSession(this.storePaths, params.sessionId);
    if (!entry) {
      throw new RequestError(-32602, `Session not found: ${params.sessionId}`);
    }
    const mode: AmpMode = isAmpMode(entry.mode) ? entry.mode : 'smart';
    const mcpConfig = convertAcpMcpServersToAmpConfig(params.mcpServers);
    const lastUsage = usageSnapshotFromMessages(readLog(this.storePaths, params.sessionId));
    this.sessions.set(params.sessionId, {
      threadId: entry.threadId,
      controller: null,
      cancelled: false,
      active: false,
      mode,
      thinking: readBooleanEnv(AMP_ACP_THINKING_ENV, true),
      mcpConfig,
      cwd: params.cwd || process.cwd(),
      lastUsage,
      mcpStatusReported: new Map(),
      permissionDecisions: new Map(),
    });
    // Refresh lastUsedMs so this session isn't evicted while it's actively used.
    recordSession(this.storePaths, params.sessionId, { threadId: entry.threadId, mode });
    await this.replaySessionLog(params.sessionId);
    await this.sendAvailableCommandsUpdate(params.sessionId);
    const s = this.sessions.get(params.sessionId);
    return { modes: buildModeState(mode), ...(s ? { configOptions: buildConfigOptions(s) } : {}) };
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
            { name: 'init', description: 'Generate an AGENTS.md file for the project' },
            { name: 'export', description: 'Export the current Amp thread as markdown' },
            { name: 'usage', description: 'Show token usage for the latest turn' },
            { name: 'permissions', description: 'Show amp-acp permission delegate status' },
            { name: 'thinking', description: 'Show or set thinking output: /thinking on|off' },
            {
              name: 'resume',
              description: 'Switch this session to an existing Amp thread by ID',
              input: { hint: 'thread ID (e.g. T-019e...)' },
            },
          ],
        },
      });
    } catch (e) {
      console.error('[acp] failed to send available_commands_update', e);
    }
  }

  private async handleAdapterSlashCommand(
    sessionId: string,
    s: SessionState,
    slash: { command: string; arg: string },
  ): Promise<void> {
    const emit = async (text: string): Promise<void> => {
      await this.client.sessionUpdate({
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      });
    };
    switch (slash.command) {
      case 'export': {
        if (!s.threadId) {
          await emit('[/export] No active Amp thread yet. Send a regular prompt first.');
          return;
        }
        try {
          const md = await threads.markdown({ threadId: s.threadId });
          await emit(md);
        } catch (e) {
          await emit(`[/export] Failed to export thread: ${(e as Error).message}`);
        }
        return;
      }
      case 'usage': {
        await emit(formatUsage(s.lastUsage, await this.usageRunner()));
        return;
      }
      case 'permissions': {
        await emit(await this.formatPermissionStatus(sessionId, s));
        return;
      }
      case 'thinking': {
        await emit(await this.handleThinkingCommand(sessionId, s, slash.arg));
        return;
      }
      case 'resume': {
        const arg = slash.arg;
        if (!arg) {
          await emit('[/resume] Usage: `/resume <thread-id>` (e.g. `/resume T-019e...`).');
          return;
        }
        if (!/^T-[A-Za-z0-9-]+$/.test(arg)) {
          await emit(`[/resume] Refusing to switch: "${arg}" doesn't look like an Amp thread ID (expected T-…).`);
          return;
        }
        s.threadId = arg;
        s.lastUsage = null;
        s.mcpStatusReported.clear();
        this.persistSessionEntry(sessionId, s);
        await emit(`[/resume] Switched session to Amp thread \`${arg}\`. Future prompts will continue that thread.`);
        return;
      }
      default:
        await emit(`[amp-acp] Unknown adapter command: /${slash.command}`);
    }
  }

  private async handleThinkingCommand(sessionId: string, s: SessionState, arg: string): Promise<string> {
    const normalized = arg.trim().toLowerCase();
    if (!normalized) {
      return `Thinking is ${s.thinking ? 'on' : 'off'}. Use \`/thinking on\` or \`/thinking off\` to change it.`;
    }
    if (normalized !== THINKING_ON_VALUE && normalized !== THINKING_OFF_VALUE) {
      return 'Usage: `/thinking on` or `/thinking off`';
    }
    s.thinking = normalized === THINKING_ON_VALUE;
    try {
      await this.client.sessionUpdate({
        sessionId,
        update: { sessionUpdate: 'config_option_update', configOptions: buildConfigOptions(s) },
      });
    } catch (e) {
      console.error('[acp] failed to send config_option_update', e);
    }
    return `Thinking ${s.thinking ? 'on' : 'off'}.`;
  }

  private async formatPermissionStatus(sessionId: string, s: SessionState): Promise<string> {
    const promptsEnabled = readBooleanEnv(AMP_ACP_PERMISSION_PROMPTS_ENV, true);
    const lines = [
      '**amp-acp permissions**',
      `- ${AMP_ACP_PERMISSION_PROMPTS_ENV}: ${process.env[AMP_ACP_PERMISSION_PROMPTS_ENV] ?? '(unset)'} -> ${promptsEnabled}`,
      `- ${AMP_ACP_DANGEROUSLY_ALLOW_ALL_ENV}: ${process.env[AMP_ACP_DANGEROUSLY_ALLOW_ALL_ENV] ?? '(unset)'}`,
      `- Session remembered decisions: ${s.permissionDecisions.size}`,
    ];
    if (!promptsEnabled) {
      const options = buildAmpOptions({
        cwd: s.cwd,
        mode: s.mode,
        mcpConfig: s.mcpConfig,
        threadId: s.threadId,
        thinking: s.thinking,
        permissionDelegate: null,
      });
      lines.push(`- Delegated prompts: disabled`);
      lines.push(`- dangerouslyAllowAll option: ${options.dangerouslyAllowAll === true ? 'true' : 'unset'}`);
      return lines.join('\n');
    }
    try {
      const delegate = await this.permissionBroker.prepareSession(sessionId);
      const options = buildAmpOptions({
        cwd: s.cwd,
        mode: s.mode,
        mcpConfig: s.mcpConfig,
        threadId: s.threadId,
        thinking: s.thinking,
        permissionDelegate: delegate,
      });
      lines.push('- Delegated prompts: enabled');
      lines.push(`- Helper: ${delegate.helperCommand}`);
      lines.push(`- Broker socket configured: ${delegate.env.AMP_ACP_PERMISSION_SOCKET ? 'yes' : 'no'}`);
      lines.push(`- Broker token configured: ${delegate.env.AMP_ACP_PERMISSION_TOKEN ? 'yes' : 'no'}`);
      lines.push(`- dangerouslyAllowAll option: ${options.dangerouslyAllowAll === true ? 'true' : 'unset'}`);
      lines.push(`- Delegate rules: ${options.permissions?.map((p) => `${p.tool} ${JSON.stringify(p.matches)}`).join(', ') ?? '(none)'}`);
    } catch (e) {
      lines.push(`- Delegated prompts: failed to initialize (${(e as Error).message})`);
    }
    return lines.join('\n');
  }

  private async surfaceMcpStatus(
    sessionId: string,
    s: SessionState,
    servers: { name: string; status: string }[],
  ): Promise<void> {
    for (const server of servers) {
      if (server.status === 'connected') {
        s.mcpStatusReported.set(server.name, server.status);
        continue;
      }
      const previously = s.mcpStatusReported.get(server.name);
      if (previously === server.status) continue;
      s.mcpStatusReported.set(server.name, server.status);
      try {
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `[amp-acp] MCP server "${server.name}" status: ${server.status}` },
          },
        });
      } catch (e) {
        console.error('[acp] failed to send MCP status notice', e);
      }
    }
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> { return this.client.readTextFile(params); }
  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> { return this.client.writeTextFile(params); }

  async shutdown(): Promise<void> {
    await this.permissionBroker.dispose();
  }
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

interface UsageFields {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function createUsageAccumulator(): UsageAccumulator {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    sawCacheCreationInputTokens: false,
    sawCacheReadInputTokens: false,
    sawUsage: false,
  };
}

function addUsage(acc: UsageAccumulator, usage: UsageFields | undefined): void {
  if (!usage) return;
  acc.sawUsage = true;
  acc.inputTokens += usage.input_tokens;
  acc.outputTokens += usage.output_tokens;
  if (usage.cache_creation_input_tokens !== undefined) {
    acc.sawCacheCreationInputTokens = true;
    acc.cacheCreationInputTokens += usage.cache_creation_input_tokens;
  }
  if (usage.cache_read_input_tokens !== undefined) {
    acc.sawCacheReadInputTokens = true;
    acc.cacheReadInputTokens += usage.cache_read_input_tokens;
  }
}

function finishUsageSnapshot(
  acc: UsageAccumulator,
  result: { duration_ms: number; num_turns: number; usage?: UsageFields },
): UsageSnapshot | null {
  // Amp usually reports per-assistant-message usage, while the SDK type also
  // allows result.usage. Treat result.usage as a fallback only, not an
  // additional increment, so future SDK changes do not double-count.
  if (!acc.sawUsage) addUsage(acc, result.usage);
  if (!acc.sawUsage) return null;
  return {
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheCreationInputTokens: acc.sawCacheCreationInputTokens ? acc.cacheCreationInputTokens : undefined,
    cacheReadInputTokens: acc.sawCacheReadInputTokens ? acc.cacheReadInputTokens : undefined,
    durationMs: result.duration_ms,
    numTurns: result.num_turns,
  };
}

export function usageSnapshotFromMessages(entries: unknown[]): UsageSnapshot | null {
  let latest: UsageSnapshot | null = null;
  let pending = createUsageAccumulator();

  for (const entry of entries) {
    if (!isPlainObject(entry)) continue;
    if (entry.type === 'assistant') {
      const message = isPlainObject(entry.message) ? entry.message : null;
      addUsage(pending, readUsageFields(message?.usage));
      continue;
    }
    if (entry.type !== 'result') continue;
    if (typeof entry.duration_ms !== 'number' || typeof entry.num_turns !== 'number') {
      pending = createUsageAccumulator();
      continue;
    }
    const usage = finishUsageSnapshot(pending, {
      duration_ms: entry.duration_ms,
      num_turns: entry.num_turns,
      usage: readUsageFields(entry.usage),
    });
    if (usage) latest = usage;
    pending = createUsageAccumulator();
  }

  return latest;
}

function readUsageFields(value: unknown): UsageFields | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.input_tokens !== 'number' || typeof value.output_tokens !== 'number') {
    return undefined;
  }
  const usage: UsageFields = {
    input_tokens: value.input_tokens,
    output_tokens: value.output_tokens,
  };
  if (typeof value.cache_creation_input_tokens === 'number') {
    usage.cache_creation_input_tokens = value.cache_creation_input_tokens;
  }
  if (typeof value.cache_read_input_tokens === 'number') {
    usage.cache_read_input_tokens = value.cache_read_input_tokens;
  }
  return usage;
}

type AgentTextNotification = SessionNotification & {
  update: { sessionUpdate: 'agent_message_chunk'; content: { type: 'text'; text: string } };
};

function splitToolResultDisplayNotifications(notifications: SessionNotification[]): {
  immediate: SessionNotification[];
  deferredDisplays: SessionNotification[];
} {
  const immediate: SessionNotification[] = [];
  const deferredDisplays: SessionNotification[] = [];
  for (const notification of notifications) {
    if (isAgentTextNotification(notification)) {
      deferredDisplays.push(notification);
    } else {
      immediate.push(notification);
    }
  }
  return { immediate, deferredDisplays };
}

function prependPendingToolResultDisplays(
  pendingDisplays: SessionNotification[],
  notifications: SessionNotification[],
): SessionNotification[] {
  if (pendingDisplays.length === 0) return notifications;
  const pendingText = pendingDisplays
    .map(agentNotificationText)
    .filter((text): text is string => Boolean(text))
    .join('\n\n');
  if (!pendingText) return notifications;

  const firstTextIndex = notifications.findIndex(isAgentTextNotification);
  if (firstTextIndex === -1) return [...pendingDisplays, ...notifications];

  return notifications.map((notification, index) => {
    if (index !== firstTextIndex || !isAgentTextNotification(notification)) return notification;
    return {
      ...notification,
      update: {
        ...notification.update,
        content: {
          ...notification.update.content,
          text: `${pendingText}\n\n${notification.update.content.text}`,
        },
      },
    };
  });
}

function isAgentTextNotification(notification: SessionNotification): notification is AgentTextNotification {
  const update = notification.update;
  if (update.sessionUpdate !== 'agent_message_chunk') return false;
  const content = update.content;
  return isPlainObject(content) && content.type === 'text' && typeof content.text === 'string';
}

function agentNotificationText(notification: SessionNotification): string | null {
  return isAgentTextNotification(notification) ? notification.update.content.text : null;
}

function supportsTerminalOutput(capabilities: ClientCapabilities | undefined): boolean {
  return isPlainObject(capabilities?._meta) && capabilities._meta.terminal_output === true;
}

function rememberTerminalOutputToolCalls(message: unknown, ids: Set<string>, enabled: boolean): void {
  if (!enabled || !isPlainObject(message)) return;
  const inner = isPlainObject(message.message) ? message.message : null;
  const content = inner?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isPlainObject(block)) continue;
    if (block.type === 'tool_use' && typeof block.id === 'string' && isTerminalOutputTool(asOptionalString(block.name))) {
      ids.add(block.id);
    }
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function runAmpUsageCommand(env: Record<string, string | undefined> = process.env): Promise<AmpUsageCommandResult> {
  const command = env.AMP_CLI_PATH?.trim() || 'amp';
  return new Promise((resolve) => {
    execFile(
      command,
      ['usage'],
      { env, timeout: AMP_USAGE_COMMAND_TIMEOUT_MS, windowsHide: true },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: error ? readExecExitCode(error) : 0,
          ...(error ? { errorMessage: error.message } : {}),
        });
      },
    );
  });
}

function readExecExitCode(error: ExecFileException): number | null {
  return typeof error.code === 'number' ? error.code : null;
}

export function buildAmpOptions(
  { cwd, mode, mcpConfig, threadId, thinking, permissionDelegate }: AmpOptionsInput,
  env: Record<string, string | undefined> = process.env,
): AmpOptions {
  const options: AmpOptions = {
    cwd,
    env: { TERM: 'dumb' },
    mode,
    thinking: thinking ?? readBooleanEnv(AMP_ACP_THINKING_ENV, true, env),
    ...(Object.keys(mcpConfig).length > 0 ? { mcpConfig } : {}),
    ...(threadId ? { continue: threadId } : {}),
  };

  const permissionPrompts = readBooleanEnv(AMP_ACP_PERMISSION_PROMPTS_ENV, true, env);
  if (permissionPrompts && permissionDelegate) {
    options.env = { ...options.env, ...permissionDelegate.env };
    options.permissions = buildDelegatedPermissions(permissionDelegate.helperCommand);
  } else if (!permissionPrompts && readBooleanEnv(AMP_ACP_DANGEROUSLY_ALLOW_ALL_ENV, false, env)) {
    // The unsafe bypass is retained only for the explicit no-prompts mode.
    // Stream JSON cannot satisfy Amp's native "ask" policy, so the safe default
    // uses delegated ACP permissions instead.
    options.dangerouslyAllowAll = true;
  }

  const systemPrompt = env[AMP_ACP_SYSTEM_PROMPT_ENV]?.trim();
  if (systemPrompt) options.systemPrompt = systemPrompt;

  const toolbox = env[AMP_ACP_TOOLBOX_ENV]?.trim();
  if (toolbox) options.toolbox = toolbox;

  const skills = env[AMP_ACP_SKILLS_ENV]?.trim();
  if (skills) options.skills = skills;

  const settingsFile = env[AMP_ACP_SETTINGS_FILE_ENV]?.trim();
  if (settingsFile) options.settingsFile = settingsFile;

  const logLevel = env[AMP_ACP_LOG_LEVEL_ENV]?.trim();
  if (logLevel && (AMP_LOG_LEVELS as readonly string[]).includes(logLevel)) {
    options.logLevel = logLevel as AmpLogLevel;
  } else if (logLevel) {
    console.warn(`[amp-acp] Ignoring AMP_ACP_LOG_LEVEL=${logLevel} — expected one of ${AMP_LOG_LEVELS.join('|')}`);
  }

  const logFile = env[AMP_ACP_LOG_FILE_ENV]?.trim();
  if (logFile) options.logFile = logFile;

  return options;
}

export function detectAdapterSlashCommand(text: string): { command: string; arg: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = /^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const command = match[1];
  // /init is intentionally NOT an adapter command — parsePrompt expands it into a
  // regular prompt the model handles. Only commands that should bypass Amp belong
  // here.
  if (
    command !== 'export' &&
    command !== 'usage' &&
    command !== 'resume' &&
    command !== 'permissions' &&
    command !== 'thinking'
  ) return null;
  return { command, arg: (match[2] ?? '').trim() };
}

function readConfigOptionValue(params: SetSessionConfigOptionRequest): string | boolean {
  return 'value' in params ? params.value : '';
}

export function formatUsage(usage: UsageSnapshot | null, ampUsage?: AmpUsageCommandResult | null): string {
  const sections: string[] = [];
  if (ampUsage) sections.push(formatAmpUsageCommandResult(ampUsage));
  sections.push(formatTokenUsage(usage));
  return sections.join('\n\n');
}

function formatAmpUsageCommandResult(result: AmpUsageCommandResult): string {
  const lines = ['**Amp account usage**'];
  if (result.stdout) {
    lines.push('```text', result.stdout, '```');
  } else {
    const reason = result.errorMessage ?? (result.exitCode === 0 ? 'No output from `amp usage`.' : '`amp usage` failed.');
    lines.push(reason);
  }
  if (result.exitCode !== 0 && result.stderr) {
    lines.push('', '**amp usage stderr**', '```text', result.stderr, '```');
  }
  return lines.join('\n');
}

function formatTokenUsage(usage: UsageSnapshot | null): string {
  if (!usage) return '[/usage] No usage data yet — this session has not completed a turn with token data.';
  const fmt = (n: number): string => n.toLocaleString();
  const lines = [
    '**Latest turn tokens**',
    `- Input: ${fmt(usage.inputTokens)} tokens`,
    `- Output: ${fmt(usage.outputTokens)} tokens`,
  ];
  if (usage.cacheReadInputTokens !== undefined) lines.push(`- Cache read: ${fmt(usage.cacheReadInputTokens)} tokens`);
  if (usage.cacheCreationInputTokens !== undefined) lines.push(`- Cache write: ${fmt(usage.cacheCreationInputTokens)} tokens`);
  lines.push(`- Duration: ${(usage.durationMs / 1000).toFixed(2)}s`);
  lines.push(`- Turns: ${fmt(usage.numTurns)}`);
  return lines.join('\n');
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
