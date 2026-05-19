import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClientSideConnection, AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import {
  AmpAcpAgent,
  buildAmpOptions,
  detectAdapterSlashCommand,
  formatUsage,
} from './server.js';
import type { SessionStorePaths } from './session-store.js';

class TestClient {
  notifications: SessionNotification[] = [];
  async writeTextFile() { return {}; }
  async readTextFile() { return { content: '' }; }
  async requestPermission() { return { outcome: { outcome: 'selected' as const, optionId: 'allow' } }; }
  async sessionUpdate(n: SessionNotification) { this.notifications.push(n); }
}

function tempStore(): { paths: SessionStorePaths; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-acp-c3-'));
  return {
    paths: { indexFile: path.join(dir, 'sessions.json'), logsDir: path.join(dir, 'sessions') },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function makeConnection(storePaths: SessionStorePaths) {
  const clientToAgent = new TransformStream();
  const agentToClient = new TransformStream();
  const testClient = new TestClient();
  const conn = new ClientSideConnection(
    () => testClient,
    ndJsonStream(clientToAgent.writable, agentToClient.readable),
  );
  new AgentSideConnection(
    (client) => new AmpAcpAgent(client, storePaths),
    ndJsonStream(agentToClient.writable, clientToAgent.readable),
  );
  return { conn, testClient };
}

describe('detectAdapterSlashCommand', () => {
  it('matches /export, /usage, /resume', () => {
    expect(detectAdapterSlashCommand('/export')).toEqual({ command: 'export', arg: '' });
    expect(detectAdapterSlashCommand('/usage')).toEqual({ command: 'usage', arg: '' });
    expect(detectAdapterSlashCommand('/resume T-abc')).toEqual({ command: 'resume', arg: 'T-abc' });
  });

  it('does NOT match /init (handled by parsePrompt expansion)', () => {
    expect(detectAdapterSlashCommand('/init')).toBeNull();
  });

  it('does not match plain text or random slashes', () => {
    expect(detectAdapterSlashCommand('hello')).toBeNull();
    expect(detectAdapterSlashCommand('  /unknown-thing')).toBeNull();
    expect(detectAdapterSlashCommand('/')).toBeNull();
  });

  it('tolerates leading/trailing whitespace and embedded newlines', () => {
    expect(detectAdapterSlashCommand('   /export   ')).toEqual({ command: 'export', arg: '' });
    expect(detectAdapterSlashCommand('/resume\nT-with-newline')).toEqual({ command: 'resume', arg: 'T-with-newline' });
  });
});

describe('formatUsage', () => {
  it('renders a markdown summary including cache fields when present', () => {
    const out = formatUsage({
      inputTokens: 1234,
      outputTokens: 567,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 100,
      durationMs: 12345,
      numTurns: 3,
    });
    expect(out).toContain('1,234');
    expect(out).toContain('567');
    expect(out).toContain('Cache read: 100');
    expect(out).toContain('Cache write: 50');
    expect(out).toContain('12.35s');
    expect(out).toContain('Turns: 3');
  });

  it('omits cache fields when undefined', () => {
    const out = formatUsage({ inputTokens: 1, outputTokens: 2, durationMs: 1000, numTurns: 1 });
    expect(out).not.toContain('Cache read');
    expect(out).not.toContain('Cache write');
  });

  it('explains absent data when no usage is recorded yet', () => {
    expect(formatUsage(null)).toContain('No usage data yet');
  });
});

describe('buildAmpOptions: Commit 3 env-var passthrough', () => {
  it('passes AMP_ACP_SYSTEM_PROMPT through to options.systemPrompt', () => {
    const o = buildAmpOptions(
      { cwd: '/tmp', mode: 'smart', mcpConfig: {}, threadId: null },
      { AMP_ACP_SYSTEM_PROMPT: 'be terse' },
    );
    expect(o.systemPrompt).toBe('be terse');
  });

  it('passes toolbox, skills, settingsFile, logFile through verbatim', () => {
    const o = buildAmpOptions(
      { cwd: '/tmp', mode: 'smart', mcpConfig: {}, threadId: null },
      {
        AMP_ACP_TOOLBOX: '/tb/path',
        AMP_ACP_SKILLS: '/sk/path',
        AMP_ACP_SETTINGS_FILE: '/cfg.json',
        AMP_ACP_LOG_FILE: '/var/log/amp.log',
      },
    );
    expect(o.toolbox).toBe('/tb/path');
    expect(o.skills).toBe('/sk/path');
    expect(o.settingsFile).toBe('/cfg.json');
    expect(o.logFile).toBe('/var/log/amp.log');
  });

  it('accepts valid AMP_ACP_LOG_LEVEL values', () => {
    for (const lvl of ['debug', 'info', 'warn', 'error', 'audit']) {
      const o = buildAmpOptions(
        { cwd: '/tmp', mode: 'smart', mcpConfig: {}, threadId: null },
        { AMP_ACP_LOG_LEVEL: lvl },
      );
      expect(o.logLevel).toBe(lvl as never);
    }
  });

  it('silently ignores an invalid AMP_ACP_LOG_LEVEL', () => {
    const o = buildAmpOptions(
      { cwd: '/tmp', mode: 'smart', mcpConfig: {}, threadId: null },
      { AMP_ACP_LOG_LEVEL: 'verbose' },
    );
    expect(o.logLevel).toBeUndefined();
  });

  it('omits all new options when no env vars are set', () => {
    const o = buildAmpOptions({ cwd: '/tmp', mode: 'smart', mcpConfig: {}, threadId: null }, {});
    expect(o.systemPrompt).toBeUndefined();
    expect(o.toolbox).toBeUndefined();
    expect(o.skills).toBeUndefined();
    expect(o.settingsFile).toBeUndefined();
    expect(o.logLevel).toBeUndefined();
    expect(o.logFile).toBeUndefined();
  });
});

describe('available_commands_update advertises the adapter slash commands', () => {
  let store: { paths: SessionStorePaths; cleanup: () => void };
  beforeEach(() => { store = tempStore(); });
  afterEach(() => { store.cleanup(); });

  it('includes /init, /export, /usage, /resume after newSession', async () => {
    const { conn, testClient } = makeConnection(store.paths);
    const session = await conn.newSession({ cwd: '/tmp', mcpServers: [] });
    await new Promise((r) => setTimeout(r, 50));
    const cmds = testClient.notifications
      .filter((n) => n.sessionId === session.sessionId && n.update.sessionUpdate === 'available_commands_update')
      .flatMap((n) =>
        (n.update as { availableCommands: { name: string }[] }).availableCommands.map((c) => c.name),
      );
    expect(cmds).toEqual(expect.arrayContaining(['init', 'export', 'usage', 'resume']));
  });
});

describe('/resume slash command rejects malformed thread IDs', () => {
  let store: { paths: SessionStorePaths; cleanup: () => void };
  beforeEach(() => { store = tempStore(); });
  afterEach(() => { store.cleanup(); });

  it('asks for input when no arg is provided', async () => {
    const { conn, testClient } = makeConnection(store.paths);
    const session = await conn.newSession({ cwd: '/tmp', mcpServers: [] });
    testClient.notifications = [];
    const r = await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: '/resume' }],
    });
    expect(r.stopReason).toBe('end_turn');
    const text = testClient.notifications
      .filter((n) => n.update.sessionUpdate === 'agent_message_chunk')
      .map((n) => (n.update as { content: { text: string } }).content.text)
      .join('\n');
    expect(text).toContain('Usage');
  });

  it('rejects an obviously bogus thread ID', async () => {
    const { conn, testClient } = makeConnection(store.paths);
    const session = await conn.newSession({ cwd: '/tmp', mcpServers: [] });
    testClient.notifications = [];
    await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: '/resume not-a-thread' }],
    });
    const text = testClient.notifications
      .filter((n) => n.update.sessionUpdate === 'agent_message_chunk')
      .map((n) => (n.update as { content: { text: string } }).content.text)
      .join('\n');
    expect(text).toContain("doesn't look like an Amp thread ID");
  });

  it('accepts a well-formed thread ID and persists it', async () => {
    const { conn, testClient } = makeConnection(store.paths);
    const session = await conn.newSession({ cwd: '/tmp', mcpServers: [] });
    testClient.notifications = [];
    await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: '/resume T-019e1234-abcd' }],
    });
    const text = testClient.notifications
      .filter((n) => n.update.sessionUpdate === 'agent_message_chunk')
      .map((n) => (n.update as { content: { text: string } }).content.text)
      .join('\n');
    expect(text).toContain('Switched session to Amp thread');
    expect(text).toContain('T-019e1234-abcd');
  });
});

describe('/usage on a fresh session returns the "no data yet" message', () => {
  let store: { paths: SessionStorePaths; cleanup: () => void };
  beforeEach(() => { store = tempStore(); });
  afterEach(() => { store.cleanup(); });

  it('emits the no-data placeholder', async () => {
    const { conn, testClient } = makeConnection(store.paths);
    const session = await conn.newSession({ cwd: '/tmp', mcpServers: [] });
    testClient.notifications = [];
    await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: '/usage' }],
    });
    const text = testClient.notifications
      .filter((n) => n.update.sessionUpdate === 'agent_message_chunk')
      .map((n) => (n.update as { content: { text: string } }).content.text)
      .join('\n');
    expect(text).toContain('No usage data yet');
  });
});
