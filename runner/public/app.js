import { TargetState } from '/target-state.mjs';
import { TargetForm } from '/target-form.mjs';

const $ = (id) => document.getElementById(id);
const labels = { running: '运行中', stopping: '正在停止', completed: '执行完成', assertions_failed: '存在未通过断言', failed: '执行失败', cancelled: '已停止', pending: '等待执行', skipped: '未执行' };
let token, currentJob, ready = false, root = '', previewTimer, previewSequence = 0;
let previewCommand = '', sourceYaml = '';
const storageKey = 'promptfoo-runner-settings-v1';
const targets = new TargetState();
let personalTargets = [], fileTargetBase = '', loadSequence = 0, confirmingTargets = false;
let outputJobId = null, outputLoaded = false, outputRequestId = null;
const targetForm = new TargetForm($('target-cards'), () => { targets.touch(); updateControls(); }, notify);

function notify(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
async function api(url, data) {
  const response = await fetch(url, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Runner-Token': token }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
function settings() {
  return { config: $('config-path').value.trim(), output: $('output').value.trim(), repeats: Number($('repeats').value), concurrency: Number($('concurrency').value), delay: Number($('delay').value), noCache: true, noShare: true, overrideTargets: !!targets.confirmed, targetYaml: targets.confirmed?.targetYaml ?? '' };
}
function save() { const { overrideTargets, targetYaml, ...preferences } = settings(); try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch { /* Preferences are optional. */ } }
function busy() { return currentJob && ['running', 'stopping'].includes(currentJob.status); }
function updateControls() {
  $('config-fields').disabled = !!busy();
  $('start').disabled = !ready || !!busy() || !targets.canRun;
  $('start').textContent = busy() ? '评估正在运行…' : '▶  开始评估';
  $('stop').disabled = !busy() || currentJob.status === 'stopping';
  for (const id of ['restore-targets', 'personal-targets', 'add-target']) $(id).disabled = !targets.config || !!busy();
  $('confirm-targets').disabled = !targets.config || !!busy() || confirmingTargets;
  $('confirm-targets').textContent = confirmingTargets ? '正在校验…' : '确定目标配置';
  $('target-status').textContent = !targets.config ? '等待载入文件' : targets.canRun ? '已确认 · 用于运行' : '待确认';
  $('target-status').className = targets.canRun ? 'tag green' : 'tag';
  $('target-base').textContent = targets.config ? `相对路径基准：${targets.source === 'personal' ? `${root}/test_set` : fileTargetBase}` : '';
}
function shortPath(filename) { return filename.startsWith(`${root}/`) ? filename.slice(root.length + 1) : filename; }
function updateClock() {
  if (!currentJob) return;
  const elapsed = Math.max(0, Math.floor(((currentJob.finishedAt ? Date.parse(currentJob.finishedAt) : Date.now()) - Date.parse(currentJob.startedAt)) / 1000));
  $('elapsed').textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
}
function outputMessage(text) {
  const message = document.createElement('p'); message.className = 'results-empty'; message.textContent = text;
  $('test-outputs').replaceChildren(message);
}
async function loadOutputs(job) {
  if (outputJobId !== job.id) {
    outputJobId = job.id; outputLoaded = false;
    $('output-count').textContent = '0 条记录';
    $('output-eval').hidden = true;
    outputMessage('正在等待本次评估结果…');
  }
  const finished = !['running', 'stopping'].includes(job.status);
  if ((!finished && !job.runs.some(run => run.outputsReady)) || outputLoaded || outputRequestId === job.id) return;
  outputRequestId = job.id;
  try {
    const data = await api(`/api/jobs/${job.id}/outputs`);
    if (outputJobId !== job.id) return;
    outputLoaded = true;
    $('output-count').textContent = `${data.records.length} 条记录`;
    $('output-eval').hidden = !data.evalIds.length;
    $('output-eval').textContent = data.evalIds.join(' · ');
    $('test-outputs').replaceChildren();
    for (const record of data.records) {
      const card = document.createElement('article'); card.className = 'test-output-card';
      const heading = document.createElement('div'); heading.className = 'test-output-heading';
      const title = document.createElement('strong'); title.textContent = `测试记录 ${record.index}${record.description ? ` · ${record.description}` : ''}`;
      const status = document.createElement('span');
      status.className = `status ${record.error !== null || record.success === false ? 'failed' : record.success === true ? 'completed' : ''}`;
      status.textContent = record.error !== null ? '执行错误' : record.success === true ? '断言通过' : record.success === false ? '断言未通过' : '未提供断言结果';
      heading.append(title, status); card.append(heading);
      const meta = document.createElement('p'); meta.className = 'test-output-meta';
      meta.textContent = [record.provider, record.testIndex !== null ? `用例 ${record.testIndex + 1}` : '', record.latencyMs !== null ? `${Math.round(record.latencyMs)} ms` : ''].filter(Boolean).join(' · ');
      if (meta.textContent) card.append(meta);
      const output = document.createElement('pre'); output.className = 'test-output-text';
      // Provider output is untrusted text, never executable HTML or Markdown.
      output.textContent = record.hasOutput ? (record.output === '' ? '（output 为空字符串）' : record.output) : '这条记录没有 output 字段。';
      card.append(output);
      if (record.error !== null) {
        const error = document.createElement('pre'); error.className = 'test-output-error'; error.textContent = record.error; card.append(error);
      }
      $('test-outputs').append(card);
    }
    if (!data.records.length) outputMessage(data.errors.length ? data.errors.join('\n') : '本次评估没有生成可展示的测试输出，请查看运行日志。');
  } catch (error) {
    if (outputJobId !== job.id) return;
    outputLoaded = true;
    outputMessage(`读取本次输出失败：${error.message}`);
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button secondary output-retry'; retry.textContent = '重新读取';
    retry.addEventListener('click', () => { outputLoaded = false; void loadOutputs(currentJob); });
    $('test-outputs').append(retry);
  } finally { if (outputRequestId === job.id) outputRequestId = null; }
}
function renderJob(job) {
  currentJob = job;
  updateControls();
  $('status').textContent = labels[job.status];
  $('status').className = `status ${['failed', 'assertions_failed'].includes(job.status) ? 'failed' : busy() ? 'running' : job.status}`;
  $('round').replaceChildren(document.createTextNode(`${job.settings.repeats} `));
  const repeatUnit = document.createElement('span'); repeatUnit.textContent = '次'; $('round').append(repeatUnit);
  const completed = job.runs.filter(r => ['completed', 'assertions_failed'].includes(r.status)).length;
  $('completed').replaceChildren(document.createTextNode(`${completed} `));
  const unit = document.createElement('span'); unit.textContent = '次'; $('completed').append(unit);
  $('progress').max = 1;
  if (busy()) $('progress').removeAttribute('value'); else $('progress').value = completed;
  $('empty-state').hidden = true; $('logs').hidden = false;
  if ($('logs').textContent !== job.log) {
    $('logs').textContent = job.log || '正在启动本地进程…';
    if ($('autoscroll').checked) $('logs').scrollTop = $('logs').scrollHeight;
  }
  $('log-info').textContent = busy() ? '进程运行中 · 每秒更新' : `${labels[job.status]} · 日志保留最近 200 KB`;
  $('result-count').textContent = `${job.runs.filter(r => r.available).length} 个文件`;
  $('results').replaceChildren();
  for (const run of job.runs) {
    const row = document.createElement('div'); row.className = 'result-row';
    const info = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = shortPath(run.output);
    const caption = document.createElement('small'); caption.textContent = `--repeat ${job.settings.repeats} · ${labels[run.status]}${run.code !== null ? ` · 退出码 ${run.code}` : ''}`;
    info.append(name, caption); row.append(info);
    const action = document.createElement(run.available ? 'a' : 'span');
    action.textContent = run.available ? '下载结果 ↓' : labels[run.status];
    if (run.available) { action.href = `/api/jobs/${job.id}/results/${run.number}`; action.download = ''; }
    row.append(action); $('results').append(row);
  }
  void loadOutputs(job);
  updateClock();
}
async function refreshPreview() {
  const sequence = ++previewSequence;
  save();
  const value = settings();
  $('command-rounds').textContent = `单次评估 · --repeat ${value.repeats || '—'}`;
  if (!currentJob) { $('round').firstChild.textContent = `${value.repeats || '—'} `; }
  const filename = value.output.split('/').at(-1) || '结果文件';
  const policy = /\.json$/i.test(filename) ? '同名 JSON 按评估追加，已有结果会保留。' : /\.jsonl$/i.test(filename) ? '同名 JSONL 追加新记录。' : '同名旧报告先备份，再保存本次结果。';
  $('output-note').textContent = `全部重复测试的结果保存为 ${filename}。` + policy;
  try {
    const preview = await api('/api/preview', value);
    if (sequence !== previewSequence) return;
    previewCommand = preview.command;
    $('command').textContent = preview.command + (value.overrideTargets ? '\n\n# 使用已确认的目标配置，请通过「开始评估」运行。' : '\n\n# 请先确认目标配置。');
    $('copy').disabled = value.overrideTargets;
    $('copy').title = value.overrideTargets ? '已确认的目标由控制台应用，请通过「开始评估」运行' : '';
    $('yaml-caption').textContent = value.overrideTargets ? '查看已确认的执行配置' : '查看文件原始配置';
    const content = preview.effectiveYaml ?? sourceYaml;
    $('yaml-preview').textContent = content || '点击「载入」查看脚本内容';
    $('yaml-size').textContent = content ? `${content.split('\n').length} 行` : '';
  } catch (error) {
    if (sequence !== previewSequence) return;
    previewCommand = ''; $('command').textContent = error.message; $('copy').disabled = true;
    if (value.overrideTargets) { $('yaml-preview').textContent = error.message; $('yaml-size').textContent = ''; }
  }
}
function queuePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(refreshPreview, 220); }
function invalidateTargets() {
  targets.invalidate(); loadSequence++; previewSequence++;
  targetForm.render([]); updateControls();
}
async function loadConfig(activeJob = null) {
  invalidateTargets();
  const sequence = loadSequence;
  try {
    const config = await api(`/api/config?path=${encodeURIComponent($('config-path').value.trim())}`);
    if (sequence !== loadSequence) return;
    sourceYaml = config.content;
    fileTargetBase = config.targetBasePath;
    targets.load(config.path, config.targets);
    if (activeJob?.targets) {
      targets.fill(activeJob.targets, 'file');
      targets.confirm(targets.snapshot(activeJob.targets), { targetYaml: activeJob.settings.targetYaml });
    }
    targetForm.render(targets.draft);
    $('yaml-preview').textContent = config.content;
    $('yaml-size').textContent = `${config.content.split('\n').length} 行`;
    updateControls(); notify(); await refreshPreview();
  } catch (error) { if (sequence !== loadSequence) return; $('yaml-preview').textContent = '无法载入脚本'; $('yaml-size').textContent = ''; notify(error.message); }
}
function populateConfigs(configs) {
  $('config-select').replaceChildren(new Option('选择 YAML 文件', ''));
  for (const config of configs) $('config-select').add(new Option(config, config));
  $('config-select').value = $('config-path').value;
}
$('config-select').addEventListener('change', () => { if ($('config-select').value) { $('config-path').value = $('config-select').value; void loadConfig(); } });
$('config-path').addEventListener('input', () => { invalidateTargets(); sourceYaml = ''; $('config-select').value = $('config-path').value; $('yaml-preview').textContent = '路径已修改，点击「载入」查看内容'; $('yaml-size').textContent = ''; });
$('restore-targets').addEventListener('click', () => { targets.restore(); targetForm.render(targets.draft); updateControls(); notify(); });
$('personal-targets').addEventListener('click', () => { targets.fill(personalTargets, 'personal'); targetForm.render(targets.draft); updateControls(); notify(); });
$('add-target').addEventListener('click', () => {
  try { targets.fill([...targetForm.read(), { id: '', label: '', config: {} }], targets.source); targetForm.render(targets.draft); updateControls(); }
  catch (error) { notify(error.message); }
});
$('confirm-targets').addEventListener('click', async () => {
  let snapshot;
  try {
    snapshot = targets.snapshot(targetForm.read());
    confirmingTargets = true; updateControls(); notify();
    const result = await api('/api/targets/confirm', { config: snapshot.config, targets: snapshot.targets, source: snapshot.source });
    if (!targets.confirm(snapshot, result)) { notify('表单已修改，请重新点击「确定目标配置」。'); return; }
    await refreshPreview();
  } catch (error) { notify(error.message); }
  finally { confirmingTargets = false; updateControls(); }
});
$('load-config').addEventListener('click', () => void loadConfig());
$('form').addEventListener('input', event => { if (!event.target.closest('#target-editor')) queuePreview(); });
$('minus').addEventListener('click', () => { $('repeats').value = Math.max(1, Number($('repeats').value) - 1); void refreshPreview(); });
$('plus').addEventListener('click', () => { $('repeats').value = Math.min(1000, Number($('repeats').value) + 1); void refreshPreview(); });
$('upload-button').addEventListener('click', () => $('upload-file').click());
$('upload-file').addEventListener('change', async () => {
  const file = $('upload-file').files[0];
  if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('YAML 文件最大支持 2 MB');
    const result = await api('/api/upload', { filename: file.name, content: await file.text() });
    $('config-path').value = result.path;
    const bootstrap = await api('/api/bootstrap'); populateConfigs(bootstrap.configs);
    await loadConfig();
  } catch (error) { notify(error.message); }
  $('upload-file').value = '';
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(previewCommand); $('copy').textContent = '已复制 ✓'; setTimeout(() => { $('copy').textContent = '复制命令 ↗'; }, 1500); }
  catch { notify('复制失败，可直接选中命令文本复制。'); }
});
$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!targets.canRun) { notify('请先点击「确定目标配置」，再开始评估。'); return; }
  notify(); $('start').disabled = true;
  try { save(); renderJob(await api('/api/jobs', settings())); }
  catch (error) { notify(error.message); updateControls(); }
});
$('stop').addEventListener('click', async () => {
  $('stop').disabled = true;
  try { renderJob(await api(`/api/jobs/${currentJob.id}/stop`, {})); }
  catch (error) { notify(error.message); updateControls(); }
});
async function poll() {
  if (busy()) {
    try { renderJob(await api(`/api/jobs/${currentJob.id}`)); }
    catch (error) { notify(`无法更新任务状态：${error.message}。若服务已重启，请刷新页面。`); }
  }
  setTimeout(poll, 1000);
}
async function init() {
  try {
    const data = await api('/api/bootstrap');
    token = data.token; root = data.root; ready = !!data.runtime; personalTargets = data.personalTargets;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch { /* Use defaults. */ }
    const initial = { ...data.defaults, ...saved, ...(data.job && ['running', 'stopping'].includes(data.job.status) ? data.job.settings : {}) };
    for (const [id, key] of [['config-path', 'config'], ['output', 'output'], ['repeats', 'repeats'], ['concurrency', 'concurrency'], ['delay', 'delay']]) $(id).value = initial[key];
    populateConfigs(data.configs);
    $('root').textContent = root;
    $('runtime').textContent = ready ? `Promptfoo ${data.runtime.version.replace(/^\s*\d*\.?\s*promptfoo\s*/i, '')}` : '运行环境需要配置';
    $('runtime-sub').textContent = ready ? '环境就绪，可以开始评估' : '请查看下方提示';
    $('runtime-sub').title = data.runtime?.node || '';
    const activeJob = data.job && ['running', 'stopping'].includes(data.job.status) ? data.job : null;
    await loadConfig(activeJob);
    if (data.runtimeError) notify(data.runtimeError);
    if (data.job) renderJob(data.job); else updateControls();
    void poll(); setInterval(updateClock, 1000);
  } catch (error) { ready = false; updateControls(); notify(`无法连接本地服务：${error.message}`); }
}
void init();
