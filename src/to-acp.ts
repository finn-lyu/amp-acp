import type { SessionNotification, ContentBlock, ToolCallContent, ToolKind, ToolCallLocation } from '@agentclientprotocol/sdk';

interface AmpContentText {
  type: 'text';
  text: string;
}

interface AmpContentImage {
  type: 'image';
  source?: {
    type: 'base64' | 'url';
    data?: string;
    media_type?: string;
    url?: string;
  };
}

interface AmpContentThinking {
  type: 'thinking';
  thinking: string;
}

interface AmpContentToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

interface AmpContentToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
  is_error: boolean;
}

type AmpContentBlock = AmpContentText | AmpContentImage | AmpContentThinking | AmpContentToolUse | AmpContentToolResult;

interface AmpMessage {
  type: string;
  message?: {
    content: string | AmpContentBlock[];
  };
  session_id?: string;
}

interface ToAcpNotificationOptions {
  createTerminalOutput?: boolean;
  terminalOutputToolIds?: ReadonlySet<string>;
}

export function toAcpNotifications(
  message: AmpMessage,
  sessionId: string,
  options: ToAcpNotificationOptions = {},
): SessionNotification[] {
  const content = message.message?.content;
  const isUser = message.type === 'user';
  if (typeof content === 'string') {
    // Skip echoed user-prompt strings — the client originated them.
    if (isUser) return [];
    return [
      {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: content } as ContentBlock,
        },
      },
    ];
  }
  const output: SessionNotification[] = [];
  if (!Array.isArray(content)) return output;
  for (const chunk of content) {
    // For user messages, only tool_result blocks carry information the client
    // hasn't already seen. Everything else (echoed text, etc.) is dropped.
    if (isUser && chunk.type !== 'tool_result') continue;
    let update: SessionNotification['update'] | null = null;
    switch (chunk.type) {
      case 'text':
        update = {
          sessionUpdate: message.type === 'assistant' ? 'agent_message_chunk' : 'user_message_chunk',
          content: { type: 'text', text: chunk.text } as ContentBlock,
        };
        break;
      case 'image':
        update = {
          sessionUpdate: message.type === 'assistant' ? 'agent_message_chunk' : 'user_message_chunk',
          content: {
            type: 'image',
            data: chunk.source?.type === 'base64' ? (chunk.source.data ?? '') : '',
            mimeType: chunk.source?.type === 'base64' ? (chunk.source.media_type ?? '') : '',
            uri: chunk.source?.type === 'url' ? chunk.source.url : undefined,
          } as ContentBlock,
        };
        break;
      case 'thinking':
        update = {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: chunk.thinking } as ContentBlock,
        };
        break;
      case 'tool_use': {
        const input = isPlainObject(chunk.input) ? chunk.input : {};
        const locations = extractToolLocations(chunk.name, input);
        const diffContent = extractDiffContent(chunk.name, input);
        const terminalContent = options.createTerminalOutput && isTerminalOutputTool(chunk.name)
          ? [{ type: 'terminal' as const, terminalId: chunk.id }]
          : undefined;
        const cwd = asString(input.cwd);
        update = {
          toolCallId: chunk.id,
          sessionUpdate: 'tool_call' as const,
          rawInput: safeJson(chunk.input),
          status: 'pending' as const,
          title: formatToolTitle(chunk.name, input),
          kind: inferToolKind(chunk.name),
          content: terminalContent ?? diffContent ?? [],
          ...(terminalContent ? { _meta: { terminal_info: { terminal_id: chunk.id, ...(cwd ? { cwd } : {}) } } } : {}),
          ...(locations ? { locations } : {}),
        };
        break;
      }
      case 'tool_result': {
        const displayText = toolResultDisplayText(chunk.content);
        const terminalOutput = options.terminalOutputToolIds?.has(chunk.tool_use_id)
          ? toolResultTerminalOutput(chunk.tool_use_id, chunk.content, chunk.is_error)
          : null;
        update = {
          toolCallId: chunk.tool_use_id,
          sessionUpdate: 'tool_call_update' as const,
          status: chunk.is_error ? ('failed' as const) : ('completed' as const),
          rawOutput: toolResultRawOutput(chunk.content, chunk.is_error),
          ...(terminalOutput
            ? {
                _meta: terminalOutput,
              }
            : { content: toAcpContentArray(chunk.content, chunk.is_error) }),
        };
        if (update) output.push({ sessionId, update });
        if (displayText && !terminalOutput) {
          output.push({
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: formatToolResultMessage(displayText, chunk.is_error) } as ContentBlock,
            },
          });
        }
        continue;
      }
      default:
        break;
    }
    if (update) output.push({ sessionId, update });
  }
  return output;
}

function toAcpContentArray(content: unknown, isError = false): ToolCallContent[] {
  if (Array.isArray(content) && content.length > 0) {
    return content.flatMap((c) => {
      const text = toolResultContentText(c);
      return text ? [textToolCallContent(text, isError)] : [];
    });
  }
  if (typeof content === 'string' && content.length > 0) {
    return [textToolCallContent(content, isError)];
  }
  if (content !== undefined && content !== null) {
    return [textToolCallContent(stableJson(content), isError)];
  }
  return [];
}

function textToolCallContent(text: string, isError: boolean): ToolCallContent {
  return { type: 'content' as const, content: { type: 'text' as const, text: isError ? wrapCode(text) : text } };
}

function toolResultContentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (isPlainObject(content)) {
    if (content.type === 'text' && typeof content.text === 'string') return content.text;
    return stableJson(content);
  }
  if (content === undefined || content === null) return null;
  return stableJson(content);
}

function toolResultRawOutput(content: unknown, isError: boolean): Record<string, unknown> {
  return safeJson({ content, is_error: isError }) ?? { content: stableJson(content), is_error: isError };
}

function toolResultTerminalOutput(
  terminalId: string,
  content: unknown,
  isError: boolean,
): { terminal_output: { terminal_id: string; data: string }; terminal_exit: { terminal_id: string; exit_code: number } } {
  const parsed = parseToolResultPayload(content);
  return {
    terminal_output: { terminal_id: terminalId, data: parsed.output },
    terminal_exit: { terminal_id: terminalId, exit_code: parsed.exitCode ?? (isError ? 1 : 0) },
  };
}

function parseToolResultPayload(content: unknown): { output: string; exitCode?: number } {
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (isPlainObject(parsed)) {
        return {
          output:
            asString(parsed.output) ??
            asString(parsed.diff) ??
            asString(parsed.error) ??
            asString(parsed.stderr) ??
            stableJson(parsed),
          exitCode: asNumber(parsed.exitCode) ?? asNumber(parsed.exit_code),
        };
      }
      return { output: toolResultContentText(parsed) ?? '' };
    } catch {
      return { output: content };
    }
  }
  return { output: toolResultContentText(content) ?? '' };
}

function toolResultDisplayText(content: unknown): string | null {
  if (typeof content === 'string') return displayTextFromString(content);
  if (Array.isArray(content)) {
    const text = content.map(toolResultContentText).filter((t): t is string => Boolean(t)).join('\n');
    return text.trim() ? text : null;
  }
  return toolResultContentText(content);
}

function displayTextFromString(content: string): string | null {
  if (!content.trim()) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (isPlainObject(parsed)) {
      const direct = asString(parsed.output) ?? asString(parsed.diff) ?? asString(parsed.error) ?? asString(parsed.stderr);
      if (direct !== undefined) return direct.length > 0 ? direct : null;
    }
    return toolResultContentText(parsed);
  } catch {
    return content;
  }
}

function formatToolResultMessage(text: string, isError: boolean): string {
  if (text.startsWith('```')) return `**${isError ? 'Tool error' : 'Tool output'}**\n${text}`;
  return `**${isError ? 'Tool error' : 'Tool output'}**\n\`\`\`text\n${text}\n\`\`\``;
}

function wrapCode(t: string): string {
  return '```\n' + t + '\n```';
}

function safeJson(x: unknown): { [k: string]: unknown } | undefined {
  try {
    return JSON.parse(JSON.stringify(x)) as { [k: string]: unknown };
  } catch {
    return undefined;
  }
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function stableJson(x: unknown): string {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// Tool-name → ACP ToolKind mapping. Names are taken from Amp's `system.tools`
// list (e.g. ['Bash','create_file','edit_file','find_thread','finder','handoff',
// 'librarian','oracle','painter','Read','read_mcp_resource','read_thread',
// 'read_web_page','skill','Task','view_image','web_search']). Unrecognized tools
// fall back to 'other'; MCP-provided tools generally land there too.
const TOOL_KIND_MAP: Record<string, ToolKind> = {
  Bash: 'execute',
  Read: 'read',
  read_mcp_resource: 'read',
  read_thread: 'read',
  view_image: 'read',
  create_file: 'edit',
  edit_file: 'edit',
  Write: 'edit',
  Edit: 'edit',
  finder: 'search',
  find_thread: 'search',
  Grep: 'search',
  Glob: 'search',
  read_web_page: 'fetch',
  web_search: 'fetch',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
  Task: 'think',
  handoff: 'think',
  librarian: 'think',
  oracle: 'think',
  skill: 'think',
};

const MAX_TITLE_LEN = 120;

export function isTerminalOutputTool(name: string | undefined): boolean {
  return name === 'Bash';
}

function truncate(s: string, max: number = MAX_TITLE_LEN): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : collapsed.slice(0, max - 1) + '…';
}

export function formatToolTitle(name: string | undefined, input: Record<string, unknown>): string {
  if (!name) return 'Tool';
  switch (name) {
    case 'Bash': {
      const cmd = asString(input.cmd) ?? asString(input.command);
      return cmd ? truncate(`\`${cmd}\``) : 'Bash';
    }
    case 'Read':
    case 'view_image': {
      const p = asString(input.path) ?? asString(input.file_path);
      return p ? truncate(`Read ${p}`) : name;
    }
    case 'edit_file':
    case 'Edit': {
      const p = asString(input.path) ?? asString(input.file_path);
      return p ? truncate(`Edit ${p}`) : name;
    }
    case 'create_file':
    case 'Write': {
      const p = asString(input.path) ?? asString(input.file_path);
      return p ? truncate(`Create ${p}`) : name;
    }
    case 'finder':
    case 'Grep':
    case 'Glob': {
      const q = asString(input.query) ?? asString(input.pattern) ?? asString(input.path);
      return q ? truncate(`Search ${q}`) : name;
    }
    case 'read_web_page':
    case 'WebFetch': {
      const url = asString(input.url);
      return url ? truncate(`Fetch ${url}`) : name;
    }
    case 'web_search':
    case 'WebSearch': {
      const q = asString(input.query) ?? asString(input.q);
      return q ? truncate(`Web search ${q}`) : name;
    }
    case 'oracle': {
      const q = asString(input.question) ?? asString(input.prompt);
      return q ? truncate(`Oracle: ${q}`) : name;
    }
    case 'Task': {
      const desc = asString(input.description) ?? asString(input.subagent_type);
      return desc ? truncate(`Task: ${desc}`) : name;
    }
    case 'librarian':
    case 'skill':
    case 'handoff':
      return name;
    case 'find_thread':
    case 'read_thread': {
      const q = asString(input.threadId) ?? asString(input.query);
      return q ? truncate(`${name === 'find_thread' ? 'Find' : 'Read'} thread ${q}`) : name;
    }
    case 'read_mcp_resource': {
      const uri = asString(input.uri) ?? asString(input.resource);
      return uri ? truncate(`MCP read ${uri}`) : name;
    }
    default:
      return name;
  }
}

export function inferToolKind(name: string | undefined): ToolKind {
  if (!name) return 'other';
  return TOOL_KIND_MAP[name] ?? 'other';
}

export function extractToolLocations(name: string, input: Record<string, unknown>): ToolCallLocation[] | undefined {
  // Use a tolerant set of input keys — Amp tools differ in spelling between
  // 'path', 'file_path', and 'filePath' depending on tool.
  const path = asString(input.path) ?? asString(input.file_path) ?? asString(input.filePath);
  if (!path) return undefined;
  const line = asNumber(input.line) ?? asNumber(input.offset) ?? asNumber(input.start_line);
  const location: ToolCallLocation = line !== undefined ? { path, line } : { path };
  switch (name) {
    case 'Read':
    case 'view_image':
    case 'edit_file':
    case 'Edit':
    case 'create_file':
    case 'Write':
    case 'finder':
    case 'Grep':
    case 'Glob':
      return [location];
    default:
      return undefined;
  }
}

export function extractDiffContent(name: string, input: Record<string, unknown>): ToolCallContent[] | undefined {
  const path = asString(input.path) ?? asString(input.file_path) ?? asString(input.filePath);
  if (!path) return undefined;
  if (name === 'edit_file' || name === 'Edit') {
    const oldText = asString(input.old_string) ?? asString(input.oldString) ?? asString(input.old_str);
    const newText = asString(input.new_string) ?? asString(input.newString) ?? asString(input.new_str) ?? '';
    return [{ type: 'diff', path, oldText: oldText ?? null, newText }];
  }
  if (name === 'create_file' || name === 'Write') {
    const newText = asString(input.content) ?? asString(input.text) ?? '';
    return [{ type: 'diff', path, oldText: null, newText }];
  }
  return undefined;
}
