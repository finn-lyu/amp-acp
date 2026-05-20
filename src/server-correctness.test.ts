import { describe, it, expect } from 'bun:test';
import { mapStopReason, parsePrompt } from './server.js';
import { toAcpNotifications } from './to-acp.js';
import type { StreamMessage } from '@ampcode/sdk';

describe('parsePrompt', () => {
  it('concatenates text blocks verbatim', () => {
    const { text, warnings } = parsePrompt([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ]);
    expect(text).toBe('hello world');
    expect(warnings).toEqual([]);
  });

  it('expands /init to the AGENTS.md generation prompt', () => {
    const { text } = parsePrompt([{ type: 'text', text: '/init' }]);
    expect(text).toContain('create an AGENTS.md file');
  });

  it('inlines resource_link URIs on their own line', () => {
    const { text } = parsePrompt([{ type: 'resource_link', uri: 'file:///tmp/foo.md', name: 'foo' }]);
    expect(text).toContain('file:///tmp/foo.md');
  });

  it('wraps embedded text resources in <context> tags', () => {
    const { text } = parsePrompt([
      { type: 'resource', resource: { uri: 'file:///x.txt', mimeType: 'text/plain', text: 'BODY' } },
    ]);
    expect(text).toContain('<context ref="file:///x.txt">');
    expect(text).toContain('BODY');
  });

  it('emits a warning for binary blob resources and drops the bytes', () => {
    const { text, warnings } = parsePrompt([
      { type: 'resource', resource: { uri: 'file:///x.bin', mimeType: 'application/octet-stream', blob: 'aGVsbG8=' } },
    ]);
    expect(text).toBe('');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('file:///x.bin');
    expect(warnings[0]).toContain('application/octet-stream');
  });

  it('emits a warning for image blocks and drops them', () => {
    const { text, warnings } = parsePrompt([
      { type: 'image', mimeType: 'image/png', data: 'abc' },
    ]);
    expect(text).toBe('');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Image attachments are not supported');
  });
});

describe('mapStopReason', () => {
  const empty: StreamMessage | null = null;

  it('returns cancelled when the session was cancelled', () => {
    expect(mapStopReason({ cancelled: true, result: empty, lastAssistantStopReason: null })).toBe('cancelled');
    expect(mapStopReason({ cancelled: true, result: empty, lastAssistantStopReason: 'end_turn' })).toBe('cancelled');
  });

  it('maps error_max_turns to max_turn_requests', () => {
    const result: StreamMessage = {
      type: 'result',
      session_id: 's',
      duration_ms: 0,
      num_turns: 10,
      subtype: 'error_max_turns',
      is_error: true,
      error: 'too many turns',
    };
    expect(mapStopReason({ cancelled: false, result, lastAssistantStopReason: null })).toBe('max_turn_requests');
  });

  it('maps error_during_execution to end_turn (error chunk is already streamed; refusal is reserved for model-side refusals)', () => {
    const result: StreamMessage = {
      type: 'result',
      session_id: 's',
      duration_ms: 0,
      num_turns: 1,
      subtype: 'error_during_execution',
      is_error: true,
      error: 'boom',
    };
    expect(mapStopReason({ cancelled: false, result, lastAssistantStopReason: null })).toBe('end_turn');
  });

  it('maps a successful result with max_tokens stop_reason to max_tokens', () => {
    const result: StreamMessage = {
      type: 'result',
      session_id: 's',
      duration_ms: 0,
      num_turns: 1,
      subtype: 'success',
      is_error: false,
      result: 'ok',
    };
    expect(mapStopReason({ cancelled: false, result, lastAssistantStopReason: 'max_tokens' })).toBe('max_tokens');
  });

  it('defaults a successful result to end_turn', () => {
    const result: StreamMessage = {
      type: 'result',
      session_id: 's',
      duration_ms: 0,
      num_turns: 1,
      subtype: 'success',
      is_error: false,
      result: 'ok',
    };
    expect(mapStopReason({ cancelled: false, result, lastAssistantStopReason: 'end_turn' })).toBe('end_turn');
    expect(mapStopReason({ cancelled: false, result, lastAssistantStopReason: null })).toBe('end_turn');
    expect(mapStopReason({ cancelled: false, result, lastAssistantStopReason: 'tool_use' })).toBe('end_turn');
  });

  it('defaults to end_turn when no result message arrived (defensive)', () => {
    expect(mapStopReason({ cancelled: false, result: null, lastAssistantStopReason: null })).toBe('end_turn');
  });
});

describe('toAcpNotifications: user-message routing', () => {
  it('forwards tool_result blocks from user messages so tool_call_update fires', () => {
    const out = toAcpNotifications(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-7', content: 'ok', is_error: false }],
        },
      },
      'session-1',
    );
    expect(out).toHaveLength(2);
    expect(out[0].update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-7',
      status: 'completed',
    });
    expect(out[1].update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '**Tool output**\n```text\nok\n```' },
    });
  });

  it('does NOT echo text content from user messages back to the client', () => {
    const out = toAcpNotifications(
      {
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'this is the original prompt — do not echo' },
            { type: 'tool_result', tool_use_id: 'tool-8', content: 'r', is_error: false },
          ],
        },
      },
      'session-1',
    );
    // Only the tool_result should pass through, along with its display mirror.
    expect(out).toHaveLength(2);
    expect(out[0].update).toMatchObject({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-8' });
    expect(out[1].update).toMatchObject({ sessionUpdate: 'agent_message_chunk' });
  });

  it('returns no notifications for a user message with a plain string body', () => {
    const out = toAcpNotifications(
      { type: 'user', message: { content: 'echoed prompt' } },
      'session-1',
    );
    expect(out).toEqual([]);
  });
});
