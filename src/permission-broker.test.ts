import { describe, it, expect, beforeEach } from 'bun:test';
import { Readable } from 'node:stream';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import {
  buildPermissionRequest,
  permissionDecisionKey,
  permissionHelperExitCode,
  resolvePermissionDecision,
  runPermissionHelper,
  type PermissionDecision,
  type PermissionSessionState,
} from './permission-broker.js';

class PermissionClient {
  requests: RequestPermissionRequest[] = [];
  responses: RequestPermissionResponse[] = [];

  async requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.requests.push(request);
    return this.responses.shift() ?? { outcome: { outcome: 'selected', optionId: 'allow_once' } };
  }
}

describe('PermissionBroker delegated decisions', () => {
  let client: PermissionClient;
  let session: PermissionSessionState;

  beforeEach(() => {
    client = new PermissionClient();
    session = { permissionDecisions: new Map() };
  });

  async function ask(
    input: unknown,
    activeSession: PermissionSessionState = session,
  ): Promise<PermissionDecision> {
    return resolvePermissionDecision({
      client,
      session: activeSession,
      sessionId: 'S-1',
      toolName: 'create_file',
      input: input as Record<string, unknown>,
      toolCallId: 'tc-1',
    });
  }

  it('returns allow when the client selects allow_once', async () => {
    client.responses.push({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
    const decision = await ask({ path: '/tmp/a.txt', content: 'hello' });

    expect(decision).toBe('allow');
    expect(permissionHelperExitCode(decision)).toBe(0);
    expect(client.requests).toHaveLength(1);
  });

  it('returns reject when the client selects reject_once', async () => {
    client.responses.push({ outcome: { outcome: 'selected', optionId: 'reject_once' } });
    const decision = await ask({ path: '/tmp/a.txt', content: 'hello' });

    expect(decision).toBe('reject');
    expect(permissionHelperExitCode(decision)).toBe(2);
  });

  it('returns reject when the client cancels', async () => {
    client.responses.push({ outcome: { outcome: 'cancelled' } });
    await expect(ask({ path: '/tmp/a.txt', content: 'hello' })).resolves.toBe('reject');
  });

  it('fails closed for malformed helper stdin', async () => {
    const decision = await runPermissionHelper(
      {
        AMP_ACP_PERMISSION_SOCKET: '/missing.sock',
        AMP_ACP_PERMISSION_TOKEN: 'token',
        AMP_ACP_PERMISSION_SESSION_ID: 'S-1',
        AGENT_TOOL_NAME: 'create_file',
      },
      Readable.from(['not-json']),
    );

    expect(decision).toBe('reject');
    expect(client.requests).toHaveLength(0);
  });

  it('remembers allow_always only within the active session', async () => {
    client.responses.push({ outcome: { outcome: 'selected', optionId: 'allow_always' } });
    await expect(ask({ path: '/tmp/a.txt', content: 'one' })).resolves.toBe('allow');
    await expect(ask({ path: '/tmp/a.txt', content: 'two' })).resolves.toBe('allow');
    expect(client.requests).toHaveLength(1);

    await ask({ path: '/tmp/a.txt', content: 'three' }, { permissionDecisions: new Map() });

    expect(client.requests).toHaveLength(2);
  });

  it('remembers reject_always for later matching calls in the same session', async () => {
    client.responses.push({ outcome: { outcome: 'selected', optionId: 'reject_always' } });

    await expect(ask({ path: '/tmp/a.txt', content: 'one' })).resolves.toBe('reject');
    await expect(ask({ path: '/tmp/a.txt', content: 'two' })).resolves.toBe('reject');
    expect(client.requests).toHaveLength(1);
  });
});

describe('ACP permission request construction', () => {
  it('includes file location and diff content for create_file', () => {
    const request = buildPermissionRequest({
      sessionId: 'S-1',
      toolName: 'create_file',
      toolCallId: 'tc-1',
      input: { path: '/tmp/a.txt', content: 'hello' },
    });

    expect(request.options.map((o) => o.kind)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
      'reject_always',
    ]);
    expect(request.toolCall).toMatchObject({
      toolCallId: 'tc-1',
      kind: 'edit',
      status: 'pending',
      locations: [{ path: '/tmp/a.txt' }],
      content: [{ type: 'diff', path: '/tmp/a.txt', oldText: null, newText: 'hello' }],
    });
  });

  it('uses execute kind and raw command input for Bash', () => {
    const request = buildPermissionRequest({
      sessionId: 'S-1',
      toolName: 'Bash',
      toolCallId: 'tc-2',
      input: { cmd: 'touch a.txt' },
    });

    expect(request.toolCall).toMatchObject({
      kind: 'execute',
      title: '`touch a.txt`',
      rawInput: { cmd: 'touch a.txt' },
    });
  });

  it('uses conservative cache keys for files and bash commands', () => {
    expect(permissionDecisionKey('create_file', { path: '/tmp/a.txt', content: 'one' }))
      .toBe(permissionDecisionKey('create_file', { path: '/tmp/a.txt', content: 'two' }));
    expect(permissionDecisionKey('Bash', { cmd: 'touch a.txt' }))
      .toBe(permissionDecisionKey('Bash', { cmd: 'touch a.txt', timeout: 10 }));
  });
});
