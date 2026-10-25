const { test } = require('node:test');
const assert = require('node:assert/strict');
const U = require('../mute-import-utils.js');
test('OCR accepts standalone handles, deduplicates case, excludes bio mentions and truncated/invalid handles', () => {
  assert.deepEqual(U.extract('Muted accounts\n@Example\n＠second_2\n@example\nbio mentions @other\n@too_long_username_123\n@cut...\n@space name'), ['example', 'second_2']);
  assert.throws(() => U.parseReviewed('@ok\n<script>'));
  assert.throws(() => U.parseReviewed(''));
});
test('merge preserves existing records, unknown unseen mutes, separate source accounts, and never mutates input', () => {
  const original = [{ id:'1', x_account:'Example', note:'keep', tracking_mode:'record', works:[{url:'keep'}], x_user_id:'123', x_mute_observations:{another:{muted:true}} }, { id:'2', x_account:'Unseen', x_muted:true }];
  const snapshot = JSON.stringify(original);
  const result = U.merge(original, U.parseReviewed('@example\n@NewUser\n@newuser'), '@Owner', '2026-10-25T00:00:00Z', () => 'new-id');
  assert.equal(result.added,1); assert.equal(result.updated,1);
  assert.equal(JSON.stringify(original),snapshot);
  assert.equal(result.artists[0].note,'keep'); assert.equal(result.artists[0].x_user_id,'123');
  assert.equal(result.artists[0].x_mute_observations.another.muted,true);
  assert.equal(result.artists[0].x_mute_observations.owner.source,'screenshot_reviewed');
  assert.equal(result.artists[1].x_muted,true);
  assert.equal(result.artists[2].tracking_mode,'monitor_only');
  assert.equal(result.artists[2].x_user_id,undefined);
  assert.equal(U.merge(result.artists,['NEWUSER'],'Owner','2026-10-26T00:00:00Z',()=>assert.fail()).added,0);
});
test('a valid source named __proto__ is stored as an ordinary account key', () => {
  const result = U.merge([], ['Example'], '__proto__', '2026-10-25T00:00:00Z', () => 'id');
  assert.equal(JSON.parse(JSON.stringify(result.artists))[0].x_mute_observations.__proto__.muted, true);
});
