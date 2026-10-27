import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import { overrideConfig, prepareConfig, readTargets, confirmTargets, defaultTargetYaml } from '../targets.mjs';

test('override replaces either target key, preserves tests and uses project-relative provider paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runner-targets-'));
  try {
    await mkdir(path.join(root, 'foreign'));
    await writeFile(path.join(root, 'my provider.cjs'), 'module.exports = class {};');
    const filename = path.join(root, 'foreign', 'test.yaml');
    const mine = { id: 'file://my provider.cjs', label: 'mine', config: { baseUrl: 'https://example.test', marker: 'my-setting' } };
    for (const key of ['targets', 'providers']) {
      const config = { [key]: [{ id: 'file://missing-provider.js', config: { unwanted: true } }], prompts: ['file://prompts.txt'], tests: 'file://tests.yaml', defaultTest: { options: { provider: 'echo' } }, basePath: '.', description: 'foreign config' };
      const original = stringify(config);
      await writeFile(filename, original);
      const result = parse(await overrideConfig(root, filename, stringify({ targets: [mine] })));
      assert.deepEqual(result[key], [{ ...mine, id: `file://${path.join(root, 'my provider.cjs')}` }]);
      assert.equal(result[key === 'targets' ? 'providers' : 'targets'], undefined);
      for (const field of ['prompts', 'tests', 'defaultTest', 'basePath', 'description']) assert.deepEqual(result[field], config[field]);
      assert.equal(await readFile(filename, 'utf8'), original);
    }
    const prepared = await prepareConfig(root, { config: filename, overrideTargets: true, targetYaml: stringify(mine) });
    assert.equal(path.dirname(prepared.filename), path.dirname(filename));
    assert.notEqual(prepared.filename, filename);
    assert.equal(parse(await readFile(prepared.filename, 'utf8')).providers[0].label, 'mine');
    await prepared.cleanup();
    await assert.rejects(stat(prepared.filename), { code: 'ENOENT' });
    const unchanged = await prepareConfig(root, { config: filename, overrideTargets: false });
    assert.equal(unchanged.filename, filename);
    await unchanged.cleanup();
    assert.ok(await stat(filename));
    await assert.rejects(overrideConfig(root, filename, 'targets: []'), /至少/);
    await assert.rejects(overrideConfig(root, filename, 'targets: [{label: missing}]'), /id/);
    await assert.rejects(overrideConfig(root, filename, 'targets: [file:\/\/not-found.js]'), /找不到/);
    await assert.rejects(overrideConfig(root, filename, 'targets: [invalid'), /格式错误/);
    await assert.rejects(overrideConfig(root, filename, 'targets: [echo]\nproviders: [echo]'), /其中一种/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('file defaults and personal defaults resolve against their own directories on confirmation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runner-confirm-'));
  try {
    const foreign = path.join(root, 'other', 'scripts');
    await mkdir(foreign, { recursive: true });
    await mkdir(path.join(root, 'test_set'));
    await writeFile(path.join(root, 'bambuProvider.js'), 'module.exports = class {};');
    await writeFile(path.join(foreign, 'foreign.cjs'), 'module.exports = class {};');
    const filename = path.join(foreign, 'test.yaml');
    const original = 'providers:\n  - id: file://foreign.cjs\n    label: file-default\n    config:\n      retries: 2\n      enabled: true\nprompts: [hello]\n';
    await writeFile(filename, original);
    const fileTargets = readTargets(original);
    assert.equal(fileTargets[0].config.retries, 2);
    const file = await confirmTargets(root, filename, fileTargets, 'file');
    assert.equal(readTargets(file.targetYaml)[0].id, `file://${path.join(foreign, 'foreign.cjs')}`);
    const personal = readTargets(defaultTargetYaml);
    assert.equal(personal[0].id, 'file://../bambuProvider.js');
    assert.equal(personal[0].label, 'bambu');
    assert.equal(personal[0].config.baseUrl, 'https://support.bambulab.cn');
    const mine = await confirmTargets(root, filename, personal, 'personal');
    assert.equal(readTargets(mine.targetYaml)[0].id, `file://${path.join(root, 'bambuProvider.js')}`);
    assert.equal(readTargets(mine.targetYaml)[0].label, 'bambu');
    assert.deepEqual(parse(mine.effectiveYaml).prompts, ['hello']);
    assert.equal(await readFile(filename, 'utf8'), original);
    await assert.rejects(confirmTargets(root, filename, [], 'file'), /至少/);
    await assert.rejects(confirmTargets(root, filename, personal, 'invalid'), /来源/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
