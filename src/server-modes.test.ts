import { describe, it, expect } from 'bun:test';
import { ClientSideConnection, AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { AmpAcpAgent, buildAmpOptions, isAmpMode, readBooleanEnv } from './server.js';

class TestClient {
  async writeTextFile() { return {}; }
  async readTextFile() { return { content: '' }; }
  async requestPermission() { return { outcome: { outcome: 'selected' as const, optionId: 'allow' } }; }
  async sessionUpdate(_n: SessionNotification) {}
}

function makeConnection() {
  const clientToAgent = new TransformStream();
  const agentToClient = new TransformStream();
  const conn = new ClientSideConnection(
    () => new TestClient(),
    ndJsonStream(clientToAgent.writable, agentToClient.readable),
  );
  new AgentSideConnection(
    (client) => new AmpAcpAgent(client),
    ndJsonStream(agentToClient.writable, clientToAgent.readable),
  );
  return conn;
}

describe('Amp mode advertisement', () => {
  it('newSession advertises [smart, rush, deep] with smart as default', async () => {
    const conn = makeConnection();
    const response = await conn.newSession({ cwd: '/tmp', mcpServers: [] });

    expect(response.modes?.currentModeId).toBe('smart');
    expect(response.modes?.availableModes?.map((m) => m.id)).toEqual(['smart', 'rush', 'deep']);
    expect(response.modes?.availableModes?.map((m) => m.name)).toEqual(['Smart', 'Rush', 'Deep']);
    expect(response.configOptions?.find((option) => option.id === 'mode')).toMatchObject({
      id: 'mode',
      name: 'Mode',
      type: 'select',
      category: 'mode',
      currentValue: 'smart',
      options: [
        { value: 'smart', name: 'Smart' },
        { value: 'rush', name: 'Rush' },
        { value: 'deep', name: 'Deep' },
      ],
    });
    expect(response.configOptions?.find((option) => option.id === 'thinking')).toMatchObject({
      id: 'thinking',
      name: 'Thinking',
      type: 'select',
      category: 'thinking',
      currentValue: 'on',
      options: [
        { value: 'on', name: 'Thinking on' },
        { value: 'off', name: 'Thinking off' },
      ],
    });
  });
});

describe('thinking config option', () => {
  it('switches thinking on/off through session config options', async () => {
    const conn = makeConnection();
    const session = await conn.newSession({ cwd: '/tmp', mcpServers: [] });

    const off = await conn.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'thinking',
      value: 'off',
    });
    expect(off.configOptions.find((option) => option.id === 'thinking')).toMatchObject({
      id: 'thinking',
      currentValue: 'off',
    });

    const on = await conn.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'thinking',
      value: 'on',
    });
    expect(on.configOptions.find((option) => option.id === 'thinking')).toMatchObject({
      id: 'thinking',
      currentValue: 'on',
    });
  });

  it('switches Amp mode through session config options', async () => {
    const conn = makeConnection();
    const session = await conn.newSession({ cwd: '/tmp', mcpServers: [] });

    const response = await conn.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'mode',
      value: 'rush',
    });

    expect(response.configOptions.find((option) => option.id === 'mode')).toMatchObject({
      id: 'mode',
      currentValue: 'rush',
    });
  });

  it('rejects unknown thinking values', async () => {
    const conn = makeConnection();
    const session = await conn.newSession({ cwd: '/tmp', mcpServers: [] });

    await expect(
      conn.setSessionConfigOption({ sessionId: session.sessionId, configId: 'thinking', value: 'maybe' }),
    ).rejects.toThrow(/Unknown thinking option/);
  });
});

describe('setSessionMode validation', () => {
  it('accepts each valid Amp mode', async () => {
    const conn = makeConnection();
    const session = await conn.newSession({ cwd: '/tmp', mcpServers: [] });

    for (const modeId of ['smart', 'rush', 'deep']) {
      const r = await conn.setSessionMode({ sessionId: session.sessionId, modeId });
      expect(r).toEqual({});
    }
  });

  it('rejects large (SDK accepts it but we do not advertise it)', async () => {
    const conn = makeConnection();
    const session = await conn.newSession({ cwd: '/tmp', mcpServers: [] });

    await expect(
      conn.setSessionMode({ sessionId: session.sessionId, modeId: 'large' }),
    ).rejects.toThrow(/Unknown mode/);
  });

  it('rejects legacy default/bypass mode IDs', async () => {
    const conn = makeConnection();
    const session = await conn.newSession({ cwd: '/tmp', mcpServers: [] });

    await expect(
      conn.setSessionMode({ sessionId: session.sessionId, modeId: 'default' }),
    ).rejects.toThrow(/Unknown mode/);
    await expect(
      conn.setSessionMode({ sessionId: session.sessionId, modeId: 'bypass' }),
    ).rejects.toThrow(/Unknown mode/);
  });

  it('rejects arbitrary unknown mode IDs', async () => {
    const conn = makeConnection();
    const session = await conn.newSession({ cwd: '/tmp', mcpServers: [] });

    await expect(
      conn.setSessionMode({ sessionId: session.sessionId, modeId: 'bogus' }),
    ).rejects.toThrow(/Unknown mode/);
  });
});

describe('isAmpMode type guard', () => {
  it('returns true for smart/rush/deep and false for everything else', () => {
    expect(isAmpMode('smart')).toBe(true);
    expect(isAmpMode('rush')).toBe(true);
    expect(isAmpMode('deep')).toBe(true);
    expect(isAmpMode('large')).toBe(false);
    expect(isAmpMode('default')).toBe(false);
    expect(isAmpMode('bypass')).toBe(false);
    expect(isAmpMode('')).toBe(false);
    expect(isAmpMode(undefined)).toBe(false);
    expect(isAmpMode(null)).toBe(false);
    expect(isAmpMode(42)).toBe(false);
  });
});

describe('Amp option environment flags', () => {
  it('parses boolean env values using true/false only', () => {
    expect(readBooleanEnv('FLAG', false, { FLAG: 'true' })).toBe(true);
    expect(readBooleanEnv('FLAG', true, { FLAG: 'false' })).toBe(false);
    expect(readBooleanEnv('FLAG', true, {})).toBe(true);
    expect(readBooleanEnv('FLAG', false, { FLAG: '1' })).toBe(false);
  });

  it('adds delegated permission rules by default when a helper is provided', () => {
    const options = buildAmpOptions(
      {
        cwd: '/tmp',
        mode: 'smart',
        mcpConfig: {},
        threadId: null,
        permissionDelegate: { helperCommand: '/tmp/helper.js', env: { AMP_ACP_PERMISSION_SOCKET: '/tmp/sock' } },
      },
      {},
    );

    expect(options.dangerouslyAllowAll).toBeUndefined();
    expect(options.permissions?.map((p) => [p.tool, p.action, p.to])).toEqual([
      ['Bash', 'delegate', '/tmp/helper.js'],
      ['Bash', 'delegate', '/tmp/helper.js'],
      ['create_file', 'delegate', '/tmp/helper.js'],
      ['edit_file', 'delegate', '/tmp/helper.js'],
      ['edit_file', 'delegate', '/tmp/helper.js'],
      ['Write', 'delegate', '/tmp/helper.js'],
      ['Write', 'delegate', '/tmp/helper.js'],
      ['Edit', 'delegate', '/tmp/helper.js'],
      ['Edit', 'delegate', '/tmp/helper.js'],
      ['Edit', 'delegate', '/tmp/helper.js'],
    ]);
    expect(options.permissions?.map((p) => p.matches)).toEqual([
      { cmd: '*' },
      { command: '*' },
      { path: '*' },
      { path: '*' },
      { diff: '*' },
      { path: '*' },
      { file_path: '*' },
      { path: '*' },
      { file_path: '*' },
      { diff: '*' },
    ]);
    expect(options.env?.AMP_ACP_PERMISSION_SOCKET).toBe('/tmp/sock');
  });

  it('does not enable the unsafe bypass by default when delegated permission prompts are disabled', () => {
    const options = buildAmpOptions(
      { cwd: '/tmp', mode: 'smart', mcpConfig: {}, threadId: null },
      { AMP_ACP_PERMISSION_PROMPTS: 'false' },
    );

    expect(options.dangerouslyAllowAll).toBeUndefined();
    expect(options.permissions).toBeUndefined();
  });

  it('allows explicitly enabling the unsafe bypass when delegated prompts are disabled', () => {
    const options = buildAmpOptions(
      { cwd: '/tmp', mode: 'smart', mcpConfig: {}, threadId: null },
      { AMP_ACP_PERMISSION_PROMPTS: 'false', AMP_ACP_DANGEROUSLY_ALLOW_ALL: 'true' },
    );

    expect(options.dangerouslyAllowAll).toBe(true);
  });

  it('enables thinking by default and allows AMP_ACP_THINKING=false to disable it', () => {
    expect(buildAmpOptions({ cwd: '/tmp', mode: 'deep', mcpConfig: {}, threadId: null }, {}).thinking).toBe(true);
    expect(
      buildAmpOptions(
        { cwd: '/tmp', mode: 'deep', mcpConfig: {}, threadId: null },
        { AMP_ACP_THINKING: 'false' },
    ).thinking,
    ).toBe(false);
  });

  it('lets session config override the env thinking default', () => {
    expect(
      buildAmpOptions(
        { cwd: '/tmp', mode: 'deep', mcpConfig: {}, threadId: null, thinking: true },
        { AMP_ACP_THINKING: 'false' },
      ).thinking,
    ).toBe(true);
  });
});
