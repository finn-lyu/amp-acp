import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type {
  AgentSideConnection,
  PermissionOption,
  RequestPermissionRequest,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type { Permission } from '@ampcode/sdk';
import {
  extractDiffContent,
  extractToolLocations,
  formatToolTitle,
  inferToolKind,
} from './to-acp.js';

const AMP_ACP_PERMISSION_SOCKET_ENV = 'AMP_ACP_PERMISSION_SOCKET';
const AMP_ACP_PERMISSION_TOKEN_ENV = 'AMP_ACP_PERMISSION_TOKEN';
const AMP_ACP_PERMISSION_SESSION_ID_ENV = 'AMP_ACP_PERMISSION_SESSION_ID';
const AMP_ACP_PERMISSION_TIMEOUT_MS_ENV = 'AMP_ACP_PERMISSION_TIMEOUT_MS';

const PERMISSION_HELPER_ARG = '--permission-helper';
const SOCKET_FILE_NAME = 'permission-broker.sock';
const HELPER_FILE_NAME = 'permission-helper.js';
const SOCKET_DIR = process.platform === 'win32' ? '' : (process.platform === 'darwin' ? '/private/tmp' : os.tmpdir());
// Permission prompts can legitimately wait for the user; keep this centralized
// so helper/broker behavior is explicit instead of hidden in per-call literals.
const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

export const AMP_ACP_PERMISSION_PROMPTS_ENV = 'AMP_ACP_PERMISSION_PROMPTS';

export type PermissionDecision = 'allow' | 'reject';

export interface PermissionDelegateConfig {
  helperCommand: string;
  env: Record<string, string>;
}

export interface PermissionRequestPayload {
  token: string;
  sessionId: string;
  toolName: string;
  threadId?: string;
  input: unknown;
}

interface PermissionResponsePayload {
  decision: PermissionDecision;
}

export interface PermissionSessionState {
  permissionDecisions: Map<string, PermissionDecision>;
}

export class PermissionBroker {
  private server: net.Server | null = null;
  private socketPath: string | null = null;
  private helperPath: string | null = null;
  private token = crypto.randomBytes(32).toString('hex');
  private requestCounter = 0;

  constructor(
    private client: AgentSideConnection,
    private runtimeDir: string,
    private getSession: (sessionId: string) => PermissionSessionState | undefined,
    private selfCommand: { command: string; args: string[] } = getSelfCommand(),
  ) {}

  async prepareSession(sessionId: string): Promise<PermissionDelegateConfig> {
    await this.ensureStarted();
    if (!this.socketPath || !this.helperPath) throw new Error('permission broker failed to initialize');
    return {
      helperCommand: this.helperPath,
      env: {
        [AMP_ACP_PERMISSION_SOCKET_ENV]: this.socketPath,
        [AMP_ACP_PERMISSION_TOKEN_ENV]: this.token,
        [AMP_ACP_PERMISSION_SESSION_ID_ENV]: sessionId,
        [AMP_ACP_PERMISSION_TIMEOUT_MS_ENV]: String(DEFAULT_PERMISSION_TIMEOUT_MS),
      },
    };
  }

  async dispose(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.socketPath && process.platform !== 'win32') {
      try { fs.unlinkSync(this.socketPath); } catch { /* already gone */ }
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.server) return;
    fs.mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
    this.helperPath = path.join(this.runtimeDir, HELPER_FILE_NAME);
    this.writeHelperScript(this.helperPath);
    this.socketPath = this.makeSocketPath();
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.socketPath); } catch { /* no stale socket */ }
    }
    const server = net.createServer((socket) => {
      void this.handleConnection(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
  }

  private makeSocketPath(): string {
    if (process.platform === 'win32') {
      return `\\\\.\\pipe\\amp-acp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    }
    return path.join(SOCKET_DIR, `amp-acp-${process.pid}-${crypto.randomBytes(8).toString('hex')}-${SOCKET_FILE_NAME}`);
  }

  private writeHelperScript(helperPath: string): void {
    const script = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const result = spawnSync(${JSON.stringify(this.selfCommand.command)}, ${JSON.stringify([...this.selfCommand.args, PERMISSION_HELPER_ARG])}, {
  stdio: 'inherit',
  env: process.env,
});
if (result.error) {
  console.error(String(result.error && result.error.stack || result.error));
  process.exit(2);
}
process.exit(result.status === null ? 2 : result.status);
`;
    fs.writeFileSync(helperPath, script, { mode: 0o700 });
    try { fs.chmodSync(helperPath, 0o700); } catch { /* chmod is best effort on Windows */ }
  }

  private async handleConnection(socket: net.Socket): Promise<void> {
    let raw = '';
    let responded = false;
    const respond = async (): Promise<void> => {
      if (responded) return;
      responded = true;
      const response = await this.handleRawRequest(raw);
      socket.end(JSON.stringify(response) + '\n');
    };
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      raw += chunk;
      try {
        JSON.parse(raw);
      } catch {
        return;
      }
      void respond();
    });
    socket.on('end', () => { void respond(); });
    socket.on('error', (e) => {
      console.error('[acp] permission broker socket error', e);
    });
  }

  private async handleRawRequest(raw: string): Promise<PermissionResponsePayload> {
    let payload: PermissionRequestPayload;
    try {
      payload = JSON.parse(raw) as PermissionRequestPayload;
    } catch {
      return { decision: 'reject' };
    }
    if (payload.token !== this.token) return { decision: 'reject' };
    const session = this.getSession(payload.sessionId);
    if (!session) return { decision: 'reject' };
    const toolName = typeof payload.toolName === 'string' ? payload.toolName : '';
    if (!toolName) return { decision: 'reject' };
    const input = isPlainObject(payload.input) ? payload.input : {};
    console.error(`[acp] permission delegate request ${payload.sessionId} ${toolName}`);
    return {
      decision: await resolvePermissionDecision({
        client: this.client,
        session,
        sessionId: payload.sessionId,
        toolName,
        input,
        toolCallId: this.nextToolCallId(payload.sessionId),
      }),
    };
  }

  private nextToolCallId(sessionId: string): string {
    this.requestCounter += 1;
    return `${sessionId}-permission-${this.requestCounter}`;
  }
}

export async function resolvePermissionDecision(args: {
  client: Pick<AgentSideConnection, 'requestPermission'>;
  session: PermissionSessionState;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolCallId: string;
}): Promise<PermissionDecision> {
  const cacheKey = permissionDecisionKey(args.toolName, args.input);
  const cached = args.session.permissionDecisions.get(cacheKey);
  if (cached) return cached;

  const request = buildPermissionRequest({
    sessionId: args.sessionId,
    toolName: args.toolName,
    input: args.input,
    toolCallId: args.toolCallId,
  });
  try {
    const response = await args.client.requestPermission(request);
    if (response.outcome.outcome === 'cancelled') return 'reject';
    const decision = optionIdToDecision(response.outcome.optionId);
    if (response.outcome.optionId === 'allow_always' || response.outcome.optionId === 'reject_always') {
      args.session.permissionDecisions.set(cacheKey, decision);
    }
    return decision;
  } catch (e) {
    console.error('[acp] permission request failed', e);
    return 'reject';
  }
}

export function buildDelegatedPermissions(helperCommand: string): Permission[] {
  return DELEGATED_PERMISSION_RULES.map(({ tool, matches }) => ({
    tool,
    matches,
    action: 'delegate' as const,
    to: helperCommand,
  }));
}

export function buildPermissionRequest(args: {
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolCallId: string;
}): RequestPermissionRequest {
  const toolCall: ToolCallUpdate = {
    toolCallId: args.toolCallId,
    title: formatToolTitle(args.toolName, args.input),
    kind: inferToolKind(args.toolName),
    rawInput: safeJson(args.input),
    status: 'pending',
    content: extractDiffContent(args.toolName, args.input) ?? [],
  };
  const locations = extractToolLocations(args.toolName, args.input);
  if (locations) toolCall.locations = locations;
  return {
    sessionId: args.sessionId,
    toolCall,
    options: PERMISSION_OPTIONS,
  };
}

export function permissionDecisionKey(toolName: string, input: Record<string, unknown>): string {
  const filePath = getString(input.path) ?? getString(input.file_path) ?? getString(input.filePath);
  if (filePath && FILE_TARGETING_TOOLS.has(toolName)) return `${toolName}:path:${filePath}`;
  const command = getString(input.cmd) ?? getString(input.command);
  if (toolName === 'Bash' && command) return `${toolName}:command:${command}`;
  return `${toolName}:input:${stableStringify(input)}`;
}

export async function runPermissionHelper(
  env: Record<string, string | undefined> = process.env,
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<PermissionDecision> {
  const socketPath = env[AMP_ACP_PERMISSION_SOCKET_ENV];
  const token = env[AMP_ACP_PERMISSION_TOKEN_ENV];
  const sessionId = env[AMP_ACP_PERMISSION_SESSION_ID_ENV];
  const toolName = env.AGENT_TOOL_NAME;
  if (!socketPath || !token || !sessionId || !toolName) return 'reject';
  let inputText: string;
  try {
    inputText = await readAll(stdin);
  } catch {
    return 'reject';
  }
  let input: unknown;
  try {
    input = inputText.trim() === '' ? {} : JSON.parse(inputText);
  } catch {
    return 'reject';
  }
  const timeoutMs = parseTimeout(env[AMP_ACP_PERMISSION_TIMEOUT_MS_ENV]);
  try {
    const response = await sendPermissionRequest(socketPath, {
      token,
      sessionId,
      toolName,
      threadId: env.AMP_THREAD_ID,
      input,
    }, timeoutMs);
    return response.decision === 'allow' ? 'allow' : 'reject';
  } catch (e) {
    console.error('[amp-acp] permission helper failed', e);
    return 'reject';
  }
}

export function permissionHelperExitCode(decision: PermissionDecision): number {
  return decision === 'allow' ? 0 : 2;
}

function sendPermissionRequest(
  socketPath: string,
  payload: PermissionRequestPayload,
  timeoutMs: number,
): Promise<PermissionResponsePayload> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let raw = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('permission helper timed out'));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(JSON.stringify(payload));
    });
    socket.on('data', (chunk) => { raw += chunk; });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(raw) as PermissionResponsePayload;
        resolve(parsed);
      } catch (e) {
        reject(e);
      }
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function optionIdToDecision(optionId: string): PermissionDecision {
  return optionId === 'allow_once' || optionId === 'allow_always' ? 'allow' : 'reject';
}

const DELEGATED_PERMISSION_RULES: Array<{ tool: string; matches: Record<string, string> }> = [
  { tool: 'Bash', matches: { cmd: '*' } },
  { tool: 'Bash', matches: { command: '*' } },
  { tool: 'create_file', matches: { path: '*' } },
  { tool: 'edit_file', matches: { path: '*' } },
  { tool: 'edit_file', matches: { diff: '*' } },
  { tool: 'Write', matches: { path: '*' } },
  { tool: 'Write', matches: { file_path: '*' } },
  { tool: 'Edit', matches: { path: '*' } },
  { tool: 'Edit', matches: { file_path: '*' } },
  { tool: 'Edit', matches: { diff: '*' } },
];
const FILE_TARGETING_TOOLS = new Set<string>(['create_file', 'edit_file', 'Write', 'Edit']);

const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow in this session', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'reject_always', name: 'Always reject in this session', kind: 'reject_always' },
];

function getSelfCommand(): { command: string; args: string[] } {
  const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
  if (!argv1 || argv1.startsWith('/$bunfs/')) {
    return { command: process.execPath, args: [] };
  }
  return { command: process.execPath, args: [argv1] };
}

function safeJson(x: unknown): { [k: string]: unknown } | undefined {
  try {
    return JSON.parse(JSON.stringify(x)) as { [k: string]: unknown };
  } catch {
    return undefined;
  }
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function getString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseTimeout(raw: string | undefined): number {
  if (!raw) return DEFAULT_PERMISSION_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PERMISSION_TIMEOUT_MS;
}

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { out += chunk; });
    stream.on('end', () => resolve(out));
    stream.on('error', reject);
  });
}

export function getPermissionRuntimeDir(indexFile: string): string {
  return path.join(path.dirname(indexFile), 'runtime');
}

export function getDefaultPermissionRuntimeDir(): string {
  const configDir = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(configDir, 'amp-acp', 'runtime');
}
