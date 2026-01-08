# BSL Analyzer VSCode Extension

Language Server Protocol client for [bsl-analyzer](https://github.com/your-org/bsl-analyzer) - a high-performance Language Server for BSL (1C:Enterprise).

## Features

- **Diagnostics**: Real-time code analysis with 101+ diagnostic rules
- **Go to Definition**: Navigate to symbol definitions (F12)
- **Find References**: Find all references to a symbol (Shift+F12)
- **Semantic Highlighting**: Enhanced syntax highlighting based on semantic analysis

## Installation

### From Source

1. Build the bsl-analyzer server:
   ```bash
   cd ../bsl-analyzer
   cargo build --release
   ```

2. Install extension dependencies:
   ```bash
   cd ../bsl-analyzer-vscode
   npm install
   ```

3. Compile the extension:
   ```bash
   npm run compile
   ```

4. Press F5 in VSCode to launch a new window with the extension loaded

## Configuration

### `bsl-analyzer.server.path`

Path to the `bsl-analyzer` executable. If not set, the extension will look for `bsl-analyzer` in your PATH.

Example:
```json
{
  "bsl-analyzer.server.path": "/path/to/bsl-analyzer/target/release/bsl-analyzer"
}
```

### `bsl-analyzer.trace.server`

Enable tracing of communication between VSCode and the language server:
- `off` (default): No tracing
- `messages`: Trace message headers
- `verbose`: Trace full messages

## Development

### Running from Source

1. Open this folder in VSCode
2. Run `npm install` to install dependencies
3. Press F5 to launch extension development host
4. Open a `.bsl` file to activate the extension

### Building VSIX Package

```bash
npm install -g @vscode/vsce
vsce package
```

This will create a `.vsix` file that can be installed manually.

## License

MIT
