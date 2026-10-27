import test from 'node:test';
import assert from 'node:assert/strict';
import { TargetState } from '../public/target-state.mjs';

test('load, edit, personal preset and restore stay drafts until confirmation', () => {
  const state = new TargetState();
  const fileTargets = [{ id: 'echo', label: 'file', config: { retries: 2, enabled: true, headers: { 'X-Test': 'original' } } }];
  const mine = [{ id: 'file://../bambuProvider.js', label: 'bambu' }];
  state.load('/test/a.yaml', fileTargets);
  assert.deepEqual(state.draft, fileTargets);
  assert.equal(state.canRun, false);
  assert.equal(state.confirmed, null);
  const first = state.snapshot(state.draft);
  assert.equal(state.confirm(first, { targetYaml: 'file snapshot' }), true);
  assert.equal(state.canRun, true);
  state.draft[0].config.headers['X-Test'] = 'edited';
  state.touch();
  assert.equal(state.canRun, false);
  assert.equal(state.confirmed.targetYaml, 'file snapshot');
  assert.equal(state.fileTargets[0].config.headers['X-Test'], 'original');
  state.fill(mine, 'personal');
  assert.equal(state.confirmed.targetYaml, 'file snapshot');
  assert.equal(state.canRun, false);
  assert.equal(state.confirm(state.snapshot(state.draft), { targetYaml: 'personal snapshot' }), true);
  state.restore();
  assert.deepEqual(state.draft, fileTargets);
  assert.equal(state.source, 'file');
  assert.equal(state.confirmed.targetYaml, 'personal snapshot');
  assert.equal(state.canRun, false);
  state.confirm(state.snapshot(state.draft), { targetYaml: 'restored file snapshot' });
  assert.equal(state.canRun, true);
  state.load('/test/b.yaml', [{ id: 'echo', label: 'another file' }]);
  assert.equal(state.canRun, false);
  assert.equal(state.confirmed, null);
  assert.equal(state.draft[0].label, 'another file');
});

test('late confirmations cannot apply after an edit or file switch', () => {
  const state = new TargetState();
  state.load('/test/a.yaml', [{ id: 'echo' }]);
  const pending = state.snapshot(state.draft);
  state.touch();
  assert.equal(state.confirm(pending, { targetYaml: 'stale' }), false);
  const another = state.snapshot(state.draft);
  state.load('/test/b.yaml', [{ id: 'echo' }]);
  assert.equal(state.confirm(another, { targetYaml: 'wrong file' }), false);
  assert.equal(state.confirmed, null);
});
