const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const C = require('../extensions/mute-screen-capture/auto-core.js');
const { inspectTodayDocument } = require('../extensions/mute-screen-capture/auto-today.js');
// Saved pages and their matching job metadata remain outside the repository.
const jobsFile = process.env.SAVED_ARCHIVE_JOBS;
const pages = [{ handle: 'YOSHIKI_0819', file: process.env.SAVED_YOSHIKI_HTML }, { handle: 'it3sd', file: process.env.SAVED_IT3SD_HTML }];
const available = file => Boolean(file && fs.existsSync(file) && fs.statSync(file).isFile());
const fixtureReady = entry => available(jobsFile) && available(entry.file);
const jobs = pages.some(fixtureReady) ? JSON.parse(fs.readFileSync(jobsFile, 'utf8')) : [];
const fixtureSkip = entry => !fixtureReady(entry) && 'Requires SAVED_ARCHIVE_JOBS and the corresponding saved HTML fixture';
let browser;
before(async () => { if (pages.some(fixtureReady)) browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) }); });
after(async () => { if (browser) await browser.close(); });
for (const entry of pages) test('the actual saved body verifies ' + entry.handle, { skip: fixtureSkip(entry) }, async () => {
  const job = jobs.find(j => j.registered_handle === entry.handle);
  assert.ok(job, 'The external job fixture must include ' + entry.handle);
  const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
  try {
    const html = fs.readFileSync(entry.file, 'utf8');
    await context.route('**/*', r => r.request().url() === job.receipt ? r.fulfill({ contentType: 'text/html', body: html }) : r.abort());
    const page = await context.newPage(); await page.goto(job.receipt, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(inspectTodayDocument);
    assert.equal(result.profile?.handle.toLowerCase(), job.identity.handle.toLowerCase());
    assert.equal(C.norm(result.profile.name), C.norm(job.identity.name));
    assert.equal(C.norm(result.profile.bio), C.norm(job.identity.bio));
    const verified = C.verify(result, result.profile ? [result.profile] : [], job, Date.parse('2026-10-27T12:00:00Z'));
    assert.equal(verified.ok, true, verified.reason);
  } finally { await context.close(); }
});
test('the corrected YOSHIKI snapshot still rejects a different archived numeric ID', {skip:fixtureSkip(pages[0])},async()=>{
  const job=jobs.find(j=>j.registered_handle==='YOSHIKI_0819');
  assert.ok(job, 'The external job fixture must include YOSHIKI_0819');
  const context=await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block'});
  try{
    const html=fs.readFileSync(pages[0].file,'utf8');
    await context.route('**/*',r=>r.request().url()===job.receipt?r.fulfill({contentType:'text/html',body:html}):r.abort());
    const page=await context.newPage();await page.goto(job.receipt,{waitUntil:'domcontentloaded'});
    await page.evaluate(()=>{const img=document.querySelector('img[currentsourceurl*="profile_banners/"]');img.setAttribute('currentsourceurl',img.getAttribute('currentsourceurl').replace(/profile_banners\/\d+\//,'profile_banners/999999/'));});
    const result=await page.evaluate(inspectTodayDocument);
    const verified=C.verify(result,result.profile?[result.profile]:[],job,Date.parse('2026-10-27T12:00:00Z'));
    assert.equal(verified.ok,false);assert.match(verified.reason,/別のアカウント/);
  }finally{await context.close();}
});
