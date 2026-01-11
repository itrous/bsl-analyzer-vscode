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

    console.log(`Server command: ${serverPath} --stdio`);

    // Client options with explicit completion support
    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'bsl' },
        ],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('**/{.bsl-analyzer.json,.bsl-language-server.json}'),
        },
        // Explicitly enable completion
        initializationOptions: {},
        middleware: {
            provideCompletionItem: async (document, position, context, token, next) => {
                console.log(`[CLIENT] Completion requested at ${document.uri.fsPath}:${position.line}:${position.character}`);
                const result = await next(document, position, context, token);
                console.log(`[CLIENT] Completion result:`, result);
                return result;
            }
        }
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
        console.log('Server capabilities:', JSON.stringify(client?.initializeResult?.capabilities, null, 2));
    }).catch((err) => {
        vscode.window.showErrorMessage(`Failed to start BSL Analyzer: ${err.message}`);
        console.error('Failed to start language client:', err);
    });
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
