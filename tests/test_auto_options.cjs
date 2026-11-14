const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright');
const base = path.join(__dirname, '../extensions/mute-screen-capture');
let browser;
before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) }); });
after(async () => { if (browser) await browser.close(); });
async function screen(run) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    const html = fs.readFileSync(path.join(base, 'auto-options.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
    await page.setContent(html);
    await page.evaluate(() => {
      globalThis.fixtureStatus = { ok: true, configured: true, provider: 'archive.today', enabled: false, ready: false, jobs: [{ job_id: 'one', handle: 'X', label: '手動確認が必要', state: 'needs_review', provider: 'archive.today', test: true, error: 'fixture' }] };
      globalThis.fixtureMessages = [];
      globalThis.fixtureCandidates = [{ url: 'https://archive.li/Ab123', label: '2026-10-26 X' }];
      globalThis.chrome = { runtime: { sendMessage: async message => {
        fixtureMessages.push(message);
        if (message.type === 'AUTO_STATUS') return structuredClone(fixtureStatus);
        if (message.type === 'AUTO_RECEIPT_CANDIDATES') return { ok: true, candidates: fixtureCandidates };
        return { ok: true };
      } } };
      globalThis.setInterval = callback => { globalThis.fixtureStatusPoll = callback; return 1; };
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(base, 'auto-core.js'), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(path.join(base, 'auto-options.js'), 'utf8') });
    await page.getByRole('button', { name: 'この結果の本文を再確認' }).waitFor();
    await run(page);
  } finally { await context.close(); }
}
test('a pasted receipt survives the automatic status refresh and reaches the verify action', async () => {
  await screen(async page => {
    const input = page.getByLabel('@X の結果URL');
    await input.fill('https://archive.li/Ab123');
    await page.evaluate(() => fixtureStatusPoll());
    assert.equal(await input.inputValue(), 'https://archive.li/Ab123');
    await page.getByRole('button', { name: 'この結果の本文を再確認' }).click();
    const request = await page.evaluate(() => fixtureMessages.find(m => m.type === 'AUTO_ADOPT'));
    assert.equal(request.receipt, 'https://archive.li/Ab123');
  });
});
test('status changes preserve the focused editor and its draft after rendering resumes', async () => {
  await screen(async page => {
    const input = page.getByLabel('@X の結果URL');
    await input.fill('https://archive.li/Ab123');
    await page.evaluate(() => { fixtureStatus.jobs[0].error = 'updated error'; return fixtureStatusPoll(); });
    assert.equal(await input.inputValue(), 'https://archive.li/Ab123');
    assert.equal(await input.evaluate(e => document.activeElement === e), true);
    await input.blur(); await page.evaluate(() => fixtureStatusPoll());
    assert.equal(await input.inputValue(), 'https://archive.li/Ab123');
    assert.equal(await page.locator('.job p').first().textContent(), '保存対象: https://x.com/x\nupdated error');
  });
});
test('a candidate from an open archive page fills the result field without starting another test', async () => {
  await screen(async page => {
    await page.getByRole('button', { name: '開いている保存ページから選ぶ' }).click();
    await page.getByRole('button', { name: /2026-10-26 X/ }).click();
    await page.evaluate(() => fixtureStatusPoll());
    assert.equal(await page.getByLabel('@X の結果URL').inputValue(), 'https://archive.li/Ab123');
    await page.getByRole('button', { name: 'この結果の本文を再確認' }).click();
    const requests = await page.evaluate(() => fixtureMessages);
    assert.equal(requests.find(m => m.type === 'AUTO_ADOPT').receipt, 'https://archive.li/Ab123');
    assert.equal(requests.some(m => m.type === 'AUTO_TEST' || m.type === 'AUTO_START'), false);
  });
});
test('a registered receipt pre-fills an untouched result field while an intentional empty draft stays empty', async () => {
  await screen(async page => {
    const input = page.getByLabel('@X の結果URL');
    await page.evaluate(() => { fixtureStatus.jobs[0].receipt = 'https://archive.li/AUjOR'; return fixtureStatusPoll(); });
    assert.equal(await input.inputValue(), 'https://archive.li/AUjOR');
    await input.fill(''); await input.blur();
    await page.evaluate(() => { fixtureStatus.jobs[0].error = 'new status'; return fixtureStatusPoll(); });
    assert.equal(await input.inputValue(), '');
  });
});
test('human confirmation stays visible in the attention filter and can be rechecked without entering a result URL',async()=>{
  await screen(async page=>{
    await page.evaluate(()=>{
      Object.assign(fixtureStatus,{submissionHeld:true});
      Object.assign(fixtureStatus.jobs[0],{state:'opening',label:'人間確認待ち',access_wait:'human',attention:true,can_recheck:true,error:'保存先の人間確認が必要です'});
      return fixtureStatusPoll();
    });
    await page.getByLabel('手動確認が必要なものだけ表示').check();
    assert.equal(await page.locator('.job').count(),1);
    assert.match(await page.locator('#summary').innerText(),/新規依頼:.*待機中/);
    await page.getByRole('button',{name:'確認後に再確認',exact:true}).click();
    const requests=await page.evaluate(()=>fixtureMessages);
    assert.equal(requests.find(m=>m.type==='AUTO_RECHECK').job_id,'one');
    assert.equal(requests.some(m=>['AUTO_TEST','AUTO_START','AUTO_ADOPT'].includes(m.type)),false);
  });
});

test('older manual and access checks stay first in a large backlog without losing replies or receipt drafts', async () => {
  await screen(async page => {
    await page.evaluate(() => {
      const older = [
        { job_id: 'old-review', handle: 'OldReview', state: 'needs_review', label: '手動確認が必要' },
        { job_id: 'old-unknown', handle: 'OldUnknown', state: 'submission_unknown', label: '受付結果不明' },
        { job_id: 'old-human', handle: 'OldHuman', state: 'opening', label: '人間確認待ち', access_wait: 'human',
          target_kind: 'replies', can_recheck: true },
        { job_id: 'old-limit', handle: 'OldLimit', state: 'retry_wait', label: 'アクセス制限の解除待ち',
          access_wait: 'rate_limit', can_recheck: true }
      ];
      const queued = Array.from({ length: 125 }, (_, i) => ({ job_id: 'queued-' + i, handle: 'Queue' + i,
        state: 'queued', label: '保存待ち' }));
      queued[120] = { job_id: 'recent-review', handle: 'RecentReview', state: 'needs_review', label: '手動確認が必要' };
      fixtureStatus.jobs = [...older, ...queued].map(job => ({ provider: 'archive.today', ...job }));
      fixtureStatus.reviewCount = 5;
      fixtureStatus.submissionHeld = true;
      return fixtureStatusPoll();
    });
    assert.match(await page.locator('#summary').innerText(), /手動確認が必要: 5件/);
    assert.match(await page.locator('#summary').innerText(), /新規依頼:.*待機中/);
    const names = await page.locator('#jobs .job strong').allTextContents();
    assert.equal(names.length, 129);
    assert.deepEqual(names.slice(0, 5).map(text => text.split(' — ')[0]),
      ['@RecentReview（プロフィール）', '@OldLimit（プロフィール）', '@OldHuman（返信タブ）', '@OldUnknown（プロフィール）', '@OldReview（プロフィール）']);
    assert.match(names[5], /^@Queue124（プロフィール） — 保存待ち/);
    const input = page.getByLabel('@OldHuman の結果URL');
    await input.fill('https://archive.li/Ab123');
    await page.evaluate(() => { fixtureStatus.jobs.push({ job_id: 'new-queued', handle: 'Newest', state: 'queued',
      label: '保存待ち', provider: 'archive.today' }); return fixtureStatusPoll(); });
    assert.equal(await input.inputValue(), 'https://archive.li/Ab123');
    assert.equal(await input.evaluate(element => document.activeElement === element), true);
    await page.getByLabel('手動確認が必要なものだけ表示').check();
    assert.equal(await page.locator('#jobs .job').count(), 5);
    assert.equal(await page.getByLabel('@OldHuman の結果URL').inputValue(), 'https://archive.li/Ab123');
    const human = page.locator('#jobs .job').filter({ has: page.getByLabel('@OldHuman の結果URL') });
    assert.equal(await human.getByRole('button', { name: '保存先で確認', exact: true }).count(), 1);
    await human.getByRole('button', { name: '確認後に再確認', exact: true }).click();
    const requests = await page.evaluate(() => fixtureMessages);
    assert.equal(requests.find(message => message.type === 'AUTO_RECHECK').job_id, 'old-human');
    assert.equal(requests.some(message => ['AUTO_TEST', 'AUTO_START', 'AUTO_ADOPT'].includes(message.type)), false);
    assert.equal(await page.getByLabel('@OldHuman の結果URL').inputValue(), 'https://archive.li/Ab123');
  });
});

test('the same account has distinct profile and replies editors with the exact save target', async () => {
  await screen(async page => {
    await page.evaluate(() => {
      fixtureStatus.jobs = [
        { job_id: 'profile', handle: 'X', target_kind: 'profile', target_url: 'https://x.com/X', state: 'needs_review', label: '手動確認が必要', provider: 'archive.today' },
        { job_id: 'replies', handle: 'X', target_kind: 'replies', target_url: 'https://x.com/X/with_replies', state: 'needs_review', label: '手動確認が必要', provider: 'archive.today' }
      ];
      return fixtureStatusPoll();
    });
    const profile = page.locator('.job').filter({ has: page.getByText('@X（プロフィール）', { exact: false }) });
    const replies = page.locator('.job').filter({ has: page.getByText('@X（返信タブ）', { exact: false }) });
    assert.match(await profile.locator('p').innerText(), /^保存対象: https:\/\/x\.com\/x$/);
    assert.match(await replies.locator('p').innerText(), /^保存対象: https:\/\/x\.com\/x\/with_replies$/);
    assert.equal(await profile.getByRole('link', { name: 'プロフィールの保存一覧を開く', exact: true }).getAttribute('href'), 'https://archive.li/https://x.com/x');
    assert.equal(await replies.getByRole('link', { name: '返信タブの保存一覧を開く', exact: true }).getAttribute('href'), 'https://archive.li/https://x.com/x/with_replies');
    await profile.locator('input').fill('https://archive.li/Pro01');
    await replies.locator('input').fill('https://archive.li/Rep01');
    await page.evaluate(() => fixtureStatusPoll());
    assert.equal(await profile.locator('input').inputValue(), 'https://archive.li/Pro01');
    await replies.getByRole('button', { name: 'この結果の本文を再確認', exact: true }).click();
    const request = await page.evaluate(() => fixtureMessages.find(message => message.type === 'AUTO_ADOPT'));
    assert.equal(request.job_id, 'replies');
    assert.equal(request.receipt, 'https://archive.li/Rep01');
    assert.equal(await profile.locator('input').inputValue(), 'https://archive.li/Pro01');
  });
});

test('a verified replies capture shows both confirmed areas for a profile request', async () => {
  await screen(async page => {
    await page.evaluate(() => {
      Object.assign(fixtureStatus.jobs[0], { state: 'succeeded', label: '保存済み', target_kind: 'profile',
        scope: ['profile', 'replies'], posts: 'confirmed', error: '', receipt: 'https://archive.li/Rep01' });
      return fixtureStatusPoll();
    });
    assert.match(await page.locator('.job strong').innerText(), /@X（プロフィール）/);
    assert.match(await page.locator('.job p').textContent(), /プロフィール・返信タブ確認済み／投稿本文も確認/);
    assert.equal(await page.getByRole('link', { name: '保存結果を開く', exact: true }).getAttribute('href'), 'https://archive.li/Rep01');
    assert.equal(await page.getByRole('button', { name: 'この結果の本文を再確認', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => fixtureMessages.some(message => message.type === 'AUTO_TEST' || message.type === 'AUTO_START')), false);
  });
});
