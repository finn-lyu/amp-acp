import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClientSideConnection, AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { AmpAcpAgent, type AmpUsageCommandResult } from './server.js';
import { recordSession, appendLogEntry, type SessionStorePaths } from './session-store.js';

class TestClient {
  notifications: SessionNotification[] = [];
  async writeTextFile() { return {}; }
  async readTextFile() { return { content: '' }; }
  async requestPermission() { return { outcome: { outcome: 'selected' as const, optionId: 'allow' } }; }
  async sessionUpdate(n: SessionNotification) { this.notifications.push(n); }
}

function makeConnection(storePaths: SessionStorePaths) {
  const clientToAgent = new TransformStream();
  const agentToClient = new TransformStream();
  const testClient = new TestClient();
  const usageRunner = async (): Promise<AmpUsageCommandResult> => ({
    stdout: 'Balance: $42.00\nToday: $0.25',
    stderr: '',
    exitCode: 0,
  });
  const conn = new ClientSideConnection(
    () => testClient,
    ndJsonStream(clientToAgent.writable, agentToClient.readable),
  );
  new AgentSideConnection(
    (client) => new AmpAcpAgent(client, storePaths, { usageRunner }),
    ndJsonStream(agentToClient.writable, clientToAgent.readable),
  );
  return { conn, testClient };
}

function tempStore(): { paths: SessionStorePaths; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-acp-load-'));
  return {
    paths: { indexFile: path.join(dir, 'sessions.json'), logsDir: path.join(dir, 'sessions') },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe('initialize advertises loadSession capability', () => {
  it('returns loadSession: true', async () => {
    const store = tempStore();
    try {
      const { conn } = makeConnection(store.paths);
      const r = await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
      expect(r.agentCapabilities?.loadSession).toBe(true);
    } finally {
      store.cleanup();
    }
  });
});

describe('loadSession', () => {
  let store: { paths: SessionStorePaths; cleanup: () => void };
  beforeEach(() => { store = tempStore(); });
  afterEach(() => { store.cleanup(); });

  it('throws when the sessionId is unknown', async () => {
    const { conn } = makeConnection(store.paths);
    await expect(
      conn.loadSession({ sessionId: 'S-missing', cwd: '/tmp', mcpServers: [] }),
    ).rejects.toThrow(/Session not found/);
  });

  it('reconstructs in-memory state and restores the persisted mode', async () => {
    recordSession(store.paths, 'S-known', { threadId: 'T-known', mode: 'deep', lastUsedMs: Date.now() });

    const { conn } = makeConnection(store.paths);
    const r = await conn.loadSession({ sessionId: 'S-known', cwd: '/tmp/cwd', mcpServers: [] });
    expect(r.modes?.currentModeId).toBe('deep');
    expect(r.modes?.availableModes.map((m) => m.id)).toEqual(['smart', 'rush', 'deep']);

    // setSessionMode should now succeed against the restored session.
    await expect(
      conn.setSessionMode({ sessionId: 'S-known', modeId: 'rush' }),
    ).resolves.toEqual({});
  });

  it('replays prior assistant text from the per-session log', async () => {
    recordSession(store.paths, 'S-replay', { threadId: 'T-replay', mode: 'smart', lastUsedMs: Date.now() });
    appendLogEntry(store.paths, 'S-replay', {
      type: 'assistant',
      session_id: 'T-replay',
      message: { content: [{ type: 'text', text: 'hello from the past' }] },
    });
    appendLogEntry(store.paths, 'S-replay', {
      type: 'assistant',
      session_id: 'T-replay',
      message: {
        content: [{ type: 'tool_use', id: 'tool-old', name: 'Read', input: { path: '/file.ts' } }],
      },
    });
    appendLogEntry(store.paths, 'S-replay', {
      type: 'user',
      session_id: 'T-replay',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-old', content: 'file body', is_error: false }] },
    });

    const { conn, testClient } = makeConnection(store.paths);
    await conn.loadSession({ sessionId: 'S-replay', cwd: '/tmp', mcpServers: [] });

    const updates = testClient.notifications
      .filter((n) => n.sessionId === 'S-replay')
      .map((n) => n.update);

    // text chunk + tool_call + tool_call_update for the completed tool
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }),
        expect.objectContaining({ sessionUpdate: 'tool_call', toolCallId: 'tool-old', kind: 'read' }),
        expect.objectContaining({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-old', status: 'completed' }),
        expect.objectContaining({ sessionUpdate: 'available_commands_update' }),
      ]),
    );
  });

  it('hydrates latest usage from the per-session log for /usage after restore', async () => {
    recordSession(store.paths, 'S-usage', { threadId: 'T-usage', mode: 'smart', lastUsedMs: Date.now() });
    appendLogEntry(store.paths, 'S-usage', {
      type: 'assistant',
      session_id: 'T-usage',
      message: {
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/file.ts' } }],
        usage: {
          input_tokens: 10,
          output_tokens: 100,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 50,
        },
      },
    });
    appendLogEntry(store.paths, 'S-usage', {
      type: 'assistant',
      session_id: 'T-usage',
      message: {
        content: [{ type: 'text', text: 'done' }],
        usage: {
          input_tokens: 6,
          output_tokens: 25,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 10,
        },
      },
    });
    appendLogEntry(store.paths, 'S-usage', {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1234,
      num_turns: 2,
      session_id: 'T-usage',
      result: 'done',
    });

    const { conn, testClient } = makeConnection(store.paths);
    await conn.loadSession({ sessionId: 'S-usage', cwd: '/tmp', mcpServers: [] });
    testClient.notifications = [];

    await conn.prompt({ sessionId: 'S-usage', prompt: [{ type: 'text', text: '/usage' }] });

    const text = testClient.notifications
      .filter((n) => n.update.sessionUpdate === 'agent_message_chunk')
      .map((n) => (n.update as { content: { text: string } }).content.text)
      .join('\n');
    expect(text).toContain('Balance: $42.00');
    expect(text).toContain('Input: 16 tokens');
    expect(text).toContain('Output: 125 tokens');
    expect(text).toContain('Cache read: 60 tokens');
    expect(text).toContain('Cache write: 7 tokens');
    expect(text).toContain('Duration: 1.23s');
    expect(text).toContain('Turns: 2');
  });
});

describe('setSessionMode emits current_mode_update', () => {
  let store: { paths: SessionStorePaths; cleanup: () => void };
  beforeEach(() => { store = tempStore(); });
  afterEach(() => { store.cleanup(); });

  it('pushes a current_mode_update notification after a successful mode switch', async () => {
    const { conn, testClient } = makeConnection(store.paths);
    const session = await conn.newSession({ cwd: '/tmp', mcpServers: [] });
    testClient.notifications = []; // ignore the available_commands_update from newSession

    await conn.setSessionMode({ sessionId: session.sessionId, modeId: 'deep' });

    const update = testClient.notifications.find(
      (n) =>
        n.sessionId === session.sessionId &&
        n.update.sessionUpdate === 'current_mode_update',
    );
    expect(update).toBeDefined();
    expect(update?.update).toMatchObject({ sessionUpdate: 'current_mode_update', currentModeId: 'deep' });
  });
});
