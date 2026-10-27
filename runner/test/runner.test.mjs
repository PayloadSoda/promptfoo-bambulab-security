import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { defaults, validate, argumentsFor, findRuntime } from '../core.mjs';
import { parse, stringify } from 'yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('output validation accepts existing files while protecting the config', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'runner-unit-'));
  try {
    const config = path.join(temporary, '含 空格.yaml');
    await writeFile(config, 'prompts: [hello]');
    const plan = await validate(temporary, { ...defaults, config, output: '结果 file.json', repeats: 3 });
    assert.equal(plan.settings.config, config);
    assert.deepEqual(plan.outputs, [path.join(temporary, '结果 file.json')]);
    assert.deepEqual(argumentsFor(plan.settings, plan.outputs[0]), ['eval', '-c', config, '--no-cache', '--max-concurrency', '1', '--delay', '1000', '--no-share', '--repeat', '3', '-o', path.join(temporary, '结果 file.json')]);
    assert.match(plan.command, /--repeat 3/);
    await writeFile(plan.outputs[0], 'existing');
    assert.equal((await validate(temporary, { config, output: '结果 file.json' })).outputs[0], plan.outputs[0]);
    await assert.rejects(validate(temporary, { config, repeats: 0 }), /整数/);
    await assert.rejects(validate(temporary, { config, delay: -1 }), /整数/);
    await assert.rejects(validate(temporary, { config, concurrency: 1.5 }), /整数/);
    await assert.rejects(validate(temporary, { config, noCache: 'false' }), /布尔/);
    await assert.rejects(validate(temporary, { config: 'missing.yaml' }), /找不到/);
    await assert.rejects(validate(temporary, { config, output: config }), /覆盖 YAML/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('HTTP runner executes repeats, streams logs, handles errors and cancellation', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'runner-integration-'));
  const runtime = await findRuntime(root);
  const mock = path.join(temporary, 'mock-cli.mjs');
  await writeFile(mock, `import {readFile,writeFile} from 'node:fs/promises';
const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('test-cli');process.exit(0)}
const config=await readFile(args[args.indexOf('-c')+1],'utf8');
console.log('mock started');
await new Promise(r=>setTimeout(r,config.includes('slow')?10000:150));
if(config.includes('error')){console.error('intentional failure');process.exit(2)}
const report={args,config,evalId:'mock-'+process.pid,results:{results:Array.from({length:Number(args[args.indexOf('--repeat')+1])},(_,i)=>({testIdx:0,provider:{label:'mock-provider'},success:!config.includes('assertion'),response:{output:'output '+i+' from '+process.pid}}))}};
for(const output of args.slice(args.indexOf('-o')+1))await writeFile(output,JSON.stringify(report));
console.log('mock finished');process.exit(config.includes('assertion')?100:0);
`);
  const server = spawn(process.execPath, ['runner/server.mjs'], { cwd: root, env: { ...process.env, PORT: '0', PROMPTFOO_NODE: runtime.node, PROMPTFOO_BIN: mock }, stdio: ['ignore', 'pipe', 'pipe'] });
  let startup = '';
  server.stdout.on('data', data => { startup += data; });
  server.stderr.on('data', data => { startup += data; });
  try {
    for (let i = 0; i < 150 && !startup.match(/http:\/\/127\.0\.0\.1:\d+/); i++) await pause(40);
    const base = startup.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    assert.ok(base, startup);
    const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
    const request = async (url, data, extra = {}) => {
      const response = await fetch(`${base}${url}`, data === undefined ? extra : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Runner-Token': bootstrap.token, ...extra.headers }, body: JSON.stringify(data) });
      return { status: response.status, data: await response.json() };
    };
    const untilDone = async id => {
      for (let i = 0; i < 200; i++) {
        const result = await request(`/api/jobs/${id}`);
        if (!['running', 'stopping'].includes(result.data.status)) return result.data;
        await pause(30);
      }
      throw new Error('Job timed out');
    };
    const create = async (name, marker, repeats = 1, extension = 'json') => {
      const config = path.join(temporary, `${name}.yaml`);
      await writeFile(config, marker);
      return request('/api/jobs', { ...defaults, config, output: path.join(temporary, 'nested', `${name}.${extension}`), repeats });
    };
    await t.test('origin and token protection', async () => {
      assert.equal((await request('/api/jobs', {}, { headers: { 'X-Runner-Token': 'wrong' } })).status, 403);
      assert.equal((await request('/api/preview', {}, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
      const status = await new Promise((resolve, reject) => {
        http.get(`${base}/`, { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
      });
      assert.equal(status, 403);
    });
    await t.test('repeat is passed to one process with one output; new submissions append', async () => {
      const started = await create('normal', 'normal', 2);
      assert.equal(started.status, 201);
      assert.equal((await create('concurrent', 'normal')).status, 409);
      const job = await untilDone(started.data.id);
      assert.equal(job.status, 'completed');
      assert.equal(job.runs.length, 1);
      assert.equal(job.runs[0].output, path.join(temporary, 'nested', 'normal.json'));
      assert.equal(job.log.match(/mock started/g)?.length, 1);
      assert.match(job.log, /mock finished/);
      const firstOutputs = await request(`/api/jobs/${job.id}/outputs`);
      assert.equal(firstOutputs.status, 200);
      assert.equal(firstOutputs.data.records.length, 2);
      assert.equal(job.runs[0].outputsReady, true);
      assert.equal(Object.hasOwn(job.runs[0], 'outputPreview'), false);
      for (const run of job.runs) {
        assert.equal(run.status, 'completed');
        const result = JSON.parse(await readFile(run.output, 'utf8'));
        assert.ok(result.args.includes('--no-cache'));
        assert.ok(result.args.includes('--no-share'));
        assert.equal(result.args[result.args.indexOf('--delay') + 1], '1000');
        assert.equal(result.args[result.args.indexOf('--repeat') + 1], '2');
        assert.equal((await fetch(`${base}/api/jobs/${job.id}/results/${run.number}`)).status, 200);
      }
      const repeated = await create('normal', 'normal', 2);
      assert.equal(repeated.status, 201);
      const repeatedJob = await untilDone(repeated.data.id);
      assert.equal(repeatedJob.status, 'completed');
      const secondOutputs = await request(`/api/jobs/${repeatedJob.id}/outputs`);
      assert.equal(secondOutputs.data.records.length, 2);
      assert.notDeepEqual(secondOutputs.data.evalIds, firstOutputs.data.evalIds);
      assert.notEqual(secondOutputs.data.records[0].output, firstOutputs.data.records[0].output);
      assert.deepEqual((await request(`/api/jobs/${job.id}/outputs`)).data, firstOutputs.data);
      for (const run of repeatedJob.runs) {
        const history = JSON.parse(await readFile(run.output, 'utf8'));
        assert.equal(history.length, 2);
        assert.ok(history.every(result => result.args.includes('--no-cache')));
      }
      const before = await readFile(job.runs[0].output, 'utf8');
      const failure = await create('normal', 'error', 2);
      assert.equal((await untilDone(failure.data.id)).status, 'failed');
      assert.equal(await readFile(job.runs[0].output, 'utf8'), before);
      assert.deepEqual((await request(`/api/jobs/${failure.data.id}/outputs`)).data.records, []);
    });
    await t.test('non-JSON export still gets current outputs from the same CLI invocation', async () => {
      const started = await create('csv-export', 'normal', 2, 'csv');
      const job = await untilDone(started.data.id);
      assert.equal(job.status, 'completed');
      assert.equal(job.log.match(/mock started/g)?.length, 1);
      const outputs = await request(`/api/jobs/${job.id}/outputs`);
      assert.equal(outputs.data.records.length, 2);
      const report = JSON.parse(await readFile(job.runs[0].output, 'utf8'));
      const paths = report.args.slice(report.args.indexOf('-o') + 1);
      assert.equal(paths.length, 2);
      assert.match(paths[0], /\.csv$/);
      assert.match(paths[1], /\.runner-report\.json$/);
    });
    await t.test('assertion failures finish the single evaluation with its report', async () => {
      const started = await create('assertion', 'assertion', 2);
      const job = await untilDone(started.data.id);
      assert.equal(job.status, 'assertions_failed');
      assert.equal(job.runs.length, 1);
      assert.equal(job.log.match(/mock started/g)?.length, 1);
      assert.ok(job.runs.every(run => run.code === 100 && run.available));
    });
    await t.test('runtime failure does not retry the evaluation', async () => {
      const started = await create('error', 'error', 2);
      const job = await untilDone(started.data.id);
      assert.equal(job.status, 'failed');
      assert.equal(job.runs.length, 1);
      assert.equal(job.log.match(/mock started/g)?.length, 1);
      assert.equal(job.runs[0].available, false);
    });
    await t.test('cancel stops the single repeat-enabled process', async () => {
      const started = await create('slow', 'slow', 3);
      await pause(100);
      assert.equal((await request(`/api/jobs/${started.data.id}/stop`, {})).status, 200);
      const job = await untilDone(started.data.id);
      assert.equal(job.status, 'cancelled');
      assert.equal(job.runs.length, 1);
      assert.equal(job.runs[0].status, 'cancelled');
    });
    await t.test('YAML upload and preview', async () => {
      const uploaded = await request('/api/upload', { filename: 'test.yaml', content: 'prompts: [你好，世界]' });
      assert.equal(uploaded.status, 201);
      try {
        const config = await request(`/api/config?path=${encodeURIComponent(uploaded.data.path)}`);
        assert.equal(config.data.content, 'prompts: [你好，世界]');
      } finally { await rm(path.join(root, uploaded.data.path)); }
    });
    await t.test('target override reaches the CLI and cleans up without changing the source', async () => {
      const config = path.join(temporary, 'foreign.yaml');
      const provider = path.join(temporary, 'mine.cjs');
      await writeFile(provider, 'module.exports = class {};');
      const original = 'targets:\n  - id: file://missing.js\nprompts: [hello]\ntests: []\n';
      await writeFile(config, original);
      const input = { ...defaults, config, output: path.join(temporary, 'overridden.json'), overrideTargets: true, targetYaml: stringify({ targets: [{ id: `file://${provider}`, label: 'mine', config: { marker: 'my-setting' } }] }) };
      const loaded = await request(`/api/config?path=${encodeURIComponent(config)}`);
      assert.equal(loaded.status, 200);
      assert.equal(loaded.data.targets[0].id, 'file://missing.js');
      const confirmed = await request('/api/targets/confirm', { config, source: 'file', targets: [{ id: 'file://mine.cjs', label: 'confirmed-label', config: { marker: 'my-setting', retries: 3, enabled: false } }] });
      assert.equal(confirmed.status, 200);
      input.targetYaml = confirmed.data.targetYaml;
      const preview = await request('/api/preview', input);
      assert.equal(preview.status, 200);
      assert.equal(parse(preview.data.effectiveYaml).targets[0].id, `file://${provider}`);
      const started = await request('/api/jobs', input);
      assert.equal(started.status, 201);
      const job = await untilDone(started.data.id);
      assert.equal(job.status, 'completed', job.log);
      const report = JSON.parse(await readFile(input.output, 'utf8'));
      assert.equal(parse(report.config).targets[0].config.marker, 'my-setting');
      assert.equal(parse(report.config).targets[0].label, 'confirmed-label');
      assert.equal(parse(report.config).targets[0].config.retries, 3);
      assert.equal(parse(report.config).targets[0].config.enabled, false);
      assert.deepEqual(parse(report.config).prompts, ['hello']);
      const temporaryConfig = report.args[report.args.indexOf('-c') + 1];
      assert.equal(path.dirname(temporaryConfig), path.dirname(config));
      await assert.rejects(stat(temporaryConfig), { code: 'ENOENT' });
      assert.equal(await readFile(config, 'utf8'), original);
    });
  } finally {
    server.kill('SIGTERM');
    await once(server, 'exit');
    await rm(temporary, { recursive: true, force: true });
  }
});
