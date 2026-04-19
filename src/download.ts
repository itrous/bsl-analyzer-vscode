import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const GITHUB_REPO = 'itrous/bsl-analyzer';
const META_FILENAME = '.bsl-analyzer.meta.json';

/**
 * Minimum launcher version required by this extension.
 *
 * Bump whenever the launcher ships a behavioural change the extension
 * relies on. Installed launchers older than this will be re-downloaded
 * on the next activation.
 *
 * 0.1.125 — launcher now ties the spawned bsl-analyzer-app to its own
 * lifetime (Linux PR_SET_PDEATHSIG, Windows Job Object), so closing
 * VS Code no longer leaves the analyzer running as an orphan.
 */
const MIN_LAUNCHER_VERSION: [number, number, number] = [0, 1, 125];

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

type SemVer = [number, number, number];

function parseSemver(raw: string): SemVer | undefined {
    const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
        return undefined;
    }
    return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

function compareSemver(a: SemVer, b: SemVer): number {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) {
            return a[i] - b[i];
        }
    }
    return 0;
}

/** Returns the installed launcher's version, or undefined if it cannot be determined. */
function getInstalledLauncherVersion(launcherPath: string): SemVer | undefined {
    try {
        const result = spawnSync(launcherPath, ['--launcher-version'], {
            timeout: 5000,
            encoding: 'utf-8',
        });
        if (result.error || result.status !== 0) {
            return undefined;
        }
        return parseSemver(result.stdout);
    } catch {
        return undefined;
    }
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

        if (sourceChanged) {
            console.log(`BSL Analyzer: server source changed (${savedMeta.source} → ${currentMeta.source}), re-downloading`);
        } else {
            // Source unchanged — check whether the on-disk launcher is
            // recent enough for this extension. A too-old launcher can
            // be missing features or fixes the extension depends on
            // (e.g. child-lifetime binding added in 0.1.125).
            const installedVersion = getInstalledLauncherVersion(launcherPath);
            if (installedVersion && compareSemver(installedVersion, MIN_LAUNCHER_VERSION) >= 0) {
                return launcherPath;
            }
            const installedStr = installedVersion ? installedVersion.join('.') : 'unknown';
            const minStr = MIN_LAUNCHER_VERSION.join('.');
            console.log(`BSL Analyzer: launcher ${installedStr} < ${minStr}, re-downloading`);
        }
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
