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

    if (!serverPath) {
        // Try to find bsl-analyzer in PATH
        serverPath = 'bsl-analyzer';
    }

    // Server options
    const serverOptions: ServerOptions = {
        command: serverPath,
        args: [],
        transport: TransportKind.stdio,
    };

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
    client.start().catch((err) => {
        vscode.window.showErrorMessage(`Failed to start BSL Analyzer: ${err.message}`);
        console.error('Failed to start language client:', err);
    });

    console.log('BSL Analyzer language client started');
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
