import * as vscode from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from 'vscode-languageclient/node';
import { ensureLauncher, getInstallPath } from './download';

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    console.log('BSL Analyzer extension is now active');

    const serverPath = await ensureLauncher(context);
    if (!serverPath) {
        return;
    }

    console.log(`Using server: ${serverPath}`);

    const config = vscode.workspace.getConfiguration('bsl-analyzer');

    // Get log file from config
    const logFile = config.get<string>('server.logFile', '');

    // Get heaptrack profiling config
    const heaptrackEnabled = config.get<boolean>('server.heaptrack.enabled', false);
    const heaptrackOutput = config.get<string>('server.heaptrack.output', '/tmp/bsl-heaptrack.zst');

    // Get extra environment variables from config
    const extraEnv = config.get<Record<string, string>>('server.extraEnv', {});

    // Build environment for server process
    const serverEnv: Record<string, string | undefined> = {
        ...process.env,
        BSL_LOG: logFile ? 'info' : 'warn',
        BSL_LOG_FILE: logFile || undefined,
        RUST_BACKTRACE: '1',
        // Extra env vars override defaults
        ...extraEnv,
    };

    // Add heaptrack profiling if enabled
    if (heaptrackEnabled) {
        const heaptrackLib = '/usr/lib/heaptrack/libheaptrack_preload.so';
        serverEnv.LD_PRELOAD = serverEnv.LD_PRELOAD
            ? `${heaptrackLib}:${serverEnv.LD_PRELOAD}`
            : heaptrackLib;
        serverEnv.DUMP_HEAPTRACK_OUTPUT = heaptrackOutput;
        console.log(`Heaptrack profiling enabled, output: ${heaptrackOutput}`);
    }

    // Server options
    const serverOptions: ServerOptions = {
        command: serverPath,
        args: [],
        transport: TransportKind.stdio,
        options: {
            env: serverEnv
        }
    };

    if (logFile) {
        console.log(`Server logs will be written to: ${logFile}`);
    }

    if (Object.keys(extraEnv).length > 0) {
        console.log(`Extra environment variables:`, extraEnv);
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

    // Register command to copy server path (useful for MCP configuration)
    context.subscriptions.push(
        vscode.commands.registerCommand('bsl-analyzer.copyServerPath', () => {
            const serverBinary = getInstallPath();
            if (serverBinary) {
                vscode.env.clipboard.writeText(serverBinary);
                vscode.window.showInformationMessage(`BSL Analyzer path copied: ${serverBinary}`);
            } else {
                vscode.window.showWarningMessage('BSL Analyzer: unsupported platform');
            }
        })
    );

    // Register debug adapter factory
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('bsl', {
            createDebugAdapterDescriptor(_session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
                return new vscode.DebugAdapterExecutable(serverPath, ['dap']);
            }
        })
    );
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
