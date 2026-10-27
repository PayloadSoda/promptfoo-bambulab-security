import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { defaults, validate, argumentsFor, commandFor, listConfigs, findRuntime, readConfig } from './core.mjs';
import { configuredOrigin, allowsRequest } from './access.mjs';
import { saveOutput } from './output.mjs';
import { prepareConfig, confirmTargets, readTargets, defaultTargetYaml } from './targets.mjs';
import { extractOutputs } from './results.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const token = randomUUID();
const publicOrigin = configuredOrigin(process.env.RUNNER_ORIGIN);
const jobs = new Map();
let active = null;
let runtime;
let runtimeError;
try { runtime = await findRuntime(root); } catch (error) { runtimeError = error.message; }

function log(job, value) {
  job.log = (job.log + value.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).slice(-200000);
}

function stop(job) {
  if (job.finishedAt || job.cancelled) return;
  job.cancelled = true;
  job.status = 'stopping';
  log(job, '\n正在停止任务…\n');
  const child = job.child;
  if (child) {
    const kill = (signal) => {
      try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
    };
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 3000);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  }
}

async function execute(job) {
  let stagingDirectory;
  let prepared;
  try {
    prepared = await prepareConfig(root, job.settings);
    const executionSettings = { ...job.settings, config: prepared.filename };
    for (const run of job.runs) {
      if (job.cancelled) break;
      await mkdir(path.dirname(run.output), { recursive: true });
      stagingDirectory = await mkdtemp(path.join(path.dirname(run.output), '.promptfoo-run-'));
      const stagedOutput = path.join(stagingDirectory, path.basename(run.output));
      const reportOutput = path.extname(stagedOutput).toLowerCase() === '.json' ? stagedOutput : path.join(stagingDirectory, '.runner-report.json');
      if (job.cancelled) { run.status = 'cancelled'; break; }
      run.status = 'running';
      job.current = run.number;
      if (job.settings.overrideTargets) log(job, '已使用确认后的 targets/providers；原始 YAML 保持不变。\n');
      log(job, `\n━━ 开始评估（--repeat ${job.settings.repeats}）━━\n${commandFor(executionSettings, run.output)}\n\n`);
      const result = await new Promise((resolve) => {
        const args = argumentsFor(executionSettings, stagedOutput);
        if (reportOutput !== stagedOutput) args.push(reportOutput);
        const child = spawn(runtime.node, [runtime.bin, ...args], {
          cwd: root, detached: true, shell: false,
          env: { ...process.env, PATH: `${path.dirname(runtime.node)}${path.delimiter}${process.env.PATH || ''}`, FORCE_COLOR: '0', NO_COLOR: '1', PROMPTFOO_DISABLE_TELEMETRY: '1', PROMPTFOO_DISABLE_UPDATE: '1', PROMPTFOO_FAILED_TEST_EXIT_CODE: '100' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        job.child = child;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => log(job, chunk));
        child.stderr.on('data', chunk => log(job, chunk));
        child.on('error', error => log(job, `\n启动失败：${error.message}\n`));
        child.on('close', (code, signal) => resolve({ code, signal }));
      });
      job.child = null;
      run.code = result.code;
      if (((await stat(reportOutput).catch(() => null))?.size || 0) > 0) {
        try {
          // Capture this invocation before appending to a file containing history.
          run.outputPreview = extractOutputs(JSON.parse(await readFile(reportOutput, 'utf8')));
          run.outputsReady = true;
        } catch (error) {
          run.outputPreviewError = `无法提取本次测试输出：${error.message}`;
          log(job, `\n${run.outputPreviewError}\n`);
        }
      }
      if (((await stat(stagedOutput).catch(() => null))?.size || 0) > 0) {
        try {
          const saved = await saveOutput(stagedOutput, run.output);
          run.available = true;
          log(job, `\n${saved.appended ? '已追加结果到' : '结果已保存到'}：${run.output}\n`);
          if (saved.backup) log(job, `旧报告已保留：${saved.backup}\n`);
        } catch (error) {
          // Keep the fresh export as well as the original if merging fails.
          log(job, `新结果保留在：${stagedOutput}\n`);
          stagingDirectory = null;
          throw new Error(`保存结果失败，原文件未改动：${error.message}`);
        }
      }
      await rm(stagingDirectory, { recursive: true, force: true });
      stagingDirectory = null;
      // promptfoo uses 100 for completed evaluations with failing assertions.
      run.status = job.cancelled ? 'cancelled' : result.code === 0 ? (run.available ? 'completed' : 'failed') : result.code === 100 && run.available ? 'assertions_failed' : 'failed';
      log(job, `\n评估结束，退出码：${result.code ?? result.signal}\n`);
      if (run.status === 'failed') break;
    }
    job.status = job.cancelled ? 'cancelled' : job.runs.some(r => r.status === 'failed') ? 'failed' : job.runs.some(r => r.status === 'assertions_failed') ? 'assertions_failed' : 'completed';
  } catch (error) {
    log(job, `\n执行失败：${error.message}\n`);
    job.status = job.cancelled ? 'cancelled' : 'failed';
    const current = job.runs.find(r => r.status === 'running');
    if (current) current.status = job.status;
  } finally {
    if (prepared) await prepared.cleanup().catch(error => log(job, `临时 YAML 清理失败：${error.message}\n`));
    if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    for (const run of job.runs) if (run.status === 'pending') run.status = 'skipped';
    job.finishedAt = new Date().toISOString();
    active = null;
  }
}

function serialize(job) {
  const { child, ...data } = job;
  const runs = job.runs.map(({ outputPreview, ...run }) => run);
  return { ...data, runs, targets: job.settings.overrideTargets ? readTargets(job.settings.targetYaml) : null };
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 3 * 1024 * 1024) throw new Error('文件过大，最大支持 2 MB YAML');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const port = server.address().port;
  if (!allowsRequest(req.headers, publicOrigin)) return json(res, 403, { error: `访问地址未被允许。请打开 http://127.0.0.1:${port}；使用自定义域名或反向代理时，请设置 RUNNER_ORIGIN 为浏览器中的站点地址并重启服务。` });
  if (req.method === 'POST' && req.headers['x-runner-token'] !== token) return json(res, 403, { error: '页面已过期，请刷新后重试' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/bootstrap') return json(res, 200, { root, defaults, personalTargets: readTargets(defaultTargetYaml), token, runtime: runtime ? { version: runtime.version, node: runtime.node } : null, runtimeError, configs: await listConfigs(root), job: active ? serialize(active) : jobs.size ? serialize([...jobs.values()].at(-1)) : null });
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, await readConfig(root, url.searchParams.get('path')));
    if (req.method === 'POST' && url.pathname === '/api/targets/confirm') {
      const input = await body(req);
      const config = await readConfig(root, input.config);
      return json(res, 200, await confirmTargets(root, config.path, input.targets, input.source));
    }
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const { filename, content } = await body(req);
      if (typeof filename !== 'string' || !/\.ya?ml$/i.test(filename) || typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('请载入不超过 2 MB 的 YAML 文件');
      const name = path.basename(filename).replace(/[^\p{L}\p{N}._-]/gu, '_');
      const relative = `test_set/upload-${randomUUID().slice(0, 8)}-${name}`;
      await mkdir(path.join(root, 'test_set'), { recursive: true });
      await writeFile(path.join(root, relative), content, { flag: 'wx', mode: 0o600 });
      return json(res, 201, { path: relative, content });
    }
    if (req.method === 'POST' && url.pathname === '/api/preview') return json(res, 200, await validate(root, await body(req)));
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      if (active) return json(res, 409, { error: '已有任务正在运行，请等待完成或停止当前任务' });
      if (!runtime) throw new Error(runtimeError);
      const { settings, outputs } = await validate(root, await body(req));
      // Check again after asynchronous validation to avoid two simultaneous starts.
      if (active) return json(res, 409, { error: '已有任务正在运行' });
      const job = { id: randomUUID(), settings, status: 'running', current: 0, startedAt: new Date().toISOString(), finishedAt: null, cancelled: false, log: '', runs: outputs.map((output, i) => ({ number: i + 1, output, status: 'pending', available: false, code: null })) };
      active = job;
      jobs.set(job.id, job);
      if (jobs.size > 20) jobs.delete(jobs.keys().next().value);
      void execute(job);
      return json(res, 201, serialize(job));
    }
    const match = url.pathname.match(/^\/api\/jobs\/([\w-]+)(?:\/(stop|results|outputs)(?:\/(\d+))?)?$/);
    if (match) {
      const job = jobs.get(match[1]);
      if (!job) return json(res, 404, { error: '任务不存在，服务重启后任务记录会清空' });
      if (req.method === 'POST' && match[2] === 'stop') { stop(job); return json(res, 200, serialize(job)); }
      if (req.method === 'GET' && !match[2]) return json(res, 200, serialize(job));
      if (req.method === 'GET' && match[2] === 'outputs') return json(res, 200, {
        jobId: job.id,
        evalIds: job.runs.map(run => run.outputPreview?.evalId).filter(Boolean),
        records: job.runs.flatMap(run => run.outputPreview?.records ?? []),
        errors: job.runs.map(run => run.outputPreviewError).filter(Boolean),
      });
      if (req.method === 'GET' && match[2] === 'results') {
        const run = job.runs[Number(match[3]) - 1];
        if (!run?.available) return json(res, 404, { error: '本次评估尚未生成结果' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(run.output))}` });
        return res.end(await readFile(run.output));
      }
    }
    const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/target-state.mjs': ['target-state.mjs', 'text/javascript; charset=utf-8'], '/target-form.mjs': ['target-form.mjs', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
    if (req.method === 'GET' && files[url.pathname]) {
      const [file, type] = files[url.pathname];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      return res.end(await readFile(path.join(publicDir, file)));
    }
    json(res, 404, { error: '未找到此页面' });
  } catch (error) {
    if (!res.headersSent) json(res, 400, { error: error.message });
    else res.end();
  }
});

server.listen(Number(process.env.PORT || 4310), '127.0.0.1', () => {
  console.log(`Promptfoo 控制台：http://127.0.0.1:${server.address().port}`);
  if (publicOrigin) console.log(`已配置访问地址：${publicOrigin}`);
  console.log(runtime ? `已就绪：${runtime.version} · ${runtime.node}` : `环境提示：${runtimeError}`);
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (active) stop(active);
  server.close();
  setTimeout(() => process.exit(0), 3500).unref();
});
