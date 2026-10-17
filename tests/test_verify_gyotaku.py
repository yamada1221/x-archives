import unittest
from scripts.verify_gyotaku import verify, update
URL = 'https://megalodon.jp/2026-1017-0547-37/https://x.com:443/X'
OUTER = '<body><iframe src="/ref/2026-1017-0547-37/https://x.com:443/X"></iframe></body>'
BODY = '<head><meta name="twitter:description" content="Example bio"></head><body>@X <p>Example bio</p><a href="https://x.com/X/following">1</a></body>'
def entry(): return dict(url=URL, target_url='https://x.com/X', provider='gyotaku', status='pending', saved_at='2026-10-17')
class Tests(unittest.TestCase):
    def fake(self, body=BODY, outer=OUTER): return lambda url: body if '/ref/' in url else outer
    def test_success(self): self.assertEqual(verify(entry(), 'X', self.fake()), 'profile_body_confirmed')
    def test_processing(self): self.assertEqual(verify(entry(), 'X', self.fake(outer='<body>取得中です</body>')), 'processing_or_unavailable')
    def test_metadata_and_script_not_enough(self):
        body = BODY.replace('<p>Example bio</p>', '<script>Example bio</script>')
        self.assertEqual(verify(entry(), 'X', self.fake(body)), 'body_unconfirmed')
    def test_wrong_account(self): self.assertEqual(verify(entry(), 'Other', self.fake()), 'target_unconfirmed')
    def test_wrong_body(self): self.assertEqual(verify(entry(), 'X', self.fake(BODY.replace('@X', '@Other'))), 'body_unconfirmed')
    def test_external_frame_not_fetched(self):
        self.assertEqual(verify(entry(), 'X', self.fake(outer='<body><iframe src="http://127.0.0.1/"></iframe></body>')), 'processing_or_unavailable')
    def test_post_left_unconfirmed(self):
        e=entry(); e['target_url'] += '/status/123'
        self.assertEqual(verify(e, 'X', self.fake()), 'target_unconfirmed')
    def test_success_preserves_other_fields(self):
        a=dict(x_account='X',tracking_mode='record',note='keep',archives=[entry()])
        update({'artists':[a]},self.fake(),lambda _:None)
        self.assertEqual(a['archive_status'],'done');self.assertEqual(a['note'],'keep')
        self.assertEqual(a['archives'][0]['verification_method'],'archived_html_profile')
    def test_failure_preserves_completed_archive(self):
        a=dict(x_account='X',tracking_mode='record',archive_url='https://archive.md/Abc12',archive_status='done',archives=[entry()])
        def fail(url): raise TimeoutError()
        update({'artists':[a]},fail,lambda _:None)
        self.assertEqual(a['archive_status'],'done');self.assertEqual(a['archives'][0]['status'],'pending')
        self.assertEqual(a['archives'][0]['verification_result'],'fetch_failed')
if __name__ == '__main__': unittest.main()
