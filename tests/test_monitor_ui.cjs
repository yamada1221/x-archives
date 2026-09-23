const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync('index.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script);
function section(start, end) {
  return script.slice(script.indexOf(start), script.indexOf(end, script.indexOf(start)));
}
const context = {};
vm.runInNewContext(
  section('function esc(', 'function detectUrlType(') +
  section('function latestMonitorResult(', 'function modeBadge(') +
  section('function resetMonitoringForAccountEdit(', 'async function saveArtist('), context,
);

test('one negative observation is only a suspicion; three confirmed observations show suspension', () => {
  const artist = { monitoring: { status: 'active', last_result: 'unavailable', last_reason: 'suspended' } };
  assert.match(context.monitorBadge(artist), /凍結の疑い/);
  Object.assign(artist.monitoring, { status: 'unavailable', confirmed_reason: 'suspended' });
  assert.match(context.monitorBadge(artist), />X 凍結</);
  artist.monitoring.last_result = 'unknown';
  assert.match(context.monitorBadge(artist), /判定不能/);
});

test('a different last negative reason does not inherit a previous confirmation', () => {
  const artist = { monitoring: { status: 'unavailable', last_result: 'unavailable', last_reason: 'suspended', confirmed_reason: 'not_found' } };
  assert.match(context.monitorBadge(artist), /凍結の疑い/);
});

test('missing account is not described as definitely deleted', () => {
  const artist = { monitoring: { status: 'unavailable', last_result: 'unavailable', last_reason: 'not_found', confirmed_reason: 'not_found' } };
  assert.match(context.monitorBadge(artist), /見つからない/);
  assert.doesNotMatch(context.monitorBadge(artist), /削除/);
});

test('protected and renamed users remain present', () => {
  const artist = { x_account: 'old', monitoring: { last_result: 'active', protected: true, observed_username: 'old' } };
  assert.match(context.monitorBadge(artist), /非公開・存在確認/);
  artist.monitoring.observed_username = 'new';
  assert.match(context.monitorBadge(artist), /ユーザー名変更/);
  assert.match(context.monitorBadge(artist), /@new/);
});

test('editing to an unrelated account releases the old identity but keeps an audit entry', () => {
  const artist = { x_account: 'old', x_user_id: '123', monitoring: { status: 'active', observed_username: 'renamed' } };
  context.resetMonitoringForAccountEdit(artist, 'different');
  assert.equal(artist.x_user_id, undefined);
  assert.equal(artist.monitoring, undefined);
  assert.match(artist.status_history[0].reason, /@old から @different/);
});

test('case changes and adopting an observed rename preserve the stable identity', () => {
  const artist = { x_account: 'old', x_user_id: '123', monitoring: { observed_username: 'renamed' } };
  context.resetMonitoringForAccountEdit(artist, 'OLD');
  assert.equal(artist.x_user_id, '123');
  context.resetMonitoringForAccountEdit(artist, 'RENAMED');
  assert.equal(artist.x_user_id, '123');
});
