import * as path from 'path';
import * as vscode from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
    console.log('BSL Analyzer extension is now active');

    // Get server path from configuration
    const config = vscode.workspace.getConfiguration('bsl-analyzer');
    let serverPath = config.get<string>('server.path', '');

    console.log(`Server path from config: "${serverPath}"`);
    console.log(`Workspace folders: ${vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath).join(', ') || 'none'}`);

    if (!serverPath) {
        // Try to find bsl-analyzer in PATH
        serverPath = 'bsl-analyzer';
        console.log('No server path configured, using PATH lookup');
    } else {
        console.log(`Using configured server path: ${serverPath}`);
    }

    // Get log file from config
    const logFile = config.get<string>('server.logFile', '');

    // Server options
    const serverOptions: ServerOptions = {
        command: serverPath,
        args: [],
        transport: TransportKind.stdio,
        options: {
            env: {
                ...process.env,
                BSL_LOG: logFile ? 'info' : 'off',
                BSL_LOG_FILE: logFile || undefined,
                RUST_BACKTRACE: '1'
            }
        }
    };

    if (logFile) {
        console.log(`Server logs will be written to: ${logFile}`);
    }

    console.log(`Server command: ${serverPath}`);
    console.log(`Transport: stdio`);

    // Client options
    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'bsl' },
        ],
        synchronize: {
            // Notify the server about file changes to .bsl-analyzer.json and .bsl-language-server.json files
            fileEvents: vscode.workspace.createFileSystemWatcher('**/{.bsl-analyzer.json,.bsl-language-server.json}'),
        },
    };

    // Create the language client
    client = new LanguageClient(
        'bsl-analyzer',
        'BSL Analyzer Language Server',
        serverOptions,
        clientOptions
    );

    // Start the client (and server)
    client.start().then(() => {
        console.log('Language client started successfully');
    }).catch((err) => {
        vscode.window.showErrorMessage(`Failed to start BSL Analyzer: ${err.message}`);
        console.error('Failed to start language client:', err);
        console.error('Error stack:', err.stack);
    });

    console.log('BSL Analyzer language client started');
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
