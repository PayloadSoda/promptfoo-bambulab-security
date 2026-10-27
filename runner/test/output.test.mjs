import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { saveOutput } from '../output.mjs';

test('JSON history preserves complete native exports across repeated writes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runner-output-'));
  try {
    const output = path.join(directory, 'output.json');
    const staged = path.join(directory, 'new.json');
    const exports = [1, 2, 3].map(i => ({ evalId: `eval-${i}`, results: { results: [{ response: { output: `结果 ${i}` } }], stats: { successes: i } }, config: { description: `run ${i}` } }));
    for (let i = 0; i < exports.length; i++) {
      await writeFile(staged, JSON.stringify(exports[i]));
      const saved = await saveOutput(staged, output);
      assert.equal(saved.appended, i > 0);
      const actual = JSON.parse(await readFile(output, 'utf8'));
      assert.deepEqual(actual, i === 0 ? exports[0] : exports.slice(0, i + 1));
    }
    const before = await readFile(output, 'utf8');
    await writeFile(staged, '{incomplete');
    await assert.rejects(saveOutput(staged, output));
    assert.equal(await readFile(output, 'utf8'), before);
    await writeFile(output, '{invalid original');
    await writeFile(staged, JSON.stringify(exports[0]));
    await assert.rejects(saveOutput(staged, output));
    assert.equal(await readFile(output, 'utf8'), '{invalid original');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('JSONL appends lines and document formats keep the previous export', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runner-output-'));
  try {
    const staged = path.join(directory, 'new');
    const output = path.join(directory, 'output.jsonl');
    await writeFile(output, '{"old":true}');
    await writeFile(staged, '{"new":true}\n');
    await saveOutput(staged, output);
    assert.equal(await readFile(output, 'utf8'), '{"old":true}\n{"new":true}\n');
    const html = path.join(directory, 'output.html');
    await writeFile(html, '<html>old</html>');
    await writeFile(staged, '<html>new</html>');
    const saved = await saveOutput(staged, html);
    assert.equal(await readFile(html, 'utf8'), '<html>new</html>');
    assert.equal(await readFile(saved.backup, 'utf8'), '<html>old</html>');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
