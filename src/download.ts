import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const GITHUB_REPO = 'itrous/bsl-analyzer';
const META_FILENAME = '.bsl-analyzer.meta.json';

interface SourceMeta {
    source: string;
    customUrl: string;
}

function getMetaPath(installDir: string): string {
    return path.join(installDir, META_FILENAME);
}

function readMeta(installDir: string): SourceMeta | undefined {
    try {
        const raw = fs.readFileSync(getMetaPath(installDir), 'utf-8');
        return JSON.parse(raw) as SourceMeta;
    } catch {
        return undefined;
    }
}

function writeMeta(installDir: string, meta: SourceMeta): void {
    fs.writeFileSync(getMetaPath(installDir), JSON.stringify(meta, null, 2));
}

interface PlatformInfo {
    /** Asset name on release servers (e.g. bsl-analyzer-linux-amd64) */
    assetName: string;
    /** Local file name after download */
    localName: string;
    /** Install directory */
    installDir: string;
}

function getPlatformInfo(): PlatformInfo | undefined {
    const platform = process.platform;
    const arch = process.arch;

    if (platform === 'linux' && arch === 'x64') {
        return {
            assetName: 'bsl-analyzer-linux-amd64',
            localName: 'bsl-analyzer',
            installDir: path.join(os.homedir(), '.local', 'bin'),
        };
    }
    if (platform === 'darwin' && arch === 'arm64') {
        return {
            assetName: 'bsl-analyzer-darwin-arm64',
            localName: 'bsl-analyzer',
            installDir: path.join(os.homedir(), '.local', 'bin'),
        };
    }
    if (platform === 'win32' && arch === 'x64') {
        return {
            assetName: 'bsl-analyzer-windows-amd64.exe',
            localName: 'bsl-analyzer.exe',
            installDir: path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'bsl-analyzer'),
        };
    }
    return undefined;
}

function downloadFile(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const get = url.startsWith('https') ? https.get : http.get;
        get(url, { headers: { 'User-Agent': 'bsl-analyzer-vscode' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                const location = res.headers.location;
                if (!location) {
                    reject(new Error('Redirect without location header'));
                    return;
                }
                downloadFile(location).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`Download failed: HTTP ${res.statusCode}`));
                return;
            }
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function getGitHubDownloadUrl(platformInfo: PlatformInfo): string {
    return `https://github.com/${GITHUB_REPO}/releases/latest/download/${platformInfo.assetName}`;
}

function getCustomDownloadUrl(baseUrl: string, platformInfo: PlatformInfo): string {
    const base = baseUrl.replace(/\/+$/, '');
    return `${base}/bsl-analyzer/latest/${platformInfo.assetName}`;
}

/** Returns the well-known install path for the current platform */
export function getInstallPath(): string | undefined {
    const info = getPlatformInfo();
    if (!info) {
        return undefined;
    }
    return path.join(info.installDir, info.localName);
}

export async function ensureLauncher(context: vscode.ExtensionContext): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration('bsl-analyzer');
    const manualPath = config.get<string>('server.path', '');

    if (manualPath) {
        return manualPath;
    }

    const platformInfo = getPlatformInfo();
    if (!platformInfo) {
        vscode.window.showErrorMessage(
            `BSL Analyzer: unsupported platform ${process.platform}-${process.arch}`
        );
        return undefined;
    }

    const launcherPath = path.join(platformInfo.installDir, platformInfo.localName);

    const source = config.get<string>('server.source', 'github');
    const customUrl = config.get<string>('server.customUrl', '');
    const currentMeta: SourceMeta = { source, customUrl };

    if (fs.existsSync(launcherPath)) {
        const savedMeta = readMeta(platformInfo.installDir);
        const sourceChanged = savedMeta
            && (savedMeta.source !== currentMeta.source || savedMeta.customUrl !== currentMeta.customUrl);

        if (!sourceChanged) {
            return launcherPath;
        }

        console.log(`BSL Analyzer: server source changed (${savedMeta.source} → ${currentMeta.source}), re-downloading`);
    }

    let downloadUrl: string;
    if (source === 'custom' && customUrl) {
        downloadUrl = getCustomDownloadUrl(customUrl, platformInfo);
    } else {
        downloadUrl = getGitHubDownloadUrl(platformInfo);
    }

    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'BSL Analyzer: downloading server...',
            cancellable: false,
        },
        async () => {
            try {
                const data = await downloadFile(downloadUrl);

                fs.mkdirSync(platformInfo.installDir, { recursive: true });
                fs.writeFileSync(launcherPath, data);

                if (process.platform !== 'win32') {
                    fs.chmodSync(launcherPath, 0o755);
                }

                writeMeta(platformInfo.installDir, currentMeta);

                return launcherPath;
            } catch (err: any) {
                vscode.window.showErrorMessage(
                    `BSL Analyzer: failed to download server from ${downloadUrl}: ${err.message}`
                );
                return undefined;
            }
        }
    );
}
