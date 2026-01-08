# Quick Start Guide - BSL Analyzer Extension

## Step-by-Step Instructions

### 1. Build the LSP Server

```bash
cd /home/itrous/src/lsp/bsl-analyzer
cargo build --release
```

Verify the build:
```bash
ls -lh target/release/bsl-analyzer
# Should show ~60MB executable
```

### 2. Prepare the Extension

```bash
cd /home/itrous/src/lsp/bsl-analyzer-vscode
npm install
npm run compile
```

### 3. Launch Extension Development Host

In VSCode:
1. Open folder: `/home/itrous/src/lsp/bsl-analyzer-vscode`
2. Press **F5** (or Run → Start Debugging)
3. A new VSCode window will open with "[Extension Development Host]" in the title

### 4. Open Test Workspace

**IMPORTANT:** In the Extension Development Host window:
1. Click: **File → Open Folder...**
2. Navigate to: `/home/itrous/src/lsp/bsl-analyzer-vscode/test-workspace`
3. Click **Open**

### 5. Open a BSL File

1. In the Explorer panel, you should see `Sample.bsl`
2. Click on `Sample.bsl` to open it

### 6. Verify Extension is Working

Check the Output panel:
1. View → Output (Ctrl+Shift+U)
2. Select "BSL Analyzer Language Server" from dropdown
3. You should see:
   ```
   BSL Analyzer extension is now active
   Server path from config: "/home/itrous/src/lsp/bsl-analyzer/target/release/bsl-analyzer"
   Workspace folders: /home/itrous/src/lsp/bsl-analyzer-vscode/test-workspace
   Using configured server path: ...
   BSL Analyzer language client started
   ```

### 7. Test Features

- **Semantic Highlighting**: Keywords, functions, procedures should have distinct colors
- **Go to Definition**: Put cursor on `ОбработатьДанные` (line 75), press F12
- **Find References**: Put cursor on `ВычислитьСумму`, press Shift+F12
- **Diagnostics**: Open Problems panel (Ctrl+Shift+M)

## Troubleshooting

### Error: "spawn bsl-analyzer ENOENT"

**Cause:** The extension couldn't find the server or workspace settings weren't loaded.

**Solution:**
1. Make sure you opened `/home/itrous/src/lsp/bsl-analyzer-vscode/test-workspace` as a **folder**
2. Check that `.vscode/settings.json` exists in test-workspace
3. Restart Extension Development Host (close and press F5 again)

### Error: "write EPIPE"

**Cause:** The server crashed during initialization.

**Solution:**
1. Check server logs: `Output → BSL Analyzer Language Server`
2. Try running server manually: `./target/release/bsl-analyzer --version`
3. Rebuild server: `cargo build --release`

### No Semantic Highlighting

**Cause:** Language mode not set correctly.

**Solution:**
1. Check bottom-right corner of VSCode - should show "BSL"
2. If not, click and select "BSL" from language list

### Extension Not Activating

**Cause:** Workspace doesn't contain .bsl files.

**Solution:**
- Make sure `test-workspace/Sample.bsl` exists
- Try opening Sample.bsl file directly

## Debug Mode

To see verbose logs:

1. Edit `test-workspace/.vscode/settings.json`:
   ```json
   {
     "bsl-analyzer.trace.server": "verbose"
   }
   ```

2. Restart Extension Development Host

3. Check Output panel for detailed communication logs
