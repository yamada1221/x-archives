// User-supplied HTML stays local. Page scripts and external requests are blocked.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const C = require('../extensions/mute-screen-capture/auto-core.js');
const { inspectTodayDocument } = require('../extensions/mute-screen-capture/auto-today.js');
const source = process.env.SAVED_ARCHIVE_HTML;
let browser;
before(async () => { if (source) browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) }); });
after(async () => { if (browser) await browser.close(); });
const job = { target_url: 'https://x.com/X', expected_x_user_id: '783214', submission_started_at: '2026-10-26T00:43:58.954Z', identity: { handle: 'X', name: 'X', bio: "what's happening?!" } };
async function snapshot(run) {
  const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
  try {
    const html = fs.readFileSync(source, 'utf8');
    await context.route('**/*', r => r.request().url() === 'https://archive.li/AUjOR' ? r.fulfill({ contentType: 'text/html', body: html }) : r.abort());
    const page = await context.newPage(); await page.goto('https://archive.li/AUjOR', { waitUntil: 'domcontentloaded' });
    await run(page);
  } finally { await context.close(); }
}
test('the actual saved archive without data-testid identifies the profile and passes body verification', { skip: !source }, async () => {
  await snapshot(async page => {
    const result = await page.evaluate(inspectTodayDocument);
    assert.equal(result.profile?.handle.toLowerCase(), 'x');
    assert.equal(result.profile.name, 'X');
    assert.equal(result.profile.bio, "what's happening?!");
    assert.equal(result.profile.user_id, '783214');
    assert.ok(result.profile.post_ids.includes('1920539854678413366'));
    const verified = C.verify(result, [result.profile], job, Date.parse('2026-10-26T02:00:00Z'));
    assert.equal(verified.ok, true);
    assert.equal(verified.reused_existing, true);
    assert.equal(verified.archived_user_id, '783214');
  });
});
test('the actual old archive still requires an archived numeric ID after the DOM fallback', { skip: !source }, async () => {
  await snapshot(async page => {
    await page.evaluate(() => document.querySelector('img[currentsourceurl*="profile_banners/"]').removeAttribute('currentsourceurl'));
    const result = await page.evaluate(inspectTodayDocument);
    const verified = C.verify(result, result.profile ? [result.profile] : [], job, Date.parse('2026-10-26T02:00:00Z'));
    assert.equal(verified.ok, false);
    assert.match(verified.reason, /数値ID/);
  });
});
test('a different banner account ID in the actual saved archive cannot verify the requested account', { skip: !source }, async () => {
  await snapshot(async page => {
    await page.evaluate(() => {
      const img = document.querySelector('img[currentsourceurl*="profile_banners/"]');
      img.setAttribute('currentsourceurl', img.getAttribute('currentsourceurl').replace('/783214/', '/999999/'));
    });
    const result = await page.evaluate(inspectTodayDocument);
    const verified = C.verify(result, result.profile ? [result.profile] : [], job, Date.parse('2026-10-26T02:00:00Z'));
    assert.equal(verified.ok, false);
    assert.match(verified.reason, /別のアカウント/);
  });
});
test('a banner without its matching profile header-photo link cannot provide an archived account ID', { skip: !source }, async () => {
  await snapshot(async page => {
    await page.evaluate(() => document.querySelector('img[currentsourceurl*="profile_banners/"]').closest('a').setAttribute('href', 'https://archive.li/o/AUjOR/https://x.com/Other/header_photo'));
    const result = await page.evaluate(inspectTodayDocument);
    const verified = C.verify(result, result.profile ? [result.profile] : [], job, Date.parse('2026-10-26T02:00:00Z'));
    assert.equal(verified.ok, false); assert.match(verified.reason, /数値ID/);
  });
});
test('following links only inside a post cannot be mistaken for the saved profile header', { skip: !source }, async () => {
  await snapshot(async page => {
    await page.evaluate(() => {
      const root = document.querySelector('#CONTENT'), article = document.createElement('article');
      article.innerHTML = root.innerHTML; root.replaceChildren(article);
    });
    const result = await page.evaluate(inspectTodayDocument);
    assert.equal(result.profile, undefined);
    assert.equal(C.verify(result, [], job, Date.parse('2026-10-26T02:00:00Z')).ok, false);
  });
});
