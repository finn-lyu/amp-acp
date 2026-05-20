# ACP adapter for Amp

[![CI](https://github.com/finn-lyu/amp-acp/actions/workflows/ci.yml/badge.svg)](https://github.com/finn-lyu/amp-acp/actions/workflows/ci.yml)

Use [Amp](https://ampcode.com) from [ACP](https://agentclientprotocol.com/)-compatible clients such as [Zed](https://zed.dev).

> [!NOTE]
> This is a fork. It tracks the new Amp Code SDK and adds first-class support for Amp Code features.

## Installation

### Pre-built Binary

Supported platforms:
- Linux: x64, arm64
- macOS: x64 (Intel), arm64 (Apple Silicon)
- Windows: x64

Setup:
1. Download the binary for your platform
2. Make it executable
3. Add to your Zed `settings.json` (open with `cmd+,` or `ctrl+,`):

```json
{
  "agent_servers": {
    "Amp": {
      "type": "custom",
      "command": "/path/to/amp-acp-darwin-arm64"
    }
  }
}
```

## Authentication

- Authenticate within Amp CLI
- Or configure `AMP_API_KEY` for a headless setup

Refer to Amp Code Manual for full details.

## MCP Passthrough

MCP servers configured in Zed's `context_servers` are automatically forwarded to Amp. This is compatible with how other ACP agents like [Claude Code](https://github.com/zed-industries/claude-code-acp) and [Codex](https://github.com/zed-industries/codex-acp) handle MCP servers.

### Supported MCP Server Types

- STDIO
- HTTP
- SSE

For more details, see [docs/mcp-passthrough.md](docs/mcp-passthrough.md).

## Development

```bash
bun install
bun run build        # Bundle to dist/index.js
bun run lint         # Type-check with tsc
bun test src/        # Run unit tests
bun run test:binary  # Run binary integration tests
bun run test:all     # Run all tests
```

## License

[Apache-2.0](https://opensource.org/licenses/Apache-2.0)
