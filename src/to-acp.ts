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
  content: string | AmpContentText[];
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

export function toAcpNotifications(message: AmpMessage, sessionId: string): SessionNotification[] {
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
        update = {
          toolCallId: chunk.id,
          sessionUpdate: 'tool_call' as const,
          rawInput: safeJson(chunk.input),
          status: 'pending' as const,
          title: chunk.name || 'Tool',
          kind: inferToolKind(chunk.name),
          content: diffContent ?? [],
          ...(locations ? { locations } : {}),
        };
        break;
      }
      case 'tool_result':
        update = {
          toolCallId: chunk.tool_use_id,
          sessionUpdate: 'tool_call_update' as const,
          status: chunk.is_error ? ('failed' as const) : ('completed' as const),
          content: toAcpContentArray(chunk.content, chunk.is_error),
        };
        break;
      default:
        break;
    }
    if (update) output.push({ sessionId, update });
  }
  return output;
}

function toAcpContentArray(content: string | AmpContentText[], isError = false): ToolCallContent[] {
  if (Array.isArray(content) && content.length > 0) {
    return content.map((c) => ({
      type: 'content' as const,
      content: { type: 'text' as const, text: isError ? wrapCode(c.text) : c.text },
    }));
  }
  if (typeof content === 'string' && content.length > 0) {
    return [{ type: 'content' as const, content: { type: 'text' as const, text: isError ? wrapCode(content) : content } }];
  }
  return [];
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
