import { access, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultTargetYaml, overrideConfig, readTargets, targetBasePath } from './targets.mjs';

const exec = promisify(execFile);
export const defaults = { config: 'test_set/extraction.yaml', output: 'results/input-tests.json', repeats: 1, concurrency: 1, delay: 1000, noCache: true, noShare: true, overrideTargets: false, targetYaml: defaultTargetYaml };

export function absolute(root, value) {
  return path.resolve(root, value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
}

export function argumentsFor(settings, output) {
  return ['eval', '-c', settings.config, ...(settings.noCache ? ['--no-cache'] : []), '--max-concurrency', String(settings.concurrency), '--delay', String(settings.delay), ...(settings.noShare ? ['--no-share'] : []), '--repeat', String(settings.repeats), '-o', output];
}

export function commandFor(settings, output) {
  const quote = (v) => /^[\w./:=\-]+$/.test(v) ? v : `'${v.replaceAll("'", "'\\''")}'`;
  return ['promptfoo', ...argumentsFor(settings, output)].map(quote).join(' ');
}

export async function validate(root, input) {
  const settings = { ...defaults, ...input };
  for (const [key, max] of [['repeats', 1000], ['concurrency', 100], ['delay', 3600000]]) {
    if (!Number.isInteger(settings[key]) || settings[key] < (key === 'delay' ? 0 : 1) || settings[key] > max) throw new Error(`${key} 必须是 ${key === 'delay' ? 0 : 1}–${max} 的整数`);
  }
  for (const key of ['noCache', 'noShare', 'overrideTargets']) if (typeof settings[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
  for (const key of ['config', 'output']) if (typeof settings[key] !== 'string' || !settings[key].trim() || settings[key].includes('\0')) throw new Error(`请填写有效的 ${key} 路径`);
  settings.config = absolute(root, settings.config.trim());
  settings.output = absolute(root, settings.output.trim());
  if (!/\.ya?ml$/i.test(settings.config)) throw new Error('请选择 .yaml 或 .yml 脚本');
  if (!(await stat(settings.config).catch(() => null))?.isFile()) throw new Error('找不到 YAML 文件，请检查脚本路径');
  if (!/\.(json|jsonl|csv|html|txt|xml|yaml|yml)$/i.test(settings.output)) throw new Error('结果路径需要包含文件名和扩展名，例如 results/input-tests.json');
  const outputs = [settings.output];
  if (outputs.includes(settings.config)) throw new Error('结果不能覆盖 YAML 脚本');
  const configRealPath = await realpath(settings.config);
  for (const output of outputs) {
    const info = await stat(output).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (info && !info.isFile()) throw new Error(`结果路径不是文件：${output}`);
    if (info && await realpath(output) === configRealPath) throw new Error('结果不能覆盖 YAML 脚本');
  }
  const effectiveYaml = settings.overrideTargets ? await overrideConfig(root, settings.config, settings.targetYaml) : null;
  return { settings, outputs, command: commandFor(settings, outputs[0]), effectiveYaml };
}

export async function listConfigs(root, directory = root) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'results', 'runner'].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await listConfigs(root, full));
    else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) found.push(path.relative(root, full));
  }
  return found.sort();
}

export async function findRuntime(root) {
  const nvmRoot = path.join(os.homedir(), '.nvm/versions/node');
  const versions = (await readdir(nvmRoot).catch(() => [])).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const nodes = process.env.PROMPTFOO_NODE ? [process.env.PROMPTFOO_NODE] : [process.execPath, ...versions.map(v => path.join(nvmRoot, v, 'bin/node'))];
  let node;
  for (const candidate of [...new Set(nodes)]) {
    try {
      const { stdout } = await exec(candidate, ['--version']);
      const [major, minor] = stdout.trim().slice(1).split('.').map(Number);
      if (major > 22 || (major === 22 && minor >= 22)) { node = candidate; break; }
    } catch { /* Try the next installed runtime. */ }
  }
  if (!node) throw new Error('需要 Node.js 22.22 或更新版本。也可用 PROMPTFOO_NODE 指定 node 路径。');
  const bins = process.env.PROMPTFOO_BIN ? [absolute(root, process.env.PROMPTFOO_BIN)] : [path.join(root, 'node_modules/.bin/promptfoo'), ...(process.env.PATH || '').split(path.delimiter).map(p => path.join(p, 'promptfoo')), ...versions.map(v => path.join(nvmRoot, v, 'bin/promptfoo'))];
  let bin;
  for (const candidate of bins) {
    try { await access(candidate); bin = await realpath(candidate); break; } catch { /* Try next location. */ }
  }
  if (!bin) throw new Error('未找到 promptfoo，请先安装，或用 PROMPTFOO_BIN 指定入口文件。');
  const { stdout } = await exec(node, [bin, '--version'], { cwd: root, timeout: 15000 });
  return { node, bin, version: stdout.trim().split('\n').at(-1) };
}

export async function readConfig(root, input) {
  if (typeof input !== 'string' || !/\.ya?ml$/i.test(input)) throw new Error('请选择 YAML 文件');
  const filename = absolute(root, input);
  const info = await stat(filename);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('YAML 文件需小于 2 MB');
  const content = await readFile(filename, 'utf8');
  return { path: filename, content, targets: readTargets(content), targetBasePath: targetBasePath(root, filename, content, 'file') };
}
