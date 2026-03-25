# BSL Analyzer

High-performance Language Server for BSL (1C:Enterprise) — code analysis, autocompletion, diagnostics, and MCP support for AI assistants.

## Features

- **Diagnostics**: Real-time code analysis with 101+ diagnostic rules
- **Go to Definition**: Navigate to symbol definitions (F12)
- **Find References**: Find all references to a symbol (Shift+F12)
- **Semantic Highlighting**: Enhanced syntax highlighting based on semantic analysis
- **Auto-download**: Server binary is downloaded automatically on first launch
- **MCP Server**: Built-in MCP support for AI assistants (Cursor, Claude Code)

## Installation

Install from VS Code Marketplace or download `.vsix` from [GitHub Releases](https://github.com/itrous/bsl-analyzer-vscode/releases).

The extension automatically downloads the `bsl-analyzer` server on first launch — no manual setup required.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `bsl-analyzer.server.source` | `github` | Download source: `github` (opensource) or `custom` (proprietary server) |
| `bsl-analyzer.server.customUrl` | | Custom release server URL |
| `bsl-analyzer.server.path` | | Manual path to server binary (disables auto-download) |
| `bsl-analyzer.server.logFile` | | Path to server log file |
| `bsl-analyzer.server.extraEnv` | `{}` | Extra environment variables for the server |
| `bsl-analyzer.trace.server` | `off` | Tracing: `off`, `messages`, or `verbose` |

## MCP Configuration

BSL Analyzer includes a built-in MCP server for use with AI assistants like Cursor or Claude Code.

Use the command **BSL Analyzer: Copy Server Path** (`Ctrl+Shift+P` → "BSL Analyzer: Copy Server Path") to get the binary path, then add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "bsl-analyzer": {
      "command": "/path/to/bsl-analyzer",
      "args": ["mcp", "--source-dir", "src/cf"]
    }
  }
}
```

## Links

- [BSL Analyzer](https://github.com/itrous/bsl-analyzer) — the language server
- [Issues](https://github.com/itrous/bsl-analyzer-vscode/issues)

## License

MIT
