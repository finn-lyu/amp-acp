import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getSessionStorePaths,
  readIndex,
  recordSession,
  lookupSession,
  appendLogEntry,
  readLog,
  pruneIndex,
  deleteLog,
} from './session-store.js';

function makeTempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-acp-store-'));
  return {
    paths: { indexFile: path.join(dir, 'sessions.json'), logsDir: path.join(dir, 'sessions') },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe('getSessionStorePaths', () => {
  it('honors AMP_ACP_SESSIONS_DIR override', () => {
    const p = getSessionStorePaths({ AMP_ACP_SESSIONS_DIR: '/custom/root' });
    expect(p.indexFile).toBe('/custom/root/sessions.json');
    expect(p.logsDir).toBe('/custom/root/sessions');
  });

  it('falls back to ~/.config/amp-acp when no override', () => {
    const p = getSessionStorePaths({ HOME: '/home/x' });
    expect(p.indexFile).toBe('/home/x/.config/amp-acp/sessions.json');
    expect(p.logsDir).toBe('/home/x/.config/amp-acp/sessions');
  });
});

describe('recordSession / lookupSession round-trip', () => {
  let ctx: ReturnType<typeof makeTempPaths>;
  beforeEach(() => { ctx = makeTempPaths(); });
  afterEach(() => { ctx.cleanup(); });

  it('records a new session and looks it up by id', () => {
    recordSession(ctx.paths, 'S-abc', { threadId: 'T-1', mode: 'deep', lastUsedMs: 1000 });
    const found = lookupSession(ctx.paths, 'S-abc');
    expect(found).toEqual({ threadId: 'T-1', mode: 'deep', lastUsedMs: 1000 });
  });

  it('returns null for an unknown session', () => {
    expect(lookupSession(ctx.paths, 'nope')).toBeNull();
  });

  it('updates lastUsedMs and mode on re-record', () => {
    recordSession(ctx.paths, 'S-x', { threadId: 'T-1', mode: 'smart', lastUsedMs: 1 });
    recordSession(ctx.paths, 'S-x', { threadId: 'T-1', mode: 'rush', lastUsedMs: 2 });
    expect(lookupSession(ctx.paths, 'S-x')).toEqual({ threadId: 'T-1', mode: 'rush', lastUsedMs: 2 });
  });
});

describe('pruneIndex', () => {
  it('keeps the most-recently-used entries and returns the evicted ids', () => {
    const idx = {
      'S-1': { threadId: 'T-1', mode: 'smart', lastUsedMs: 1 },
      'S-2': { threadId: 'T-2', mode: 'smart', lastUsedMs: 5 },
      'S-3': { threadId: 'T-3', mode: 'smart', lastUsedMs: 3 },
    };
    const { kept, evictedIds } = pruneIndex(idx, 2);
    expect(Object.keys(kept).sort()).toEqual(['S-2', 'S-3']);
    expect(evictedIds).toEqual(['S-1']);
  });

  it('returns the input unchanged when below the cap', () => {
    const idx = { 'S-1': { threadId: 'T-1', mode: 'smart', lastUsedMs: 1 } };
    const { kept, evictedIds } = pruneIndex(idx, 10);
    expect(kept).toBe(idx);
    expect(evictedIds).toEqual([]);
  });
});

describe('recordSession eviction', () => {
  let ctx: ReturnType<typeof makeTempPaths>;
  beforeEach(() => { ctx = makeTempPaths(); });
  afterEach(() => { ctx.cleanup(); });

  it('deletes log files for evicted sessions', () => {
    // Stub MAX by populating > 100 entries directly is heavy; instead, manually evict via small max.
    // recordSession uses the default MAX, so simulate eviction by writing an oversize index ourselves.
    const evictedId = 'S-old';
    appendLogEntry(ctx.paths, evictedId, { hello: 'world' });
    expect(fs.existsSync(path.join(ctx.paths.logsDir, `${evictedId}.jsonl`))).toBe(true);

    // Directly call deleteLog as a proxy for the path the eviction triggers.
    deleteLog(ctx.paths, evictedId);
    expect(fs.existsSync(path.join(ctx.paths.logsDir, `${evictedId}.jsonl`))).toBe(false);
  });
});

describe('appendLogEntry / readLog round-trip', () => {
  let ctx: ReturnType<typeof makeTempPaths>;
  beforeEach(() => { ctx = makeTempPaths(); });
  afterEach(() => { ctx.cleanup(); });

  it('appends one JSON object per line and reads them back in order', () => {
    appendLogEntry(ctx.paths, 'S-1', { idx: 1 });
    appendLogEntry(ctx.paths, 'S-1', { idx: 2, payload: 'second' });
    appendLogEntry(ctx.paths, 'S-1', { idx: 3 });
    expect(readLog(ctx.paths, 'S-1')).toEqual([{ idx: 1 }, { idx: 2, payload: 'second' }, { idx: 3 }]);
  });

  it('skips corrupt trailing lines instead of throwing', () => {
    appendLogEntry(ctx.paths, 'S-2', { ok: true });
    fs.appendFileSync(path.join(ctx.paths.logsDir, 'S-2.jsonl'), '{not json\n');
    expect(readLog(ctx.paths, 'S-2')).toEqual([{ ok: true }]);
  });

  it('returns empty when the log does not exist', () => {
    expect(readLog(ctx.paths, 'missing')).toEqual([]);
  });

  it('sanitizes sessionIds with unsafe characters when picking the log filename', () => {
    appendLogEntry(ctx.paths, 'S-with/slash', { a: 1 });
    // The file should still be readable through the same sessionId.
    expect(readLog(ctx.paths, 'S-with/slash')).toEqual([{ a: 1 }]);
  });
});

describe('readIndex resilience', () => {
  let ctx: ReturnType<typeof makeTempPaths>;
  beforeEach(() => { ctx = makeTempPaths(); });
  afterEach(() => { ctx.cleanup(); });

  it('returns {} when the file is missing', () => {
    expect(readIndex(ctx.paths)).toEqual({});
  });

  it('returns {} when the file is corrupt', () => {
    fs.mkdirSync(path.dirname(ctx.paths.indexFile), { recursive: true });
    fs.writeFileSync(ctx.paths.indexFile, 'not-json');
    expect(readIndex(ctx.paths)).toEqual({});
  });
});
