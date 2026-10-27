import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOutputs } from '../results.mjs';

test('extracts every repeat and provider output from the current native export', () => {
  const report = { evalId: 'current-eval', results: { results: [
    { testIdx: 0, testCase: { description: '第一组用例' }, provider: { label: 'bambu', id: 'file://provider.js' }, success: true, response: { output: '第一行\n第二行' }, latencyMs: 12.5 },
    { testIdx: 0, provider: { id: 'another-provider' }, success: false, response: { output: '<script>alert(1)</script>' } },
  ] } };
  const actual = extractOutputs(report);
  assert.equal(actual.evalId, 'current-eval');
  assert.equal(actual.records.length, 2);
  assert.equal(actual.records[0].output, '第一行\n第二行');
  assert.equal(actual.records[0].description, '第一组用例');
  assert.equal(actual.records[0].provider, 'bambu');
  assert.equal(actual.records[1].provider, 'another-provider');
  assert.equal(actual.records[1].success, false);
  assert.equal(actual.records[1].output, '<script>alert(1)</script>');
});

test('keeps empty, zero, false, null and structured outputs distinct from missing output', () => {
  const values = ['', 0, false, null, { answer: '你好' }, ['a', 'b']];
  const report = { results: values.map(output => ({ response: { output } })) };
  report.results.push({ response: { error: '连接失败' } }, { output: 'legacy output', provider: 'echo' });
  const { records } = extractOutputs(report);
  assert.deepEqual(records.slice(0, 4).map(r => r.output), ['', '0', 'false', 'null']);
  assert.ok(records.slice(0, values.length).every(r => r.hasOutput));
  assert.equal(records[4].output, JSON.stringify(values[4], null, 2));
  assert.equal(records[5].output, JSON.stringify(values[5], null, 2));
  assert.equal(records[6].hasOutput, false);
  assert.equal(records[6].error, '连接失败');
  assert.equal(records[7].output, 'legacy output');
  assert.throws(() => extractOutputs([report, report]), /单独/);
  assert.throws(() => extractOutputs({}), /未找到/);
});
