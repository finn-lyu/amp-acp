import { describe, it, beforeEach, expect } from 'bun:test';
import { ClientSideConnection, AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { AmpAcpAgent } from './server.js';
import { toAcpNotifications } from './to-acp.js';
import type { SessionNotification } from '@agentclientprotocol/sdk';

class TestClient {
  notifications: SessionNotification[] = [];
  async writeTextFile() { return {}; }
  async readTextFile() { return { content: 'test' }; }
  async requestPermission() { return { outcome: { outcome: 'selected' as const, optionId: 'allow' } }; }
  async sessionUpdate(notification: SessionNotification) {
    this.notifications.push(notification);
  }
}

describe('ACP Protocol End-to-End', () => {
  let clientToAgent: TransformStream;
  let agentToClient: TransformStream;
  let agentConnection: ClientSideConnection;
  let testClient: TestClient;

  beforeEach(() => {
    clientToAgent = new TransformStream();
    agentToClient = new TransformStream();
    testClient = new TestClient();

    agentConnection = new ClientSideConnection(
      () => testClient,
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );
    new AgentSideConnection(
      (client) => new AmpAcpAgent(client),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );
  });

  it('should handle initialize request and return correct capabilities', async () => {
    const response = await agentConnection.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });

    expect(response.protocolVersion).toBe(1);
    expect(response.agentInfo?.name).toBe('amp-acp');
    expect(response.agentInfo?.version).toBeDefined();
    expect(response.agentCapabilities?.promptCapabilities?.image).toBeUndefined();
    expect(response.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(true);
    expect(response.agentCapabilities?.mcpCapabilities?.http).toBe(true);
    expect(response.agentCapabilities?.mcpCapabilities?.sse).toBe(true);
    expect(response.authMethods).toHaveLength(1);
    expect(response.authMethods![0].id).toBe('setup');
    expect(response.authMethods![0].name).toBe('Amp API Key Setup');
    expect(response.authMethods![0]._meta?.['terminal-auth']?.label).toBe('Amp API Key Setup');
  });

  it('should handle newSession and return a valid sessionId', async () => {
    const response = await agentConnection.newSession({
      cwd: '/tmp/test',
      mcpServers: [],
    });

    expect(response.sessionId).toBeDefined();
    expect(response.sessionId).toMatch(/^S-/);
    expect(response.modes?.currentModeId).toBe('smart');
    expect(response.modes?.availableModes).toHaveLength(3);
    expect(response.modes?.availableModes?.map((m) => m.id)).toEqual(['smart', 'rush', 'deep']);
  });

  it('should handle newSession with MCP servers', async () => {
    const response = await agentConnection.newSession({
      cwd: '/tmp/test',
      mcpServers: [
        {
          type: 'http',
          name: 'exa',
          url: 'https://mcp.exa.ai/mcp',
          headers: [],
        },
        {
          name: 'local-server',
          command: 'npx',
          args: ['mcp-server'],
          env: [],
        },
      ],
    });

    expect(response.sessionId).toBeDefined();
    expect(response.sessionId).toMatch(/^S-/);
  });

  it('should handle setSessionMode', async () => {
    const session = await agentConnection.newSession({
      cwd: '/tmp',
      mcpServers: [],
    });

    const result = await agentConnection.setSessionMode({
      sessionId: session.sessionId,
      modeId: 'rush',
    });

    expect(result).toEqual({});
  });

  it('should handle setSessionMode across all amp modes', async () => {
    const session = await agentConnection.newSession({
      cwd: '/tmp',
      mcpServers: [],
    });

    for (const modeId of ['smart', 'rush', 'deep']) {
      const r = await agentConnection.setSessionMode({
        sessionId: session.sessionId,
        modeId,
      });
      expect(r).toEqual({});
    }
  });

  it('should reject authenticate when AMP_API_KEY is not set', async () => {
    const saved = process.env.AMP_API_KEY;
    delete process.env.AMP_API_KEY;
    try {
      await agentConnection.authenticate({ methodId: 'setup' });
      expect(true).toBe(false);
    } catch (e: unknown) {
      expect(e).toBeDefined();
    } finally {
      if (saved) process.env.AMP_API_KEY = saved;
    }
  });

  it('should create multiple independent sessions', async () => {
    const s1 = await agentConnection.newSession({ cwd: '/tmp/a', mcpServers: [] });
    const s2 = await agentConnection.newSession({ cwd: '/tmp/b', mcpServers: [] });

    expect(s1.sessionId).not.toBe(s2.sessionId);
    expect(s1.sessionId).toMatch(/^S-/);
    expect(s2.sessionId).toMatch(/^S-/);
  });

  it('should send available_commands_update notification after newSession', async () => {
    await agentConnection.newSession({ cwd: '/tmp', mcpServers: [] });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const cmdUpdate = testClient.notifications.find(
      (n) => n.update && 'sessionUpdate' in n.update && n.update.sessionUpdate === 'available_commands_update',
    );
    expect(cmdUpdate).toBeDefined();
  });
});

describe('toAcpNotifications', () => {

  it('should convert string content to text notification', () => {
    const result = toAcpNotifications(
      { type: 'assistant', message: { content: 'Hello world' } },
      'session-1',
    );

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('session-1');
    expect(result[0].update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hello world' },
    });
  });

  it('should convert text content block', () => {
    const result = toAcpNotifications(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } },
      'session-1',
    );

    expect(result).toHaveLength(1);
    expect(result[0].update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hi' },
    });
  });

  it('should convert thinking block', () => {
    const result = toAcpNotifications(
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Analyzing...' }] } },
      'session-1',
    );

    expect(result).toHaveLength(1);
    expect(result[0].update).toMatchObject({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Analyzing...' },
    });
  });

  it('should convert tool_use block', () => {
    const result = toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/tmp/file.txt' } }],
        },
      },
      'session-1',
    );

    expect(result).toHaveLength(1);
    expect(result[0].update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'Read /tmp/file.txt',
      status: 'pending',
      kind: 'read',
      locations: [{ path: '/tmp/file.txt' }],
    });
  });

  it('should expose Bash tool calls as display-only terminals when supported', () => {
    const result = toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-bash',
              name: 'Bash',
              input: { cmd: 'git diff --cached', cwd: '/repo' },
            },
          ],
        },
      },
      'session-1',
      { createTerminalOutput: true },
    );

    expect(result).toHaveLength(1);
    expect(result[0].update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-bash',
      title: '`git diff --cached`',
      kind: 'execute',
      content: [{ type: 'terminal', terminalId: 'tool-bash' }],
      _meta: { terminal_info: { terminal_id: 'tool-bash', cwd: '/repo' } },
    });
  });

  it('should convert tool_result block (success)', () => {
    const result = toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents', is_error: false }],
        },
      },
      'session-1',
    );

    expect(result).toHaveLength(2);
    expect(result[0].update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'file contents' } }],
      rawOutput: { content: 'file contents', is_error: false },
    });
    expect(result[1].update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '**Tool output**\n```text\nfile contents\n```' },
    });
  });

  it('should stream Bash tool results through terminal metadata when supported', () => {
    const result = toAcpNotifications(
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-bash',
              content: JSON.stringify({ output: 'hello\n', exitCode: 0 }),
              is_error: false,
            },
          ],
        },
      },
      'session-1',
      { terminalOutputToolIds: new Set(['tool-bash']) },
    );

    expect(result).toHaveLength(1);
    expect(result[0].update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-bash',
      status: 'completed',
      rawOutput: { content: JSON.stringify({ output: 'hello\n', exitCode: 0 }), is_error: false },
      _meta: {
        terminal_output: { terminal_id: 'tool-bash', data: 'hello\n' },
        terminal_exit: { terminal_id: 'tool-bash', exit_code: 0 },
      },
    });
    expect('content' in result[0].update).toBe(false);
  });

  it('should convert tool_result block (error)', () => {
    const result = toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'not found', is_error: true }],
        },
      },
      'session-1',
    );

    expect(result).toHaveLength(2);
    expect(result[0].update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: '```\nnot found\n```' } }],
      rawOutput: { content: 'not found', is_error: true },
    });
    expect(result[1].update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '**Tool error**\n```text\nnot found\n```' },
    });
  });

  it('should convert structured tool_result blocks into displayable output', () => {
    const result = toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-structured',
              content: [{ type: 'json', value: { ok: true } }],
              is_error: false,
            },
          ],
        },
      },
      'session-1',
    );

    expect(result).toHaveLength(2);
    expect(result[0].update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-structured',
      status: 'completed',
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify({ type: 'json', value: { ok: true } }, null, 2),
          },
        },
      ],
      rawOutput: { content: [{ type: 'json', value: { ok: true } }], is_error: false },
    });
    expect(result[1].update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: `**Tool output**\n\`\`\`text\n${JSON.stringify({ type: 'json', value: { ok: true } }, null, 2)}\n\`\`\``,
      },
    });
  });

  it('should convert image block with base64 source', () => {
    const result = toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'image', source: { type: 'base64', data: 'abc123', media_type: 'image/png' } }],
        },
      },
      'session-1',
    );

    expect(result).toHaveLength(1);
    expect(result[0].update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', data: 'abc123', mimeType: 'image/png' },
    });
  });

  it('should handle mixed content blocks', () => {
    const result = toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Let me think...' },
            { type: 'text', text: 'Here is the answer' },
            { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { cmd: 'ls' } },
          ],
        },
      },
      'session-1',
    );

    expect(result).toHaveLength(3);
    expect(result[0].update).toMatchObject({ sessionUpdate: 'agent_thought_chunk' });
    expect(result[1].update).toMatchObject({ sessionUpdate: 'agent_message_chunk' });
    expect(result[2].update).toMatchObject({ sessionUpdate: 'tool_call', title: '`ls`' });
  });

  it('should return empty for missing message', () => {
    const result = toAcpNotifications({ type: 'assistant' }, 'session-1');
    expect(result).toHaveLength(0);
  });
});
