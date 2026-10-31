'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHarness, createExtension, assertCleanupWarning, fault } = require('./helpers.cjs');

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

test('I1/I8: command awaits stop/install/start; actual cleanup EPERM still reports success', { timeout: 5000 }, async t => {
    const h = createHarness(t);
    h.seed();
    h.fs.unlinkSync = p => {
        if (p.startsWith(`${h.app}.previous`)) throw fault('EPERM', `unlink ${p}`);
        return fs.unlinkSync(p);
    };
    const stopEntered = deferred(), allowStop = deferred();
    const startEntered = deferred(), allowStart = deferred();
    const extension = createExtension(h, {
        async stop() {
            stopEntered.resolve();
            await allowStop.promise;
        },
        async start(count) {
            if (count > 1) {
                assert.equal(h.appBytes(), h.bytes);
                assert.equal(h.meta().version, h.latest);
                startEntered.resolve();
                await allowStart.promise;
            }
        },
    });
    // Release gates even if an assertion fails, so no unresolved work survives.
    t.after(() => { allowStop.resolve(); allowStart.resolve(); });
    await extension.activate();
    h.trace.length = 0;
    const update = extension.update();
    // Observe the promise immediately, including on an early assertion failure.
    t.after(() => update.catch(() => {}));
    await stopEntered.promise;
    assert.deepEqual(h.trace, ['stop']);
    assert.equal(h.downloads().length, 0);
    assert.equal(h.appBytes(), 'old-executable');
    allowStop.resolve();
    await startEntered.promise;
    assert.deepEqual(h.trace, ['stop', 'stopped', 'install', 'start']);
    assert.equal(h.infos.some(m => m.includes('updated to')), false);
    allowStart.resolve();
    await update;
    assert.equal(h.backups().length, 1);
    assertCleanupWarning(h, 'unlink', h.backups()[0], 'EPERM');
    assert.ok(h.infos.some(m => m === 'BSL Analyzer updated to v2.0.0'));
    assert.equal(h.errors.length, 0);
    assert.deepEqual(h.forbidden, []);
});

for (const operation of ['download', 'rename', 'meta']) {
    test(`I1/I8: ${operation} installation failure is shown, attempts client recovery, never reports success`, async t => {
        const h = createHarness(t);
        h.seed();
        const extension = createExtension(h);
        await extension.activate();
        h.trace.length = 0;
        if (operation === 'download') h.downloadError = true;
        if (operation === 'rename') {
            h.fs.renameSync = (from, to) => {
                if (from === `${h.app}.download`) throw fault('EPERM', 'place-new');
                return fs.renameSync(from, to);
            };
        }
        if (operation === 'meta') {
            h.fs.writeFileSync = (p, ...args) => {
                if (p === h.metaPath) throw fault('EACCES', 'write meta');
                return fs.writeFileSync(p, ...args);
            };
        }
        await extension.update();
        assert.deepEqual(h.trace, operation === 'download'
            ? ['stop', 'stopped', 'start'] : ['stop', 'stopped', 'install', 'start']);
        assert.ok(h.errors.some(m => m.startsWith('BSL Analyzer: failed to install update:')
            && (operation === 'meta' ? m.includes('was replaced, but installed version was not saved')
                : m.includes(operation === 'download' ? 'ECONNRESET' : 'EPERM'))), h.errors.join('\n'));
        assert.equal(h.infos.some(m => m.includes('updated to')), false);
        assert.equal(h.meta().version, 'v1.0.0');
        assert.equal(h.appBytes(), operation === 'meta' ? h.bytes : 'old-executable');
        assert.equal(h.warnings.length, 0);
        assert.deepEqual(h.forbidden, []);
    });
}

test('I1: clean update reports success without cleanup warning or external process management', async t => {
    const h = createHarness(t);
    h.seed();
    const extension = createExtension(h);
    await extension.activate();
    h.trace.length = 0;
    await extension.update();
    assert.deepEqual(h.trace, ['stop', 'stopped', 'install', 'start']);
    assert.ok(h.infos.some(m => m.includes('BSL Analyzer updated to v2.0.0')));
    assert.equal(h.errors.length, 0);
    assert.equal(h.warnings.length, 0);
    assert.deepEqual(h.forbidden, []);
});

test('busy exe: update with locked backup warns once and still reports success', async t => {
    const h = createHarness(t);
    h.seed();
    h.fs.unlinkSync = p => {
        if (p.startsWith(`${h.app}.previous`)) throw fault('EBUSY', `unlink ${p}`);
        return fs.unlinkSync(p);
    };
    const extension = createExtension(h);
    await extension.activate();
    await extension.update();
    assert.equal(h.uiWarnings.filter(m => m.includes('may still be running')).length, 1, h.uiWarnings.join('\n'));
    assert.ok(h.infos.some(m => m === 'BSL Analyzer updated to v2.0.0'));
    assert.equal(h.errors.length, 0);
    assert.deepEqual(h.forbidden, []);
});

test('meta reconcile: activation does not wait for a hanging version probe and heals meta once it answers', async t => {
    const h = createHarness(t);
    h.seed('v1.0.0');
    let answer;
    h.probe = callback => { answer = () => callback(null, 'bsl-analyzer 1.5.0\n', ''); };
    const extension = createExtension(h);
    await extension.activate(); // resolves although the probe has not answered
    assert.deepEqual(h.trace, ['start']);
    assert.equal(h.meta().version, 'v1.0.0');
    answer();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.meta().version, 'v1.5.0');
    assert.deepEqual(h.forbidden, []);
});

test('meta reconcile: failing version probe neither breaks nor delays activation', async t => {
    const h = createHarness(t);
    h.seed('v1.0.0');
    h.probe = callback => callback(fault('EACCES', 'spawn'), '', '');
    const extension = createExtension(h);
    await extension.activate();
    assert.deepEqual(h.trace, ['start']);
    assert.equal(h.meta().version, 'v1.0.0');
    assert.equal(h.errors.length, 0);
});
