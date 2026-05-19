import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MAX_INDEX_ENTRIES = 100;
const DEFAULT_MAX_LOG_BYTES = 50 * 1024 * 1024;
const AMP_ACP_SESSIONS_DIR_ENV = 'AMP_ACP_SESSIONS_DIR';
const AMP_ACP_MAX_LOG_BYTES_ENV = 'AMP_ACP_MAX_LOG_BYTES';

function getMaxLogBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = env[AMP_ACP_MAX_LOG_BYTES_ENV];
  if (!raw) return DEFAULT_MAX_LOG_BYTES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_LOG_BYTES;
}

export interface SessionIndexEntry {
  threadId: string;
  mode: string;
  lastUsedMs: number;
}

export type SessionsIndex = Record<string, SessionIndexEntry>;

export interface SessionStorePaths {
  indexFile: string;
  logsDir: string;
}

export function getSessionStorePaths(env: Record<string, string | undefined> = process.env): SessionStorePaths {
  const override = env[AMP_ACP_SESSIONS_DIR_ENV];
  const root = override && override.trim() !== '' ? override : path.join(env.HOME ?? os.homedir(), '.config', 'amp-acp');
  return {
    indexFile: path.join(root, 'sessions.json'),
    logsDir: path.join(root, 'sessions'),
  };
}

export function readIndex(paths: SessionStorePaths): SessionsIndex {
  try {
    const raw = fs.readFileSync(paths.indexFile, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SessionsIndex;
    }
    return {};
  } catch {
    return {};
  }
}

function writeIndex(paths: SessionStorePaths, index: SessionsIndex): void {
  fs.mkdirSync(path.dirname(paths.indexFile), { recursive: true });
  const tmp = `${paths.indexFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
  fs.renameSync(tmp, paths.indexFile);
}

export function pruneIndex(
  index: SessionsIndex,
  max: number = MAX_INDEX_ENTRIES,
): { kept: SessionsIndex; evictedIds: string[] } {
  const entries = Object.entries(index);
  if (entries.length <= max) return { kept: index, evictedIds: [] };
  entries.sort((a, b) => b[1].lastUsedMs - a[1].lastUsedMs);
  const kept = Object.fromEntries(entries.slice(0, max));
  const evictedIds = entries.slice(max).map(([id]) => id);
  return { kept, evictedIds };
}

function logFilePath(paths: SessionStorePaths, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(paths.logsDir, `${safe}.jsonl`);
}

export function recordSession(
  paths: SessionStorePaths,
  sessionId: string,
  entry: Omit<SessionIndexEntry, 'lastUsedMs'> & { lastUsedMs?: number },
): void {
  const now = entry.lastUsedMs ?? Date.now();
  const current = readIndex(paths);
  current[sessionId] = { threadId: entry.threadId, mode: entry.mode, lastUsedMs: now };
  const { kept, evictedIds } = pruneIndex(current);
  writeIndex(paths, kept);
  for (const id of evictedIds) {
    deleteLog(paths, id);
  }
}

export function lookupSession(paths: SessionStorePaths, sessionId: string): SessionIndexEntry | null {
  const current = readIndex(paths);
  return current[sessionId] ?? null;
}

export function appendLogEntry(
  paths: SessionStorePaths,
  sessionId: string,
  message: unknown,
  maxBytes: number = getMaxLogBytes(),
): void {
  fs.mkdirSync(paths.logsDir, { recursive: true });
  const file = logFilePath(paths, sessionId);
  // Silently stop appending once the per-session cap is hit. Future writes are
  // dropped; existing entries (including the live thread) keep flowing on Amp's
  // side via `continue: threadId`. Replay just covers up to the cap.
  let currentSize = 0;
  try {
    currentSize = fs.statSync(file).size;
  } catch {
    // file doesn't exist yet; size stays 0
  }
  if (currentSize >= maxBytes) return;
  fs.appendFileSync(file, JSON.stringify(message) + '\n');
}

export function readLog(paths: SessionStorePaths, sessionId: string): unknown[] {
  let raw: string;
  try {
    raw = fs.readFileSync(logFilePath(paths, sessionId), 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  const out: unknown[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip truncated/corrupt trailing lines
    }
  }
  return out;
}

export function deleteLog(paths: SessionStorePaths, sessionId: string): void {
  try {
    fs.unlinkSync(logFilePath(paths, sessionId));
  } catch {
    // log may not exist; that's fine
  }
}
