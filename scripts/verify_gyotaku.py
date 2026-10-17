"""Read only archived HTML; never follow X links or initiate new captures."""
import datetime as dt
import json
import re
import time
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

RESULT = re.compile(r'^/\d{4}-\d{4}-\d{4}-\d{2}/(https?://.+)$')

class Page(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.body = False
        self.text = []
        self.links = []
        self.frames = []
        self.description = ''
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'body': self.body = True
        if tag in ('script', 'style', 'noscript', 'template'): self.depth += 1
        if tag == 'meta' and a.get('name') == 'twitter:description': self.description = a.get('content', '')
        if tag == 'iframe': self.frames.append(a.get('src', ''))
        if tag == 'a' and self.body and not self.depth: self.links.append(a.get('href', ''))

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'noscript', 'template'): self.depth = max(0, self.depth - 1)
        if tag == 'body': self.body = False

    def handle_data(self, data):
        if self.body and not self.depth: self.text.append(data)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def fetch_html(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'x-archives/1.0 (+https://github.com/yamada1221/x-archives)', 'Accept': 'text/html'})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=25) as response:
        if response.status != 200 or 'text/html' not in response.headers.get('Content-Type', ''):
            raise ValueError('not_html')
        raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024: raise ValueError('too_large')
        return raw.decode('utf-8', errors='replace')

def x_path(url):
    u = urllib.parse.urlsplit(url)
    if u.scheme not in ('http', 'https') or u.hostname not in ('x.com', 'twitter.com', 'www.x.com', 'www.twitter.com') or u.username or u.password or u.port not in (None, 443):
        return None
    return u.path.rstrip('/').lower()

def verify(entry, account, fetch=fetch_html):
    """Return evidence only when the archived body contains the profile description.

    This deliberately leaves posts, empty biographies and changed markup unverified.
    Metadata, a result URL, and an HTTP 200 alone are never sufficient.
    """
    u = urllib.parse.urlsplit(entry.get('url', ''))
    match = RESULT.fullmatch(u.path)
    if u.scheme != 'https' or u.hostname != 'megalodon.jp' or u.username or u.password or u.port or not match:
        return 'invalid_url'
    expected = '/' + account.lower().lstrip('@')
    if not re.fullmatch(r'/[a-z0-9_]{1,15}', expected): return 'invalid_account'
    if x_path(match[1]) != expected or x_path(entry.get('target_url', '')) != expected:
        return 'target_unconfirmed'
    outer = Page(fetch(entry['url']))
    ref = urllib.parse.urlunsplit(('https', 'megalodon.jp', '/ref' + u.path, u.query, ''))
    if ref not in [urllib.parse.urljoin(entry['url'], src) for src in outer.frames]:
        return 'processing_or_unavailable'
    archived = Page(fetch(ref))
    text = ' '.join(' '.join(archived.text).split())
    bio = ' '.join(archived.description.split())
    links = {x_path(href) for href in archived.links}
    if not re.search(r'@' + re.escape(expected[1:]) + r'(?![a-z0-9_])', text, re.I): return 'body_unconfirmed'
    if expected + '/following' not in links: return 'body_unconfirmed'
    if len(bio) < 4 or bio not in text: return 'body_unconfirmed'
    return 'profile_body_confirmed'

def update(data, fetch=fetch_html, pause=time.sleep):
    stamp = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    pending = [(a, e) for a in data.get('artists', []) if a.get('tracking_mode') == 'record'
               for e in a.get('archives', []) if e.get('provider') == 'gyotaku' and e.get('status') != 'done']
    pending.sort(key=lambda pair: pair[1].get('verification_checked_at', ''))
    for i, (artist, entry) in enumerate(pending[:10]):
        if i: pause(5)
        try: result = verify(entry, artist.get('x_account', ''), fetch)
        except Exception: result = 'fetch_failed'
        entry['verification_checked_at'] = stamp
        entry['verification_result'] = result
        if result == 'profile_body_confirmed':
            entry.update(status='done', content_verified_at=stamp, verification_method='archived_html_profile')
            completed = [e for e in artist['archives'] if e.get('status') == 'done']
            primary = max(completed, key=lambda e: e.get('saved_at', ''))
            artist.update(archive_status='done', archive_url=primary['url'], archive_provider=primary['provider'],
                          archive_target_url=primary.get('target_url', ''), archive_checked_at=stamp)
            artist.pop('archive_error', None)
    return min(len(pending), 10)

if __name__ == '__main__':
    path = Path('data/artists.json')
    data = json.loads(path.read_text())
    count = update(data)
    if count: path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    print(f'Checked {count} pending archives')
