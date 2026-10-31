'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');

const META = '.bsl-analyzer.meta.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fault(code, operation = 'injected failure') {
    return Object.assign(new Error(`${code}: ${operation}`), { code });
}

// Execute the compiled production module, not a test reimplementation. All
// filesystem operations are real unless a test explicitly injects one fault.
function load(name, bindings, globals = {}) {
    const filename = path.join(__dirname, '..', 'out', `${name}.js`);
    const module = { exports: {} };
    const sandbox = {
        module, exports: module.exports, Buffer, URL,
        require(id) {
            assert.ok(Object.hasOwn(bindings, id), `unexpected dependency: ${id}`);
            return bindings[id];
        },
        ...globals,
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return module.exports;
}

function createHarness(t, { platform = 'win32', config = {} } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsl-update-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const localName = platform === 'win32' ? 'bsl-analyzer-app.exe' : 'bsl-analyzer-app';
    const assetName = platform === 'win32' ? 'bsl-analyzer-app-windows-amd64.exe' : 'bsl-analyzer-app-linux-amd64';
    const installDir = platform === 'win32' ? path.join(root, 'bsl-analyzer-app') : path.join(root, '.local', 'bin');
    const app = path.join(installDir, localName);
    const metaPath = path.join(installDir, META);
    const probes = [];
    const warnings = [], uiWarnings = [], errors = [], infos = [], logs = [], requests = [], trace = [], forbidden = [];
    const fsApi = { ...fs };
    const h = {
        root, installDir, app, metaPath, localName, assetName,
        warnings, uiWarnings, errors, infos, logs, requests, trace, forbidden, fs: fsApi,
        // Result of `<app> --version`, as `(callback) => void` or undefined for ENOENT.
        probe: undefined, probes,
        latest: 'v2.0.0', bytes: 'new-executable', metadataError: false, downloadError: false,
        url: 'https://fixture.invalid/app',
        seed(version = 'v1.0.0', bytes = 'old-executable') {
            fs.mkdirSync(installDir, { recursive: true });
            fs.writeFileSync(app, bytes);
            fs.writeFileSync(metaPath, JSON.stringify({
                artifactName: assetName, version, downloadUrl: 'https://fixture.invalid/old',
                installedAt: '2025-01-01T00:00:00.000Z',
            }, null, 2));
        },
        backup(suffix = '') {
            const p = `${app}.previous${suffix}`;
            fs.mkdirSync(installDir, { recursive: true });
            fs.writeFileSync(p, 'backup-executable');
            return p;
        },
        backups() {
            return fs.existsSync(installDir)
                ? fs.readdirSync(installDir).filter(n => n === `${localName}.previous`
                    || (n.startsWith(`${localName}.previous.`) && UUID.test(n.slice(`${localName}.previous.`.length))))
                    .map(n => path.join(installDir, n)) : [];
        },
        meta: () => JSON.parse(fs.readFileSync(metaPath, 'utf8')),
        appBytes: () => fs.readFileSync(app, 'utf8'),
        downloads: () => requests.filter(url => !url.startsWith('https://api.github.com/')),
        // `bsl-analyzer-app --version` prints the version without the tag's `v`.
        reportVersion(version) {
            h.probe = callback => queueMicrotask(() => callback(null, `bsl-analyzer ${version}\n`, ''));
        },
        install(version = h.latest) {
            return h.download.installUpdate({ available: true, latestVersion: version, downloadUrl: h.url });
        },
    };
    const forbid = operation => (...args) => {
        forbidden.push([operation, args]);
        throw new Error(`external process operation forbidden: ${operation}`);
    };
    const childProcess = {
        spawnSync: (_file, args) => {
            assert.ok(['--version', '--launcher-version'].includes(args[0]));
            return { status: 0, stdout: 'v1.0.0', stderr: '' };
        },
        execFile: (file, args, options, callback) => {
            assert.deepEqual(Array.from(args), ['--version']);
            probes.push({ file, timeout: options.timeout });
            if (h.probe) h.probe(callback);
            else queueMicrotask(() => callback(fault('ENOENT', 'spawn'), '', ''));
        },
        spawn: forbid('spawn'), exec: forbid('exec'), execSync: forbid('execSync'),
        execFileSync: forbid('execFileSync'), fork: forbid('fork'),
    };
    const processApi = { platform, arch: 'x64', env: { LOCALAPPDATA: root }, kill: forbid('kill') };
    const window = {
        showWarningMessage: message => { warnings.push(message); uiWarnings.push(message); return Promise.resolve(); },
        showErrorMessage: message => { errors.push(message); return Promise.resolve(); },
        showInformationMessage: (message, ...choices) => {
            infos.push(message);
            return Promise.resolve(choices.includes('Update') ? 'Update' : undefined);
        },
        withProgress: (_options, callback) => callback(),
        createStatusBarItem: () => ({ show() {}, dispose() {} }),
    };
    const vscode = {
        window, ProgressLocation: { Notification: 1, Window: 2 }, StatusBarAlignment: { Right: 1 },
        workspace: {
            getConfiguration: section => ({ get: (key, fallback) => config[`${section}.${key}`] ?? fallback }),
            createFileSystemWatcher: () => ({ dispose() {} }),
        },
        commands: { registerCommand: () => ({ dispose() {} }) },
        debug: { registerDebugAdapterDescriptorFactory: () => ({ dispose() {} }) },
    };
    const network = {
        get(url, _options, callback) {
            requests.push(url);
            const req = new EventEmitter();
            queueMicrotask(() => {
                const metadata = url.startsWith('https://api.github.com/');
                if (metadata ? h.metadataError : h.downloadError) {
                    req.emit('error', fault('ECONNRESET', metadata ? 'metadata' : 'download'));
                    return;
                }
                if (!metadata) trace.push('install');
                const res = new EventEmitter();
                res.statusCode = 200;
                res.headers = {};
                callback(res);
                res.emit('data', Buffer.from(metadata ? JSON.stringify({
                    tag_name: h.latest, assets: [{ name: assetName, browser_download_url: h.url }],
                }) : h.bytes));
                res.emit('end');
            });
            return req;
        },
    };
    const globals = {
        process: processApi,
        console: {
            log: (...args) => logs.push(args.join(' ')),
            warn: (...args) => warnings.push(args.join(' ')),
            error: (...args) => errors.push(args.join(' ')),
        },
    };
    h.download = load('download', {
        fs: fsApi, os: { ...os, homedir: () => root }, path,
        crypto: require('node:crypto'), https: network, http: network,
        vscode, child_process: childProcess,
    }, globals);
    h.vscode = vscode;
    h.globals = globals;
    h.childProcess = childProcess;
    return h;
}

function assertCleanupWarning(h, operation, target, code) {
    assert.ok(h.warnings.some(w => w.includes('backup cleanup failed')
        && w.includes(`${operation} ${target}`) && w.includes(code)
        && w.includes('installed application is not affected')), h.warnings.join('\n'));
}

function createExtension(h, options = {}) {
    const commands = new Map();
    let completion;
    let starts = 0;
    h.vscode.commands.registerCommand = (name, callback) => {
        commands.set(name, callback);
        return { dispose() {} };
    };
    const context = {
        subscriptions: [],
        globalState: {
            get: (_key, fallback) => fallback,
            async update(key) {
                if (key === 'bsl-analyzer-lsp.lastUpdateCheck') completion?.();
            },
        },
    };
    class LanguageClient {
        constructor(_id, _name, serverOptions) {
            assert.equal(serverOptions.command, h.app);
            assert.deepEqual(Array.from(serverOptions.args), []);
        }
        async start() {
            starts++;
            h.trace.push('start');
            if (options.start) await options.start(starts);
        }
        async stop() {
            h.trace.push('stop');
            if (options.stop) await options.stop();
            h.trace.push('stopped');
        }
    }
    const extension = load('extension', {
        vscode: h.vscode, './download': h.download,
        'vscode-languageclient/node': { LanguageClient, TransportKind: { stdio: 0 } },
        // Explicitly forbid any process-management dependency added here.
        child_process: h.childProcess,
    }, {
        ...h.globals,
        setTimeout: () => 1, setInterval: () => 2,
        clearTimeout() {}, clearInterval() {},
    });
    return {
        activate: () => extension.activate(context),
        async update() {
            // The registered command is intentionally fire-and-forget. Await
            // its public completion effect, with a bounded timeout on failure.
            let timer;
            try {
                await new Promise((resolve, reject) => {
                    completion = resolve;
                    timer = setTimeout(() => reject(new Error('update command did not finish')), 2000);
                    commands.get('bsl-analyzer-lsp.checkForUpdates')();
                });
            } finally {
                clearTimeout(timer);
                completion = undefined;
            }
        },
    };
}

module.exports = { createHarness, createExtension, assertCleanupWarning, fault, UUID };
