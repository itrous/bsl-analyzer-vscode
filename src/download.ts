import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const GITHUB_REPO = 'itrous/bsl-analyzer';
const META_FILENAME = '.bsl-analyzer.meta.json';
const ARTIFACT_NAME = 'bsl-analyzer-app';
const EXTENSION_CONFIG_SECTION = 'bsl-analyzer-lsp';
const LEGACY_CONFIG_SECTION = 'bsl-analyzer';

interface SourceMeta {
    artifactName?: string;
    version?: string;
    downloadUrl?: string;
    installedAt?: string;
}

interface PlatformInfo {
    /** GitHub release asset name (e.g. bsl-analyzer-app-linux-amd64) */
    assetName: string;
    /** Local file name after download */
    localName: string;
    /** Install directory */
    installDir: string;
}

interface ReleaseAsset {
    name: string;
    browser_download_url: string;
}

interface GitHubRelease {
    tag_name?: string;
    name?: string;
    assets?: ReleaseAsset[];
}

interface ReleaseInfo {
    version?: string;
    downloadUrl: string;
}

export interface UpdateCheckResult {
    available: boolean;
    currentVersion?: string;
    latestVersion?: string;
    downloadUrl?: string;
    reason?: string;
}

export interface InstallResult {
    path: string;
    version?: string;
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

function getPlatformInfo(): PlatformInfo | undefined {
    const platform = process.platform;
    const arch = process.arch;

    if (platform === 'linux' && arch === 'x64') {
        return {
            assetName: 'bsl-analyzer-app-linux-amd64',
            localName: 'bsl-analyzer-app',
            installDir: path.join(os.homedir(), '.local', 'bin'),
        };
    }
    if (platform === 'darwin' && arch === 'arm64') {
        return {
            assetName: 'bsl-analyzer-app-darwin-arm64',
            localName: 'bsl-analyzer-app',
            installDir: path.join(os.homedir(), '.local', 'bin'),
        };
    }
    if (platform === 'win32' && arch === 'x64') {
        return {
            assetName: 'bsl-analyzer-app-windows-amd64.exe',
            localName: 'bsl-analyzer-app.exe',
            installDir: path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), ARTIFACT_NAME),
        };
    }
    return undefined;
}

function requestBuffer(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const get = url.startsWith('https') ? https.get : http.get;
        get(url, { headers: { 'User-Agent': 'bsl-analyzer-vscode', ...headers } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
                const location = res.headers.location;
                if (!location) {
                    reject(new Error('Redirect without location header'));
                    return;
                }
                const nextUrl = new URL(location, url).toString();
                requestBuffer(nextUrl, headers).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function downloadFile(url: string): Promise<Buffer> {
    return requestBuffer(url);
}

async function fetchJson<T>(url: string): Promise<T> {
    const data = await requestBuffer(url, { Accept: 'application/json' });
    return JSON.parse(data.toString('utf-8')) as T;
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

function versionsEqual(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) {
        return false;
    }
    return a.replace(/^v/i, '') === b.replace(/^v/i, '');
}

function isVersionNewer(latest: string | undefined, current: string | undefined): boolean {
    if (!latest || !current) {
        return false;
    }
    const latestSemver = parseSemver(latest);
    const currentSemver = parseSemver(current);
    if (latestSemver && currentSemver) {
        return compareSemver(latestSemver, currentSemver) > 0;
    }
    return !versionsEqual(latest, current);
}

function currentSourceMeta(platformInfo: PlatformInfo, version?: string, downloadUrl?: string): SourceMeta {
    return {
        artifactName: platformInfo.assetName,
        version,
        downloadUrl,
        installedAt: new Date().toISOString(),
    };
}

function sourceChanged(savedMeta: SourceMeta | undefined, current: SourceMeta): boolean {
    if (!savedMeta) {
        return false;
    }
    return savedMeta.artifactName !== current.artifactName;
}

function getGitHubDownloadUrl(platformInfo: PlatformInfo): string {
    return `https://github.com/${GITHUB_REPO}/releases/latest/download/${platformInfo.assetName}`;
}

async function getGitHubReleaseInfo(platformInfo: PlatformInfo): Promise<ReleaseInfo> {
    const release = await fetchJson<GitHubRelease>(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    const asset = release.assets?.find((item) => item.name === platformInfo.assetName);
    if (!asset) {
        throw new Error(`release asset ${platformInfo.assetName} not found`);
    }
    return {
        version: release.tag_name || release.name,
        downloadUrl: asset.browser_download_url,
    };
}

async function getLatestReleaseInfo(platformInfo: PlatformInfo): Promise<ReleaseInfo> {
    return getGitHubReleaseInfo(platformInfo);
}

function getFallbackDownloadUrl(platformInfo: PlatformInfo): string {
    return getGitHubDownloadUrl(platformInfo);
}

function getInstalledBinaryVersion(binaryPath: string): string | undefined {
    for (const arg of ['--version', '--launcher-version']) {
        try {
            const result = spawnSync(binaryPath, [arg], {
                timeout: 5000,
                encoding: 'utf-8',
            });
            if (!result.error && result.status === 0) {
                const output = (result.stdout || result.stderr).trim();
                if (output) {
                    return output;
                }
            }
        } catch {
            // Try the next supported version flag.
        }
    }
    return undefined;
}

/** Returns the well-known install path for the current platform */
export function getInstallPath(): string | undefined {
    const info = getPlatformInfo();
    if (!info) {
        return undefined;
    }
    return path.join(info.installDir, info.localName);
}

export function getInstalledVersion(binaryPath?: string): string | undefined {
    const platformInfo = getPlatformInfo();
    if (!platformInfo) {
        return undefined;
    }
    const managedPath = getInstallPath();
    if (binaryPath && binaryPath !== managedPath) {
        return fs.existsSync(binaryPath) ? getInstalledBinaryVersion(binaryPath) : undefined;
    }
    const savedMeta = readMeta(platformInfo.installDir);
    if (savedMeta?.version) {
        return savedMeta.version;
    }
    const installedPath = binaryPath || managedPath;
    return installedPath && fs.existsSync(installedPath)
        ? getInstalledBinaryVersion(installedPath)
        : undefined;
}

export async function ensureLauncher(context: vscode.ExtensionContext): Promise<string | undefined> {
    const manualPath = getConfiguredValue<string>('server.path', '');

    if (manualPath) {
        if (fs.existsSync(manualPath)) {
            return manualPath;
        }
        vscode.window.showWarningMessage(
            `BSL Analyzer: configured server path does not exist, using managed bsl-analyzer-app instead: ${manualPath}`
        );
    }

    const platformInfo = getPlatformInfo();
    if (!platformInfo) {
        vscode.window.showErrorMessage(
            `BSL Analyzer: unsupported platform ${process.platform}-${process.arch}`
        );
        return undefined;
    }

    const appPath = path.join(platformInfo.installDir, platformInfo.localName);
    const currentMeta = currentSourceMeta(platformInfo);

    if (fs.existsSync(appPath)) {
        const savedMeta = readMeta(platformInfo.installDir);
        if (!sourceChanged(savedMeta, currentMeta)) {
            return appPath;
        }
        console.log('BSL Analyzer: application artifact changed, re-downloading');
    }

    let releaseInfo: ReleaseInfo;
    try {
        releaseInfo = await getLatestReleaseInfo(platformInfo);
    } catch (err) {
        console.log(`BSL Analyzer: failed to read latest release metadata: ${(err as Error).message}`);
        releaseInfo = { downloadUrl: getFallbackDownloadUrl(platformInfo) };
    }

    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'BSL Analyzer: downloading application...',
            cancellable: false,
        },
        async () => {
            try {
                await installRelease(platformInfo, releaseInfo);
                writeMeta(platformInfo.installDir, currentSourceMeta(platformInfo, releaseInfo.version, releaseInfo.downloadUrl));
                return appPath;
            } catch (err) {
                vscode.window.showErrorMessage(
                    `BSL Analyzer: failed to download application from ${releaseInfo.downloadUrl}: ${(err as Error).message}`
                );
                return undefined;
            }
        }
    );
}

async function installRelease(platformInfo: PlatformInfo, releaseInfo: ReleaseInfo): Promise<void> {
    const appPath = path.join(platformInfo.installDir, platformInfo.localName);
    const data = await downloadFile(releaseInfo.downloadUrl);
    const tempPath = path.join(platformInfo.installDir, `${platformInfo.localName}.download`);
    const backupPath = path.join(platformInfo.installDir, `${platformInfo.localName}.previous`);

    fs.mkdirSync(platformInfo.installDir, { recursive: true });
    fs.writeFileSync(tempPath, data);

    if (process.platform !== 'win32') {
        fs.chmodSync(tempPath, 0o755);
    }

    let backupCreated = false;
    if (fs.existsSync(appPath)) {
        if (fs.existsSync(backupPath)) {
            fs.unlinkSync(backupPath);
        }
        fs.renameSync(appPath, backupPath);
        backupCreated = true;
    }

    try {
        fs.renameSync(tempPath, appPath);
        if (backupCreated) {
            fs.unlinkSync(backupPath);
        }
    } catch (err) {
        if (backupCreated && !fs.existsSync(appPath)) {
            fs.renameSync(backupPath, appPath);
        }
        throw err;
    }
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
    const manualPath = getConfiguredValue<string>('server.path', '');

    if (manualPath && fs.existsSync(manualPath)) {
        return {
            available: false,
            currentVersion: getInstalledBinaryVersion(manualPath),
            reason: 'manual server path is configured',
        };
    }

    const platformInfo = getPlatformInfo();
    if (!platformInfo) {
        return {
            available: false,
            reason: `unsupported platform ${process.platform}-${process.arch}`,
        };
    }

    const appPath = path.join(platformInfo.installDir, platformInfo.localName);
    const savedMeta = readMeta(platformInfo.installDir);
    const currentVersion = savedMeta?.version || (fs.existsSync(appPath) ? getInstalledBinaryVersion(appPath) : undefined);
    const latest = await getLatestReleaseInfo(platformInfo);

    const available = sourceChanged(savedMeta, currentSourceMeta(platformInfo))
        || (!!latest.version && (currentVersion ? isVersionNewer(latest.version, currentVersion) : fs.existsSync(appPath)));

    return {
        available,
        currentVersion,
        latestVersion: latest.version,
        downloadUrl: latest.downloadUrl,
    };
}

function getConfiguredValue<T>(key: string, defaultValue: T): T {
    const config = vscode.workspace.getConfiguration(EXTENSION_CONFIG_SECTION);
    const value = config.get<T>(key);
    if (value !== undefined) {
        return value;
    }
    return vscode.workspace.getConfiguration(LEGACY_CONFIG_SECTION).get<T>(key, defaultValue);
}

export async function installUpdate(check: UpdateCheckResult): Promise<InstallResult | undefined> {
    const platformInfo = getPlatformInfo();
    if (!platformInfo || !check.downloadUrl) {
        return undefined;
    }

    const appPath = path.join(platformInfo.installDir, platformInfo.localName);
    await installRelease(platformInfo, {
        version: check.latestVersion,
        downloadUrl: check.downloadUrl,
    });
    writeMeta(platformInfo.installDir, currentSourceMeta(platformInfo, check.latestVersion, check.downloadUrl));
    return {
        path: appPath,
        version: check.latestVersion,
    };
}
