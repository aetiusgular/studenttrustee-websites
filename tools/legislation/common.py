"""
Shared plumbing for the data pipeline: cached HTTP, the manifest, time helpers.

Every network call goes through Http.get(), which keeps a copy of each
response under .cache/ (persisted between nightly runs by actions/cache) and
revalidates with ETag / If-Modified-Since. Sources that never change once
published (a finished roll call) get a long ttl; indexes get ttl=0.

The manifest (studenttrustee/data/legislation/manifest.json) records, per
source, when it was last checked successfully, when the source itself last
changed, and whether the most recent attempt failed. The site reads it to
show freshness and to warn when a feed is behind.
"""
import hashlib
import json
import os
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SITE = os.path.join(ROOT, 'studenttrustee')
DATA_DIR = os.path.join(SITE, 'data', 'legislation')
CACHE_DIR = os.path.join(ROOT, '.cache')
USER_AGENT = 'studenttrustee.net data pipeline (+https://studenttrustee.net; studenttrustee@4cd.edu)'
PACIFIC = ZoneInfo('America/Los_Angeles')
EASTERN = ZoneInfo('America/New_York')
UTC = timezone.utc


def now_iso():
    return datetime.now(UTC).strftime('%Y-%m-%dT%H:%M:%SZ')


def iso(dt):
    """ISO 8601 with offset, seconds precision."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    s = dt.isoformat(timespec='seconds')
    return s.replace('+00:00', 'Z')


def http_date_to_iso(value):
    if not value:
        return None
    try:
        from email.utils import parsedate_to_datetime
        return iso(parsedate_to_datetime(value).astimezone(UTC))
    except Exception:
        return None


class FetchError(Exception):
    pass


class Http:
    """requests.Session with an on-disk cache and polite retries."""

    def __init__(self, cache_dir=CACHE_DIR, timeout=60, retries=3):
        import requests
        self.session = requests.Session()
        self.session.headers['User-Agent'] = USER_AGENT
        self.cache_dir = cache_dir
        self.timeout = timeout
        self.retries = retries
        self.calls = 0
        os.makedirs(cache_dir, exist_ok=True)

    def _paths(self, url):
        key = hashlib.sha1(url.encode()).hexdigest()
        return os.path.join(self.cache_dir, key + '.body'), os.path.join(self.cache_dir, key + '.json')

    def get(self, url, ttl=0, headers=None, params=None):
        """Return (bytes, meta). ttl is seconds a cached copy is trusted without revalidation."""
        if params:
            from urllib.parse import urlencode
            url = url + ('&' if '?' in url else '?') + urlencode(params)
        body_path, meta_path = self._paths(url)
        meta = {}
        if os.path.exists(meta_path) and os.path.exists(body_path):
            with open(meta_path, encoding='utf-8') as fh:
                meta = json.load(fh)
            age = time.time() - meta.get('fetched_epoch', 0)
            if ttl and age < ttl:
                with open(body_path, 'rb') as fh:
                    return fh.read(), dict(meta, from_cache=True)
        req_headers = dict(headers or {})
        if meta.get('etag'):
            req_headers['If-None-Match'] = meta['etag']
        if meta.get('last_modified'):
            req_headers['If-Modified-Since'] = meta['last_modified']
        last_exc = None
        for attempt in range(self.retries):
            try:
                self.calls += 1
                r = self.session.get(url, headers=req_headers, timeout=self.timeout)
                if r.status_code == 304 and os.path.exists(body_path):
                    meta['fetched_epoch'] = time.time()
                    meta['fetched_at'] = now_iso()
                    with open(meta_path, 'w', encoding='utf-8') as fh:
                        json.dump(meta, fh)
                    with open(body_path, 'rb') as fh:
                        return fh.read(), dict(meta, from_cache=True)
                if r.status_code in (429, 500, 502, 503, 504):
                    raise FetchError('HTTP %s' % r.status_code)
                if r.status_code >= 400:
                    raise FetchError('HTTP %s for %s' % (r.status_code, url))
                meta = {'url': url, 'status': r.status_code, 'etag': r.headers.get('ETag'),
                        'last_modified': r.headers.get('Last-Modified'), 'fetched_at': now_iso(),
                        'fetched_epoch': time.time(), 'content_type': r.headers.get('Content-Type')}
                with open(body_path, 'wb') as fh:
                    fh.write(r.content)
                with open(meta_path, 'w', encoding='utf-8') as fh:
                    json.dump(meta, fh)
                return r.content, dict(meta, from_cache=False)
            except FetchError as e:
                last_exc = e
                if 'HTTP 4' in str(e) and '429' not in str(e):
                    raise
            except Exception as e:  # connection errors, timeouts
                last_exc = e
            time.sleep(1.5 * (attempt + 1))
        raise FetchError('%s: %s' % (url, last_exc))

    def get_text(self, url, ttl=0, encoding='utf-8', **kw):
        body, meta = self.get(url, ttl=ttl, **kw)
        return body.decode(encoding, 'replace'), meta

    def get_json(self, url, ttl=0, **kw):
        body, meta = self.get(url, ttl=ttl, **kw)
        return json.loads(body.decode('utf-8', 'replace')), meta


class Manifest:
    PATH = os.path.join(DATA_DIR, 'manifest.json')
    SCHEMA_VERSION = 1

    def __init__(self):
        self.data = {'schema_version': self.SCHEMA_VERSION, 'generated_at': None, 'sources': {}, 'counts': {}}
        try:
            with open(self.PATH, encoding='utf-8') as fh:
                old = json.load(fh)
            if isinstance(old, dict):
                self.data['sources'] = old.get('sources', {}) or {}
                self.data['counts'] = old.get('counts', {}) or {}
                self.data['previous_counts'] = dict(old.get('counts', {}) or {})
        except (FileNotFoundError, ValueError):
            pass

    def source(self, sid):
        return self.data['sources'].setdefault(sid, {})

    def describe(self, sid, name, url, level, official=True, license=None):
        s = self.source(sid)
        s.update({'name': name, 'url': url, 'level': level, 'official': official})
        if license:
            s['license'] = license
        return s

    def ok(self, sid, source_updated_at=None, note=None):
        s = self.source(sid)
        s['status'] = 'ok'
        s['last_success_at'] = now_iso()
        s['last_checked_at'] = s['last_success_at']
        if source_updated_at:
            s['source_updated_at'] = source_updated_at
        s.pop('error', None)
        if note:
            s['note'] = note

    def error(self, sid, message):
        s = self.source(sid)
        s['status'] = 'error' if not s.get('last_success_at') else 'stale'
        s['last_checked_at'] = now_iso()
        s['error'] = str(message)[:500]

    def count(self, key, value):
        self.data['counts'][key] = value

    def save(self):
        self.data['generated_at'] = now_iso()
        os.makedirs(os.path.dirname(self.PATH), exist_ok=True)
        with open(self.PATH, 'w', encoding='utf-8', newline='\n') as fh:
            json.dump(self.data, fh, ensure_ascii=False, indent=1, sort_keys=True)
            fh.write('\n')


def et_to_iso(date_str, time_str=None, fmt_date='%d-%b-%Y', fmt_time='%I:%M %p'):
    """House Clerk dates ('16-Sep-2026', '7:05 PM') are Eastern Time."""
    try:
        if time_str:
            dt = datetime.strptime(date_str.strip() + ' ' + time_str.strip(), fmt_date + ' ' + fmt_time)
        else:
            dt = datetime.strptime(date_str.strip(), fmt_date)
        return iso(dt.replace(tzinfo=EASTERN))
    except ValueError:
        return None


def senate_datetime_to_iso(value):
    """Senate LIS: 'September 24, 2026,  01:45 PM' (Eastern)."""
    if not value:
        return None
    v = ' '.join(value.replace(',', ' ').split())
    for fmt in ('%B %d %Y %I:%M %p', '%B %d %Y'):
        try:
            return iso(datetime.strptime(v, fmt).replace(tzinfo=EASTERN))
        except ValueError:
            continue
    return None


def slugify(s):
    import re
    import unicodedata
    s = unicodedata.normalize('NFD', (s or '').lower())
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')
