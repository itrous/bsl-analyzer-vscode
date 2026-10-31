'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness, assertCleanupWarning, fault, UUID } = require('./helpers.cjs');

function assertResult(result, h, version) {
    assert.deepEqual(Object.keys(result).sort(), ['path', 'version']);
    assert.equal(result.path, h.app);
    assert.equal(result.version, version);
}

function lockBackups(h, code = 'EPERM') {
    h.fs.unlinkSync = p => {
        if (p.startsWith(`${h.app}.previous`)) throw fault(code, `unlink ${p}`);
        return fs.unlinkSync(p);
    };
}

test('I2/I8: locked new backup does not undo install/meta; current check never downloads', async t => {
    const h = createHarness(t);
    h.seed();
    const operations = [];
    h.fs.writeFileSync = (p, ...args) => {
        if (p === h.metaPath) operations.push('meta');
        return fs.writeFileSync(p, ...args);
    };
    h.fs.unlinkSync = p => {
        if (p.startsWith(`${h.app}.previous`)) {
            operations.push('unlink');
            throw fault('EPERM', `unlink ${p}`);
        }
        return fs.unlinkSync(p);
    };
    assertResult(await h.install(), h, h.latest);
    assert.deepEqual(operations, ['meta', 'unlink']);
    assert.equal(h.appBytes(), h.bytes);
    assert.equal(h.meta().version, h.latest);
    assert.equal(h.backups().length, 1);
    const backup = h.backups()[0];
    assert.match(backup.slice(`${h.app}.previous.`.length), UUID);
    assert.equal(fs.readFileSync(backup, 'utf8'), 'old-executable');
    assertCleanupWarning(h, 'unlink', backup, 'EPERM');
    const downloads = h.downloads().length;
    const check = await h.download.checkForUpdate();
    assert.deepEqual(Object.keys(check).sort(), ['available', 'currentVersion', 'downloadUrl', 'latestVersion']);
    assert.equal(check.available, false);
    assert.equal(check.currentVersion, h.latest);
    assert.equal(check.latestVersion, h.latest);
    assert.equal(check.downloadUrl, h.url);
    assert.equal(h.downloads().length, downloads);
    assert.ok(fs.existsSync(backup));
});

for (const operation of ['download', 'chmod', 'move-current', 'place-new']) {
    test(`I3: ${operation} failure preserves old version and restores old executable`, async t => {
        const h = createHarness(t, { platform: operation === 'chmod' ? 'linux' : 'win32' });
        h.seed();
        const oldMeta = fs.readFileSync(h.metaPath, 'utf8');
        if (operation === 'download') h.downloadError = true;
        if (operation === 'chmod') h.fs.chmodSync = () => { throw fault('EACCES', 'chmod'); };
        if (operation === 'move-current' || operation === 'place-new') {
            h.fs.renameSync = (from, to) => {
                if (operation === 'move-current' ? from === h.app : from === `${h.app}.download`) {
                    throw fault('EPERM', operation);
                }
                return fs.renameSync(from, to);
            };
        }
        await assert.rejects(h.install(), err => {
            assert.match(err.message, operation === 'download' ? /ECONNRESET/ : /EACCES|EPERM/);
            if (operation === 'move-current') {
                assert.ok(err.message.includes(h.app));
                assert.match(err.message, /close processes using it and retry/);
            }
            return true;
        });
        assert.equal(h.appBytes(), 'old-executable');
        assert.equal(fs.readFileSync(h.metaPath, 'utf8'), oldMeta);
        assert.equal(h.backups().length, 0);
        assert.equal(h.warnings.length, 0);
    });
}

test('I3/I8: meta write failure is explicit, keeps new exe and backup, and is recoverable', async t => {
    const h = createHarness(t);
    h.seed();
    h.fs.writeFileSync = (p, ...args) => {
        if (p === h.metaPath) throw fault('EACCES', 'write meta');
        return fs.writeFileSync(p, ...args);
    };
    await assert.rejects(h.install(), err => {
        assert.match(err.message, /was replaced, but installed version was not saved/);
        assert.ok(err.message.includes(h.app) && err.message.includes(h.metaPath));
        assert.match(err.message, /EACCES/);
        assert.doesNotMatch(err.message, /backup cleanup failed/);
        return true;
    });
    assert.equal(h.appBytes(), h.bytes);
    assert.equal(h.meta().version, 'v1.0.0');
    assert.equal(h.backups().length, 1);
    assert.equal(fs.readFileSync(h.backups()[0], 'utf8'), 'old-executable');
    assert.equal(h.warnings.length, 0);
    h.fs.writeFileSync = fs.writeFileSync;
    assertResult(await h.install(), h, h.latest);
    assert.equal(h.meta().version, h.latest);
    assert.equal(h.backups().length, 0);
});

test('I3/I5: failed rollback is visible; start/check preserve sole backup when exe is absent', async t => {
    const h = createHarness(t);
    h.seed();
    h.fs.renameSync = (from, to) => {
        if (to === h.app) throw fault('EPERM', from.endsWith('.download') ? 'place-new' : 'restore-old');
        return fs.renameSync(from, to);
    };
    await assert.rejects(h.install(), err => {
        assert.match(err.message, /failed to install.*place-new.*failed to restore previous application.*restore-old/);
        return true;
    });
    assert.equal(fs.existsSync(h.app), false);
    const backup = h.backups()[0];
    assert.equal(fs.readFileSync(backup, 'utf8'), 'old-executable');
    h.fs.unlinkSync = () => assert.fail('must not delete sole backup');
    await h.download.checkForUpdate();
    assert.ok(fs.existsSync(backup));
    h.downloadError = true;
    assert.equal(await h.download.ensureLauncher({}), undefined);
    assert.ok(fs.existsSync(backup));
    assert.equal(h.meta().version, 'v1.0.0');
    assert.ok(h.errors.some(e => e.includes('failed to download application') && e.includes('ECONNRESET')));
});

test('I4: stale meta + locked legacy/UUID backups recover; another newer release uses a fresh name', async t => {
    const h = createHarness(t);
    h.seed('v1.0.0', 'already-new-executable');
    const legacy = h.backup();
    const own = h.backup('.11111111-1111-4111-8111-111111111111');
    lockBackups(h);
    assert.equal((await h.download.checkForUpdate()).available, true);
    assertResult(await h.install(), h, 'v2.0.0');
    assert.equal(h.meta().version, 'v2.0.0');
    assert.equal((await h.download.checkForUpdate()).available, false);
    const first = h.backups();
    assert.equal(first.length, 3);
    assert.ok(first.includes(legacy) && first.includes(own));
    h.latest = 'v3.0.0';
    h.bytes = 'third-executable';
    assert.equal((await h.download.checkForUpdate()).available, true);
    assertResult(await h.install(), h, 'v3.0.0');
    assert.equal(h.appBytes(), 'third-executable');
    assert.equal(h.meta().version, 'v3.0.0');
    assert.equal(h.backups().length, 4);
    assert.ok(first.every(p => fs.existsSync(p)));
    assert.equal((await h.download.checkForUpdate()).available, false);
});

for (const entry of ['start', 'check', 'install']) {
    test(`I5/I8: ${entry} warns on held leftovers, retries after release, preserves neighbours`, async t => {
        const h = createHarness(t);
        h.seed();
        const legacy = h.backup();
        const own = h.backup('.11111111-1111-4111-8111-111111111111');
        const neighbours = [
            h.backup('.not-a-uuid'), h.backup('.11111111-1111-4111-8111-111111111111.txt'),
            path.join(h.installDir, 'other-app.exe.previous'),
            path.join(h.installDir, 'other-app.exe.previous.11111111-1111-4111-8111-111111111111'),
        ];
        for (const p of neighbours) fs.writeFileSync(p, 'neighbour');
        const run = () => entry === 'start' ? h.download.ensureLauncher({})
            : entry === 'check' ? h.download.checkForUpdate() : h.install();
        lockBackups(h);
        await run();
        for (const p of [legacy, own]) {
            assert.ok(fs.existsSync(p));
            assertCleanupWarning(h, 'unlink', p, 'EPERM');
        }
        assert.equal(h.errors.length, 0);
        h.fs.unlinkSync = fs.unlinkSync;
        h.warnings.length = 0;
        await run();
        assert.equal(h.backups().length, 0);
        assert.equal(h.warnings.length, 0);
        for (const p of neighbours) assert.equal(fs.readFileSync(p, 'utf8'), 'neighbour');
    });
}

for (const entry of ['start', 'check', 'install']) {
    for (const operation of ['readdir', 'unlink']) {
        test(`I5/I8: ${entry} ${operation} EIO is observable and nonfatal`, async t => {
            const h = createHarness(t);
            h.seed();
            const legacy = h.backup();
            if (operation === 'readdir') h.fs.readdirSync = () => { throw fault('EIO', 'read backups'); };
            else h.fs.unlinkSync = () => { throw fault('EIO', 'unlink backup'); };
            if (entry === 'start') assert.equal(await h.download.ensureLauncher({}), h.app);
            if (entry === 'check') assert.equal((await h.download.checkForUpdate()).available, true);
            if (entry === 'install') {
                assertResult(await h.install(), h, h.latest);
                assert.equal(h.meta().version, h.latest);
            }
            assertCleanupWarning(h, operation, operation === 'readdir' ? h.installDir : legacy, 'EIO');
            assert.ok(fs.existsSync(legacy));
            assert.equal(h.errors.length, 0);
        });
    }
}

test('I5: ENOENT during cleanup is normal, not a warning or install failure', async t => {
    const h = createHarness(t);
    h.seed();
    const legacy = h.backup();
    h.fs.unlinkSync = p => {
        fs.unlinkSync(p); // Another actor removed it between enumeration and unlink.
        throw fault('ENOENT', 'already removed');
    };
    assertResult(await h.install(), h, h.latest);
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(h.backups().length, 0);
    assert.equal(h.warnings.length, 0);
});

test('I6: real Unix first install/update preserve 0755, JSON format/fields and public API', {
    skip: process.platform === 'win32' ? 'requires actual Unix filesystem modes' : false,
}, async t => {
    const h = createHarness(t, { platform: 'linux' });
    assert.equal(await h.download.ensureLauncher({}), h.app);
    const verify = () => {
        assert.equal(fs.statSync(h.app).mode & 0o777, 0o755);
        const meta = h.meta();
        assert.deepEqual(Object.keys(meta).sort(), ['artifactName', 'downloadUrl', 'installedAt', 'version']);
        assert.equal(meta.artifactName, h.assetName);
        assert.equal(meta.version, h.latest);
        assert.equal(meta.downloadUrl, h.url);
        assert.equal(new Date(meta.installedAt).toISOString(), meta.installedAt);
        assert.equal(fs.readFileSync(h.metaPath, 'utf8'), JSON.stringify(meta, null, 2));
        assert.equal(h.download.getInstalledVersion(), h.latest);
        assert.equal(h.appBytes(), h.bytes);
        assert.equal(h.backups().length, 0);
    };
    verify();
    h.latest = 'v3.0.0';
    h.bytes = 'third-executable';
    const check = await h.download.checkForUpdate();
    assert.equal(check.available, true);
    assertResult(await h.download.installUpdate(check), h, h.latest);
    verify();
    const downloads = h.downloads().length;
    assert.equal((await h.download.checkForUpdate()).available, false);
    assert.equal(h.downloads().length, downloads);
    assert.equal(h.warnings.length, 0);
    assert.equal(h.errors.length, 0);
});

for (const section of ['bsl-analyzer-lsp', 'bsl-analyzer']) {
    test(`I7: ${section} manual server.path bypasses managed install/check/cleanup`, async t => {
        const config = {};
        const h = createHarness(t, { config });
        h.seed();
        const manual = path.join(h.root, 'manual-app.exe');
        fs.writeFileSync(manual, 'manual-executable');
        fs.writeFileSync(`${manual}.previous`, 'manual-backup');
        config[`${section}.server.path`] = manual;
        const backup = h.backup();
        const meta = fs.readFileSync(h.metaPath, 'utf8');
        h.fs.unlinkSync = () => assert.fail('manual installation must not be cleaned');
        assert.equal(await h.download.ensureLauncher({}), manual);
        const check = await h.download.checkForUpdate();
        assert.equal(check.available, false);
        assert.equal(check.currentVersion, 'v1.0.0');
        assert.equal(check.reason, 'manual server path is configured');
        assert.equal(h.requests.length, 0);
        assert.ok(fs.existsSync(backup));
        assert.equal(fs.readFileSync(h.metaPath, 'utf8'), meta);
        assert.equal(h.appBytes(), 'old-executable');
        assert.equal(fs.readFileSync(manual, 'utf8'), 'manual-executable');
        assert.equal(fs.readFileSync(`${manual}.previous`, 'utf8'), 'manual-backup');
    });
}

test('I7: metadata fallback installs without inventing version', async t => {
    const h = createHarness(t);
    h.metadataError = true;
    assert.equal(await h.download.ensureLauncher({}), h.app);
    const meta = h.meta();
    assert.deepEqual(Object.keys(meta).sort(), ['artifactName', 'downloadUrl', 'installedAt']);
    assert.equal(meta.artifactName, h.assetName);
    assert.equal(meta.version, undefined);
    assert.equal(meta.downloadUrl, `https://github.com/itrous/bsl-analyzer/releases/latest/download/${h.assetName}`);
    assert.equal(new Date(meta.installedAt).toISOString(), meta.installedAt);
    assert.equal(h.appBytes(), h.bytes);
    assert.ok(h.logs.some(l => /failed to read latest release metadata.*ECONNRESET/.test(l)));
    assert.equal(h.errors.length, 0);
});

const BUSY_WARNING = /may still be running in another process/;

for (const code of ['EPERM', 'EBUSY']) {
    test(`busy exe: ${code} on backup removal after install shows one warning, install stays successful`, async t => {
        const h = createHarness(t);
        h.seed();
        lockBackups(h, code);
        assertResult(await h.install(), h, h.latest);
        assert.equal(h.uiWarnings.filter(m => BUSY_WARNING.test(m)).length, 1, h.uiWarnings.join('\n'));
        assert.equal(h.appBytes(), h.bytes);
        assert.equal(h.meta().version, h.latest);
        assert.equal(h.errors.length, 0);
        assertCleanupWarning(h, 'unlink', h.backups()[0], code);
    });
}

test('busy exe: no warning without EPERM/EBUSY (clean removal, EIO, ENOENT)', async t => {
    for (const code of [undefined, 'EIO', 'ENOENT']) {
        const h = createHarness(t);
        h.seed();
        if (code) {
            h.fs.unlinkSync = p => {
                if (p.startsWith(`${h.app}.previous`)) throw fault(code, `unlink ${p}`);
                return fs.unlinkSync(p);
            };
        }
        assertResult(await h.install(), h, h.latest);
        assert.deepEqual(h.uiWarnings, [], String(code));
    }
});

test('busy exe: leftover from an earlier install being locked does not warn when this install cleans up', async t => {
    const h = createHarness(t);
    h.seed();
    h.backup();
    h.fs.unlinkSync = p => {
        if (p === `${h.app}.previous`) throw fault('EPERM', `unlink ${p}`);
        return fs.unlinkSync(p);
    };
    assertResult(await h.install(), h, h.latest);
    assert.deepEqual(h.uiWarnings, []);
});

test('meta reconcile: matching version leaves meta untouched', async t => {
    const h = createHarness(t);
    h.seed('v1.0.0');
    h.reportVersion('1.0.0');
    const before = fs.readFileSync(h.metaPath, 'utf8');
    const writes = [];
    h.fs.writeFileSync = (p, ...args) => { writes.push(p); return fs.writeFileSync(p, ...args); };
    assert.equal(await h.download.reconcileMetaVersion(), false);
    assert.deepEqual(writes, []);
    assert.equal(fs.readFileSync(h.metaPath, 'utf8'), before);
    assert.deepEqual(h.probes, [{ file: h.app, timeout: 5000 }]);
});

test('meta reconcile: differing version is rewritten with the binary version, other fields kept', async t => {
    const h = createHarness(t);
    h.seed('v0.4.0');
    h.reportVersion('0.4.1');
    const before = h.meta();
    assert.equal(await h.download.reconcileMetaVersion(), true);
    const after = h.meta();
    assert.equal(after.version, 'v0.4.1');
    assert.equal(after.artifactName, before.artifactName);
    assert.equal(after.installedAt, before.installedAt);
    assert.equal(after.downloadUrl, undefined);
    assert.equal(h.download.getInstalledVersion(), 'v0.4.1');
    assert.equal((await h.download.checkForUpdate()).currentVersion, 'v0.4.1');
});

test('meta reconcile: meta without version (metadata fallback install) gets the binary version', async t => {
    const h = createHarness(t);
    h.metadataError = true;
    await h.download.ensureLauncher({});
    assert.equal(h.meta().version, undefined);
    h.reportVersion('2.0.0');
    assert.equal(await h.download.reconcileMetaVersion(), true);
    assert.equal(h.meta().version, 'v2.0.0');
});

const failures = {
    'probe fails': callback => queueMicrotask(() => callback(fault('EACCES', 'spawn'), '', '')),
    'probe times out': callback => queueMicrotask(() => callback(
        Object.assign(new Error('Command failed: timed out'), { killed: true, signal: 'SIGTERM' }), '', '')),
    'output is not parsable': callback => queueMicrotask(() => callback(null, 'something else 1.2.3\n', '')),
    'output is empty': callback => queueMicrotask(() => callback(null, '', '')),
    'probe throws synchronously': () => { throw fault('EINVAL', 'spawn'); },
};
for (const [name, probe] of Object.entries(failures)) {
    test(`meta reconcile: ${name} - meta untouched, nothing thrown`, async t => {
        const h = createHarness(t);
        h.seed('v0.4.0');
        h.probe = probe;
        const before = fs.readFileSync(h.metaPath, 'utf8');
        const writes = [];
    h.fs.writeFileSync = (p, ...args) => { writes.push(p); return fs.writeFileSync(p, ...args); };
        assert.equal(await h.download.reconcileMetaVersion(), false);
        assert.equal(fs.readFileSync(h.metaPath, 'utf8'), before);
        assert.equal(h.probes.length, 1);
        assert.ok(h.logs.some(l => l.includes('meta version check')), h.logs.join('\n'));
    });
}

test('meta reconcile: missing exe is not probed and meta is untouched', async t => {
    const h = createHarness(t);
    h.seed('v0.4.0');
    fs.rmSync(h.app);
    h.reportVersion('0.4.1');
    assert.equal(await h.download.reconcileMetaVersion(), false);
    assert.equal(h.probes.length, 0);
    assert.equal(h.meta().version, 'v0.4.0');
});

test('meta reconcile: manual server.path is not probed', async t => {
    const config = {};
    const h = createHarness(t, { config });
    h.seed('v0.4.0');
    const manual = path.join(h.root, 'manual-app.exe');
    fs.writeFileSync(manual, 'manual-executable');
    config['bsl-analyzer-lsp.server.path'] = manual;
    h.reportVersion('0.4.1');
    assert.equal(await h.download.reconcileMetaVersion(), false);
    assert.equal(h.probes.length, 0);
    assert.equal(h.meta().version, 'v0.4.0');
});

test('meta reconcile: probe of the old exe finishing after an install does not overwrite new meta', async t => {
    const h = createHarness(t);
    h.seed('v1.0.0');
    let finish;
    h.probe = callback => { finish = () => callback(null, 'bsl-analyzer 1.0.0\n', ''); };
    const pending = h.download.reconcileMetaVersion();
    assertResult(await h.install(), h, h.latest);
    finish();
    assert.equal(await pending, false);
    assert.equal(h.meta().version, h.latest);
});

test('meta reconcile: probe of the old exe finishing after an external replacement does not overwrite meta', async t => {
    const h = createHarness(t);
    h.seed('v1.0.0');
    let finish;
    h.probe = callback => { finish = () => callback(null, 'bsl-analyzer 1.0.0\n', ''); };
    const pending = h.download.reconcileMetaVersion();
    // Another window installs v2 into the same directory (new file, new inode).
    fs.writeFileSync(`${h.app}.other`, 'other-window-executable');
    fs.renameSync(`${h.app}.other`, h.app);
    fs.writeFileSync(h.metaPath, JSON.stringify({ artifactName: h.assetName, version: 'v2.0.0' }));
    finish();
    assert.equal(await pending, false);
    assert.equal(h.meta().version, 'v2.0.0');
});

test('meta reconcile: checkForUpdate reconciles first, so a stale meta does not trigger a needless update', async t => {
    const h = createHarness(t);
    h.seed('v1.0.0', 'already-new-executable');
    h.reportVersion('2.0.0');
    const check = await h.download.checkForUpdate();
    assert.equal(check.available, false);
    assert.equal(check.currentVersion, 'v2.0.0');
    assert.equal(h.meta().version, 'v2.0.0');
});

test('meta reconcile: checkForUpdate survives a failing probe', async t => {
    const h = createHarness(t);
    h.seed('v1.0.0');
    h.probe = callback => queueMicrotask(() => callback(fault('EACCES', 'spawn'), '', ''));
    const check = await h.download.checkForUpdate();
    assert.equal(check.available, true);
    assert.equal(check.currentVersion, 'v1.0.0');
    assert.equal(h.meta().version, 'v1.0.0');
});
