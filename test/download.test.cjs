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
