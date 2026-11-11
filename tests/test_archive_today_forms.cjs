// Offline DOM regression tests. No requests reach an archive service.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { inspectTodayDocument, submitTodayDocument } = require('../extensions/mute-screen-capture/auto-today.js');
const { inspectFormDocument, collect } = require('../extensions/mute-screen-capture/auto-form-diagnostics.js');
const { readSearchResultLinks } = require('../extensions/mute-screen-capture/auto-receipt-picker.js');
let browser;
before(async () => {
  const options = { headless: true };
  if (process.env.CHROME_PATH) options.executablePath = process.env.CHROME_PATH;
  browser = await chromium.launch(options);
});
after(async () => { if (browser) await browser.close(); });
async function fixture(html, run, url = 'https://archive.li/') {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><title>archive.li</title>' + html }));
    const page = await context.newPage();
    await page.goto(url);
    await run(page);
  } finally { await context.close(); }
}
test('archive.li recognizes submit endpoints with and without a trailing slash', async () => {
  for (const [id, action, pageURL] of [['submit_form', '/submit', 'https://archive.li/'], ['submiturl', '/submit/', 'https://archive.li/'], ['another_id', '/submit/', 'https://archive.li/submit/']]) {
    await fixture(`<form id="${id}" action="${action}" method="post"><input type="hidden" name="submitid" value="fixture-token"><input name="url"><button>Save</button></form>`, async page => {
      assert.equal((await page.evaluate(inspectTodayDocument)).kind, 'form');
      await page.evaluate(() => document.addEventListener('submit', event => {
        event.preventDefault();
        globalThis.recordedSubmission = { values: [...new FormData(event.target)], action: event.target.action };
      }));
      const submit = '(' + submitTodayDocument.toString() + ')("https://x.com/X", "fixture-job")';
      assert.equal((await page.evaluate(submit)).submitted, true);
      assert.deepEqual(await page.evaluate(() => globalThis.recordedSubmission.values), [['submitid', 'fixture-token'], ['url', 'https://x.com/X']]);
      assert.equal((await page.evaluate(submit)).uncertain, true);
    }, pageURL);
  }
});
test('archive.li supports a URL input associated through the form attribute', async () => {
  await fixture('<form id="save" action="/submit/" method="post"><button>Save</button></form><input form="save" name="url" type="url">', async page => {
    assert.equal((await page.evaluate(inspectTodayDocument)).kind, 'form');
  });
});
test('the observed GET submiturl form is recognized alongside the separate search form', async () => {
  await fixture('<form id="submiturl" action="https://archive.li/submit/" method="GET"><input type="text" name="url" id="url"><input type="submit" value="Save"></form><form id="search" action="https://archive.li/search/" method="GET"><input type="text" name="q" id="q"><input type="submit" value="Search"></form>', async page => {
    assert.equal((await page.evaluate(inspectTodayDocument)).kind, 'form');
    await page.evaluate(() => document.addEventListener('submit', event => {
      event.preventDefault();
      globalThis.recordedSubmission = { method: event.target.method, action: event.target.action, values: [...new FormData(event.target)] };
    }));
    const submit = '(' + submitTodayDocument.toString() + ')("https://x.com/X", "fixture-get-job")';
    assert.equal((await page.evaluate(submit)).submitted, true);
    assert.deepEqual(await page.evaluate(() => globalThis.recordedSubmission), { method: 'get', action: 'https://archive.li/submit/', values: [['url', 'https://x.com/X']] });
    assert.equal((await page.evaluate(submit)).uncertain, true);
    assert.equal(await page.locator('#q').inputValue(), '');
  });
});
test('the observed GET form navigates once to a processing receipt using the browser form method', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const requests = [];
  try {
    await context.route('**/*', async route => {
      const request = route.request(), u = new URL(request.url());
      if (u.origin !== 'https://archive.li') return route.abort();
      if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Webpage archive</title><form id="submiturl" action="/submit/" method="GET"><input type="text" name="url" id="url"><input type="submit" value="Save"></form>' });
      if (u.pathname === '/submit/') {
        requests.push({ method: request.method(), url: u.searchParams.get('url'), body: request.postData() });
        // A fresh browser navigation keeps the receipt request intercepted;
        // redirect chains can escape route interception in older Playwright.
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Accepted</title><script>location.replace("/wip/Fix01")</script>' });
      }
      if (u.pathname === '/wip/Fix01') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Saving page</title><p>In progress</p>' });
      return route.abort();
    });
    const page = await context.newPage(); await page.goto('https://archive.li/');
    assert.equal((await page.evaluate(inspectTodayDocument)).kind, 'form');
    const submit = '(' + submitTodayDocument.toString() + ')("https://x.com/X", "fixture-get-job")';
    await Promise.all([page.waitForURL('https://archive.li/wip/Fix01', { timeout: 5000 }), page.evaluate(submit)]);
    assert.deepEqual(requests, [{ method: 'GET', url: 'https://x.com/X', body: null }]);
    assert.equal((await page.evaluate(inspectTodayDocument)).kind, 'processing');
    assert.equal((await page.evaluate(submit)).submitted, false);
    assert.equal(requests.length, 1);
  } finally { await context.close(); }
});
test('archive.li rejects foreign endpoints, unrecognized GET forms, hidden URL inputs and ambiguous forms', async () => {
  for (const html of [
    '<form action="https://example.com/submit/" method="post"><input name="url"></form>',
    '<form action="/submit/" method="get"><input name="url"></form>',
    '<form id="submiturl" action="/submit/" method="get"><input name="url" id="other"></form>',
    '<form id="submiturl" action="https://example.com/submit/" method="get"><input name="url" id="url"></form>',
    '<form id="search" action="/search/" method="get"><input name="url" id="url"></form>',
    '<form action="/submit/" method="post"><input name="url" type="hidden"></form>',
    '<form action="/submit/" method="post"><input name="url"></form><form action="/submit" method="post"><input name="url"></form>'
  ]) await fixture(html, async page => { assert.equal((await page.evaluate(inspectTodayDocument)).kind, 'changed'); });
});
test('archive.li identifies an explicit 429 response as an access restriction', async () => {
  await fixture('<h1>Error 429</h1><p>Rate limit exceeded</p>', async page => {
    const result=await page.evaluate(inspectTodayDocument);
    assert.equal(result.kind, 'blocked');assert.equal(result.block_type,'rate_limit');
  });
});
test('the reported One more step page is a human-confirmation wait, including on a receipt URL', async () => {
  for(const url of ['https://archive.li/submit/?url=https%3A%2F%2Fx.com%2FExample','https://archive.li/Ab123']){
    await fixture('<h1>One more step</h1><p>Please complete the security check to access archive.li</p><div class="g-recaptcha"></div>',async page=>{
      const result=await page.evaluate(inspectTodayDocument);
      assert.equal(result.kind,'blocked');assert.equal(result.block_type,'human');
      assert.equal(result.receipt,url.endsWith('Ab123')?url:'');
    },url);
  }
});
test('form diagnostics reveal the actual method and names without collecting input values or query strings', async () => {
  await fixture('<form id="save" action="/submit/?secret=private-query" method="get"><input type="hidden" name="submitid" value="private-token"><input name="capture_url" value="private-value"><button>Save</button></form>', async page => {
    const result = await page.evaluate(inspectFormDocument);
    assert.equal(result.forms[0].method, 'get');
    assert.equal(result.forms[0].action.path, '/submit/');
    assert.equal(result.forms[0].action.query, true);
    assert.equal(result.forms[0].fields[1].name, 'capture_url');
    assert.doesNotMatch(JSON.stringify(result), /private-query|private-token|private-value/);
  });
});
test('diagnostics only inspect authorized archive homepages and save their report locally', async () => {
  const inspected = [], local = {};
  const chrome = {
    tabs: { query: async query => {
      assert.ok(query.url.every(u => u.startsWith('https://archive.') || u === 'https://ghostarchive.org/*'));
      return [{ id: 1, url: 'https://archive.li/' }, { id: 2, url: 'https://x.com/X' }, { id: 3, url: 'https://archive.li/Ab123' }, { id: 4, url: 'https://archive.md/' }];
    } },
    permissions: { contains: async p => p.origins[0] === 'https://archive.li/*' },
    scripting: { executeScript: async p => { inspected.push(p.target.tabId); return [{ result: { page: { origin: 'https://archive.li', path: '/' }, forms: [] } }]; } },
    runtime: { getManifest: () => ({ version: '1.3.2' }) },
    storage: { local: { set: async value => Object.assign(local, value) } }
  };
  const result = await collect(chrome);
  assert.deepEqual(inspected, [1]);
  assert.equal(result.pages.length, 1);
  assert.deepEqual(Object.keys(local), ['autoArchiveFormDiagnostics']);
  assert.deepEqual(local.autoArchiveFormDiagnostics, result);
});
test('search-result reading extracts real links without queries, input values or foreign URLs', async () => {
  const url = 'https://archive.li/https://x.com/X';
  await fixture('<input value="private-token"><table><tr><td>2026-10-26</td><td><a href="/Ab123?secret=private-query">X</a></td></tr></table><a href="https://example.com/private">Foreign</a>', async page => {
    const result = await page.evaluate(readSearchResultLinks, { expectedURL: url, origins: ['https://archive.li'] });
    assert.deepEqual(result, [{ url: 'https://archive.li/Ab123', label: '2026-10-26 X' }]);
    assert.doesNotMatch(JSON.stringify(result), /private/);
    assert.deepEqual(await page.evaluate(readSearchResultLinks, { expectedURL: 'https://archive.li/https://x.com/Other', origins: ['https://archive.li'] }), []);
  }, url);
});
test('a profile account label and translation control are separated from its name and biography',async()=>{
  const html='<div id="HEADER"><input id="SHARE_LONGLINK" value="https://archive.li/2026.10.26-024205/https://x.com/Example"></div><div id="CONTENT"><div><div><div><span>例</span><div><span>@Example</span></div></div><div>Commentary account</div></div><div><div role="button">Show translation</div><span>よろしくお願いします</span></div><div role="presentation">Joined April 2022</div><div><a href="https://archive.li/o/Ab123/https://x.com/Example/following">Following</a><a href="https://archive.li/o/Ab123/https://x.com/Example/verified_followers">Followers</a></div></div></div>';
  await fixture(html,async page=>{
    const result=await page.evaluate(inspectTodayDocument);
    assert.equal(result.profile.name,'例');assert.equal(result.profile.handle,'Example');
    assert.equal(result.profile.bio,'よろしくお願いします');
  },'https://archive.li/Ab123');
});
test('authored biography text beginning with Show translation is preserved',async()=>{
  for(const control of ['', '<div role="button">Show translation</div>']){
    const html='<div id="CONTENT"><div><div><span>例</span><div><span>@Example</span></div></div><div>'+control+'<span>Show translation is part of my biography</span></div><div role="presentation">Joined 2022</div><div><a href="https://x.com/Example/following">Following</a><a href="https://x.com/Example/followers">Followers</a></div></div></div>';
    await fixture(html,async page=>{assert.equal((await page.evaluate(inspectTodayDocument)).profile.bio,'Show translation is part of my biography');},'https://archive.li/Ab123');
  }
});
test('reply-tab confirmation requires the selected tab of the same account outside posts',async()=>{
  const html=`<a role="tab" aria-selected="true" href="https://x.com/X/with_replies">Outside saved body</a>
    <div id="CONTENT">
      <div><div><span>X</span><div><span>@X</span></div></div><div>Profile biography</div>
        <div role="presentation">Joined 2007</div>
        <div><a href="https://x.com/X/following">Following</a><a href="https://x.com/X/followers">Followers</a></div></div>
      <nav><a id="reply-tab" role="tab" aria-selected="false" href="https://archive.li/o/AUjOR/https://x.com/X/with_replies"><span>Replies</span></a></nav>
      <article><a role="tab" aria-selected="true" href="https://x.com/X/with_replies">Link inside a post</a></article>
    </div>`;
  await fixture(html,async page=>{
    const confirmed=async()=>{
      const result=await page.evaluate(inspectTodayDocument);
      assert.equal(result.profile?.handle,'X');
      return result.profile.replies_tab_confirmed;
    };
    const tab=page.locator('#reply-tab');
    assert.equal(await confirmed(),false);
    await tab.evaluate(a=>a.setAttribute('aria-selected','true'));
    assert.equal(await confirmed(),true);
    await tab.evaluate(a=>a.setAttribute('href','https://x.com/Other/with_replies'));
    assert.equal(await confirmed(),false);
    await tab.evaluate(a=>{
      a.setAttribute('href','https://x.com/X/with_replies');
      a.setAttribute('aria-selected','false');
      a.firstElementChild.setAttribute('aria-current','page');
    });
    assert.equal(await confirmed(),true);
    await tab.evaluate(a=>a.remove());
    assert.equal(await confirmed(),false);
  },'https://archive.li/AUjOR');
});
