import { describe, it, expect } from 'bun:test';
import { inferToolKind, extractToolLocations, extractDiffContent, toAcpNotifications } from './to-acp.js';

describe('inferToolKind', () => {
  it('maps Amp built-in tools to ACP kinds', () => {
    expect(inferToolKind('Bash')).toBe('execute');
    expect(inferToolKind('Read')).toBe('read');
    expect(inferToolKind('read_thread')).toBe('read');
    expect(inferToolKind('view_image')).toBe('read');
    expect(inferToolKind('edit_file')).toBe('edit');
    expect(inferToolKind('create_file')).toBe('edit');
    expect(inferToolKind('finder')).toBe('search');
    expect(inferToolKind('find_thread')).toBe('search');
    expect(inferToolKind('read_web_page')).toBe('fetch');
    expect(inferToolKind('web_search')).toBe('fetch');
    expect(inferToolKind('oracle')).toBe('think');
    expect(inferToolKind('librarian')).toBe('think');
    expect(inferToolKind('Task')).toBe('think');
  });

  it('falls back to other for unknown / MCP tools', () => {
    expect(inferToolKind('painter')).toBe('other');
    expect(inferToolKind('some_mcp_tool')).toBe('other');
    expect(inferToolKind('')).toBe('other');
    expect(inferToolKind(undefined)).toBe('other');
  });
});

describe('extractToolLocations', () => {
  it('returns path + line for Read with offset', () => {
    expect(extractToolLocations('Read', { path: '/a/b.ts', offset: 42 })).toEqual([{ path: '/a/b.ts', line: 42 }]);
  });

  it('returns path-only for edit_file when no line info present', () => {
    expect(extractToolLocations('edit_file', { path: '/a/b.ts', old_string: 'x', new_string: 'y' })).toEqual([
      { path: '/a/b.ts' },
    ]);
  });

  it('reads file_path when path is absent (Claude-style tool inputs)', () => {
    expect(extractToolLocations('Edit', { file_path: '/c.ts' })).toEqual([{ path: '/c.ts' }]);
  });

  it('returns undefined for tools without file targets', () => {
    expect(extractToolLocations('Bash', { cmd: 'ls' })).toBeUndefined();
    expect(extractToolLocations('oracle', { question: 'why' })).toBeUndefined();
  });

  it('returns undefined when no path key is present', () => {
    expect(extractToolLocations('Read', { offset: 1 })).toBeUndefined();
  });
});

describe('extractDiffContent', () => {
  it('produces a diff content block for edit_file with old/new strings', () => {
    const c = extractDiffContent('edit_file', { path: '/a.ts', old_string: 'foo', new_string: 'bar' });
    expect(c).toEqual([{ type: 'diff', path: '/a.ts', oldText: 'foo', newText: 'bar' }]);
  });

  it('produces a new-file diff (oldText null) for create_file', () => {
    const c = extractDiffContent('create_file', { path: '/new.ts', content: 'export {};' });
    expect(c).toEqual([{ type: 'diff', path: '/new.ts', oldText: null, newText: 'export {};' }]);
  });

  it('produces a diff for Write/Edit Claude-style names', () => {
    expect(extractDiffContent('Write', { file_path: '/x.ts', content: 'hi' })).toEqual([
      { type: 'diff', path: '/x.ts', oldText: null, newText: 'hi' },
    ]);
    expect(extractDiffContent('Edit', { file_path: '/x.ts', old_string: 'a', new_string: 'b' })).toEqual([
      { type: 'diff', path: '/x.ts', oldText: 'a', newText: 'b' },
    ]);
  });

  it('uses null oldText when edit_file has no old_string field', () => {
    const c = extractDiffContent('edit_file', { path: '/a.ts', new_string: 'only-new' });
    expect(c).toEqual([{ type: 'diff', path: '/a.ts', oldText: null, newText: 'only-new' }]);
  });

  it('returns undefined for non-edit tools', () => {
    expect(extractDiffContent('Bash', { cmd: 'ls' })).toBeUndefined();
    expect(extractDiffContent('Read', { path: '/a.ts' })).toBeUndefined();
  });
});

describe('toAcpNotifications: full integration of kind/locations/diff', () => {
  it('attaches kind, locations, and diff content to an edit_file tool_use', () => {
    const out = toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'edit_file',
              input: { path: '/repo/file.ts', old_string: 'foo', new_string: 'bar' },
            },
          ],
        },
      },
      'sess-1',
    );
    expect(out).toHaveLength(1);
    expect(out[0].update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'edit_file',
      kind: 'edit',
      locations: [{ path: '/repo/file.ts' }],
      content: [{ type: 'diff', path: '/repo/file.ts', oldText: 'foo', newText: 'bar' }],
    });
  });

  it('does NOT attach locations or diff content for Bash', () => {
    const out = toAcpNotifications(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { cmd: 'ls' } }] },
      },
      'sess-1',
    );
    expect(out).toHaveLength(1);
    expect(out[0].update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'b1',
      kind: 'execute',
      content: [],
    });
    expect((out[0].update as { locations?: unknown }).locations).toBeUndefined();
  });
});
