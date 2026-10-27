import path from 'node:path';
import os from 'node:os';
import { readFile, stat, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';

export const defaultTargetYaml = `targets:
  - id: file://../bambuProvider.js
    label: bambu
    config:
      baseUrl: "https://support.bambulab.cn"
      origin: "https://support.bambulab.cn"
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
`;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function readTargets(content) {
  const config = parse(content);
  if (!object(config)) throw new Error('测试脚本必须是完整的 YAML 配置对象');
  const entries = config.targets ?? config.providers ?? [];
  const targets = (Array.isArray(entries) ? entries : [entries]).map(entry => typeof entry === 'string' ? { id: entry } : entry);
  if (!targets.every(object)) throw new Error('targets / providers 必须包含目标对象或 provider 字符串');
  return targets;
}

export function targetBasePath(root, filename, content, source) {
  if (source === 'personal') return path.join(root, 'test_set');
  const config = parse(content);
  return path.resolve(path.dirname(filename), typeof config?.basePath === 'string' ? config.basePath : '.');
}

export async function confirmTargets(root, filename, targets, source) {
  if (!['file', 'personal'].includes(source)) throw new Error('目标配置来源无效，请重新载入文件');
  if (!Array.isArray(targets) || !targets.length || !targets.every(object)) throw new Error('至少需要一个有效的目标配置');
  const content = await readFile(filename, 'utf8');
  const basePath = targetBasePath(root, filename, content, source);
  const effectiveYaml = await overrideConfig(basePath, filename, stringify({ targets }));
  // Store resolved targets as a snapshot; later edits cannot change this result.
  return { targetYaml: stringify({ targets: readTargets(effectiveYaml) }), effectiveYaml, basePath };
}

export async function overrideConfig(root, filename, targetYaml) {
  if (typeof targetYaml !== 'string' || !targetYaml.trim() || Buffer.byteLength(targetYaml) > 100000) throw new Error('请填写目标配置 YAML（最大 100 KB）');
  let target;
  try { target = parse(targetYaml); } catch (error) { throw new Error(`目标配置 YAML 格式错误：${error.message}`); }
  if (object(target) && 'targets' in target && 'providers' in target) throw new Error('我的目标配置只需填写 targets 或 providers 其中一种');
  const entries = object(target) && ('targets' in target || 'providers' in target) ? (target.targets ?? target.providers) : target;
  const providers = [];
  for (const entry of Array.isArray(entries) ? entries : [entries]) {
    const provider = typeof entry === 'string' ? { id: entry } : entry;
    if (!object(provider) || typeof provider.id !== 'string' || !provider.id.trim()) throw new Error('每个目标都需要填写 id，例如 file://bambuProvider.js');
    if (provider.config !== undefined && !object(provider.config)) throw new Error('目标的 config 必须是 YAML 对象');
    let id = provider.id.trim();
    if (id.startsWith('file://')) {
      const input = id.slice(7);
      if (!input || input.includes('\0')) throw new Error('请填写有效的 provider 文件路径');
      const full = path.resolve(root, input.startsWith('~/') ? path.join(os.homedir(), input.slice(2)) : input);
      if (!(await stat(full).catch(() => null))?.isFile()) throw new Error(`找不到 provider 文件：${full}（相对路径基准：${root}）`);
      id = `file://${full}`;
    }
    providers.push({ ...provider, id });
  }
  if (!providers.length) throw new Error('我的目标配置至少需要一个目标');
  if ((await stat(filename)).size > 2 * 1024 * 1024) throw new Error('YAML 文件需小于 2 MB');
  let config;
  try { config = parse(await readFile(filename, 'utf8')); } catch (error) { throw new Error(`测试脚本 YAML 格式错误：${error.message}`); }
  if (!object(config)) throw new Error('测试脚本必须是完整的 YAML 配置对象');
  const key = 'targets' in config ? 'targets' : 'providers';
  delete config.targets;
  delete config.providers;
  config[key] = providers;
  return stringify(config);
}

export async function prepareConfig(root, settings) {
  if (!settings.overrideTargets) return { filename: settings.config, cleanup: async () => {} };
  const content = await overrideConfig(root, settings.config, settings.targetYaml);
  // A sibling file preserves relative prompts, test files, and other references.
  const filename = path.join(path.dirname(settings.config), `.runner-override-${randomUUID()}.yaml`);
  await writeFile(filename, content, { flag: 'wx', mode: 0o600 });
  return { filename, cleanup: () => unlink(filename) };
}
