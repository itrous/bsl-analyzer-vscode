import * as vscode from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from 'vscode-languageclient/node';
import {
    checkForUpdate,
    ensureLauncher,
    getInstalledVersion,
    getInstallPath,
    installUpdate,
    UpdateCheckResult,
} from './download';

const LAST_UPDATE_CHECK_KEY = 'bsl-analyzer.lastUpdateCheck';
const UPDATE_SNOOZE_UNTIL_KEY = 'bsl-analyzer.updateSnoozeUntil';
const DEFAULT_UPDATE_CHECK_INTERVAL_HOURS = 12;

let client: LanguageClient | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let currentServerPath: string | undefined;
let updateCheckInProgress = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    console.log('BSL Analyzer extension is now active');

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'bsl-analyzer.checkForUpdates';
    statusBarItem.text = '$(sync~spin) BSL Analyzer';
    statusBarItem.tooltip = 'BSL Analyzer is starting';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    registerCommands(context);
    registerDebugAdapterFactory(context);

    const serverPath = await ensureLauncher(context);
    if (!serverPath) {
        updateStatusBar(undefined);
        return;
    }

    currentServerPath = serverPath;
    updateStatusBar(serverPath);
    await startLanguageClient(serverPath);
    scheduleBackgroundUpdateChecks(context);
}

function registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('bsl-analyzer.copyServerPath', () => {
            const serverBinary = currentServerPath
                || vscode.workspace.getConfiguration('bsl-analyzer').get<string>('server.path', '')
                || getInstallPath();

            if (serverBinary) {
                vscode.env.clipboard.writeText(serverBinary);
                vscode.window.showInformationMessage(`BSL Analyzer path copied: ${serverBinary}`);
            } else {
                vscode.window.showWarningMessage('BSL Analyzer: unsupported platform');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('bsl-analyzer.checkForUpdates', () => {
            void runUpdateCheck(context, true);
        })
    );
}

function registerDebugAdapterFactory(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('bsl', {
            createDebugAdapterDescriptor(_session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
                const serverPath = currentServerPath || getInstallPath();
                if (!serverPath) {
                    return undefined;
                }
                return new vscode.DebugAdapterExecutable(serverPath, ['dap']);
            }
        })
    );
}

async function startLanguageClient(serverPath: string): Promise<boolean> {
    console.log(`Using server: ${serverPath}`);

    const config = vscode.workspace.getConfiguration('bsl-analyzer');
    const logFile = config.get<string>('server.logFile', '');
    const heaptrackEnabled = config.get<boolean>('server.heaptrack.enabled', false);
    const heaptrackOutput = config.get<string>('server.heaptrack.output', '/tmp/bsl-heaptrack.zst');
    const extraEnv = config.get<Record<string, string>>('server.extraEnv', {});

    const serverEnv: Record<string, string | undefined> = {
        ...process.env,
        BSL_LOG: logFile ? 'info' : 'warn',
        BSL_LOG_FILE: logFile || undefined,
        RUST_BACKTRACE: '1',
        ...extraEnv,
    };

    if (heaptrackEnabled) {
        const heaptrackLib = '/usr/lib/heaptrack/libheaptrack_preload.so';
        serverEnv.LD_PRELOAD = serverEnv.LD_PRELOAD
            ? `${heaptrackLib}:${serverEnv.LD_PRELOAD}`
            : heaptrackLib;
        serverEnv.DUMP_HEAPTRACK_OUTPUT = heaptrackOutput;
        console.log(`Heaptrack profiling enabled, output: ${heaptrackOutput}`);
    }

    const serverOptions: ServerOptions = {
        command: serverPath,
        args: [],
        transport: TransportKind.stdio,
        options: {
            env: serverEnv,
        },
    };

    if (logFile) {
        console.log(`Server logs will be written to: ${logFile}`);
    }

    if (Object.keys(extraEnv).length > 0) {
        console.log(`Extra environment variables configured: ${Object.keys(extraEnv).join(', ')}`);
    }

    console.log(`Server command: ${serverPath} --stdio`);

    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'bsl' },
        ],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('**/{.bsl-analyzer.json,.bsl-language-server.json}'),
        },
        initializationOptions: {},
    };

    client = new LanguageClient(
        'bsl-analyzer',
        'BSL Analyzer Language Server',
        serverOptions,
        clientOptions
    );

    try {
        await client.start();
        console.log('Language client started successfully');
        console.log('Server capabilities:', JSON.stringify(client.initializeResult?.capabilities, null, 2));
        return true;
    } catch (err) {
        client = undefined;
        vscode.window.showErrorMessage(`Failed to start BSL Analyzer: ${(err as Error).message}`);
        console.error('Failed to start language client:', err);
        return false;
    }
}

async function stopLanguageClient(): Promise<void> {
    if (!client) {
        return;
    }
    const runningClient = client;
    client = undefined;
    await runningClient.stop();
}

function updateStatusBar(serverPath: string | undefined, checking = false): void {
    if (!statusBarItem) {
        return;
    }

    if (checking) {
        statusBarItem.text = '$(sync~spin) BSL Analyzer';
        statusBarItem.tooltip = 'Checking BSL Analyzer updates';
        return;
    }

    if (!serverPath) {
        statusBarItem.text = '$(warning) BSL Analyzer';
        statusBarItem.tooltip = 'BSL Analyzer is not installed for this platform';
        return;
    }

    const version = getInstalledVersion(serverPath);
    statusBarItem.text = version
        ? `$(check) BSL Analyzer ${formatVersion(version)}`
        : '$(check) BSL Analyzer';
    statusBarItem.tooltip = [
        version ? `Version: ${version}` : 'Version: unknown',
        `Path: ${serverPath}`,
        'Click to check for updates',
    ].join('\n');
}

function formatVersion(version: string): string {
    const match = version.match(/v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
    return match ? match[0] : version;
}

function getUpdateCheckIntervalMs(): number {
    const config = vscode.workspace.getConfiguration('bsl-analyzer');
    const hours = config.get<number>('updates.checkIntervalHours', DEFAULT_UPDATE_CHECK_INTERVAL_HOURS);
    return Math.max(1, hours) * 60 * 60 * 1000;
}

function scheduleBackgroundUpdateChecks(context: vscode.ExtensionContext): void {
    const initialTimer = setTimeout(() => {
        void maybeRunBackgroundUpdateCheck(context, true);
    }, 0);
    context.subscriptions.push({ dispose: () => clearTimeout(initialTimer) });

    const intervalTimer = setInterval(() => {
        void maybeRunBackgroundUpdateCheck(context);
    }, getUpdateCheckIntervalMs());
    context.subscriptions.push({ dispose: () => clearInterval(intervalTimer) });
}

async function maybeRunBackgroundUpdateCheck(context: vscode.ExtensionContext, force = false): Promise<void> {
    const config = vscode.workspace.getConfiguration('bsl-analyzer');
    if (!config.get<boolean>('updates.enabled', true)) {
        return;
    }

    const lastCheck = context.globalState.get<number>(LAST_UPDATE_CHECK_KEY, 0);
    if (!force && Date.now() - lastCheck < getUpdateCheckIntervalMs()) {
        return;
    }

    await context.globalState.update(LAST_UPDATE_CHECK_KEY, Date.now());
    await runUpdateCheck(context, false);
}

async function runUpdateCheck(context: vscode.ExtensionContext, manual: boolean): Promise<void> {
    if (updateCheckInProgress) {
        if (manual) {
            vscode.window.showInformationMessage('BSL Analyzer: update check is already running');
        }
        return;
    }

    updateCheckInProgress = true;
    updateStatusBar(currentServerPath, true);

    try {
        const check = await vscode.window.withProgress(
            {
                location: manual ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
                title: 'BSL Analyzer: checking for updates...',
                cancellable: false,
            },
            () => checkForUpdate()
        );

        if (!check.available) {
            if (manual) {
                if (check.reason) {
                    vscode.window.showInformationMessage(`BSL Analyzer: ${check.reason}`);
                } else {
                    const suffix = check.currentVersion ? ` Current version: ${formatVersion(check.currentVersion)}.` : '';
                    vscode.window.showInformationMessage(`BSL Analyzer is up to date.${suffix}`);
                }
            }
            return;
        }

        await promptAndInstallUpdate(context, check, manual);
    } catch (err) {
        if (manual) {
            vscode.window.showErrorMessage(`BSL Analyzer: failed to check for updates: ${(err as Error).message}`);
        } else {
            console.log(`BSL Analyzer: background update check failed: ${(err as Error).message}`);
        }
    } finally {
        updateCheckInProgress = false;
        updateStatusBar(currentServerPath);
    }
}

async function promptAndInstallUpdate(context: vscode.ExtensionContext, check: UpdateCheckResult, manual: boolean): Promise<void> {
    const snoozeUntil = context.globalState.get<number>(UPDATE_SNOOZE_UNTIL_KEY, 0);
    if (!manual && Date.now() < snoozeUntil) {
        return;
    }

    const current = check.currentVersion ? formatVersion(check.currentVersion) : 'unknown';
    const latest = check.latestVersion ? formatVersion(check.latestVersion) : 'latest';
    const message = manual
        ? `BSL Analyzer update is available: ${current} -> ${latest}.`
        : `BSL Analyzer update is available: ${latest}.`;
    const updateAction = 'Update';
    const laterAction = 'Later';

    const choice = await vscode.window.showInformationMessage(message, updateAction, laterAction);
    if (choice !== updateAction) {
        if (!manual) {
            await context.globalState.update(UPDATE_SNOOZE_UNTIL_KEY, Date.now() + getUpdateCheckIntervalMs());
        }
        return;
    }

    await context.globalState.update(UPDATE_SNOOZE_UNTIL_KEY, undefined);
    await applyUpdate(context, check);
}

async function applyUpdate(context: vscode.ExtensionContext, check: UpdateCheckResult): Promise<void> {
    const previousServerPath = currentServerPath;

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'BSL Analyzer: installing update...',
                cancellable: false,
            },
            async () => {
                await stopLanguageClient();
                try {
                    const result = await installUpdate(check);
                    if (!result) {
                        throw new Error('update is not available for this platform');
                    }
                    currentServerPath = result.path;
                    const started = await startLanguageClient(result.path);
                    if (!started) {
                        throw new Error('updated language server failed to start');
                    }
                    updateStatusBar(result.path);
                    vscode.window.showInformationMessage(`BSL Analyzer updated to ${formatVersion(result.version || 'latest')}`);
                } catch (err) {
                    if (previousServerPath) {
                        currentServerPath = previousServerPath;
                        await startLanguageClient(previousServerPath);
                    }
                    throw err;
                }
            }
        );
    } catch (err) {
        vscode.window.showErrorMessage(`BSL Analyzer: failed to install update: ${(err as Error).message}`);
    }

    await context.globalState.update(LAST_UPDATE_CHECK_KEY, Date.now());
}

export function deactivate(): Thenable<void> | undefined {
    statusBarItem?.dispose();
    if (!client) {
        return undefined;
    }
    return client.stop();
}
