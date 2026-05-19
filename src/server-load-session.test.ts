import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClientSideConnection, AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { AmpAcpAgent } from './server.js';
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
