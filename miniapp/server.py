"""Closed Telegram vertical slice. Bind locally behind a trusted HTTPS proxy."""
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import closing
from http import HTTPStatus
from http.cookies import SimpleCookie, CookieError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

PUBLIC = Path(__file__).resolve().parent / 'public'
FILES = {'/': ('index.html', 'text/html; charset=utf-8'), '/game.js': ('game.js', 'text/javascript'), '/game.css': ('game.css', 'text/css'), '/drowner.svg': ('drowner.svg', 'image/svg+xml')}
CARD = 'WIT_C01'


def signed_launch(raw, token, allowed):
    if not isinstance(raw, str):
        raise ValueError()
    pairs = parse_qsl(raw, keep_blank_values=True, strict_parsing=True, max_num_fields=32)
    fields = dict(pairs)
    # Raw line breaks could make different field sets share one signed check string.
    if len(fields) != len(pairs) or any(not re.fullmatch(r'[a-z_][a-z0-9_]*', k) or '\r' in v or '\n' in v
                                        for k, v in pairs):
        raise ValueError()
    supplied = fields.pop('hash', '')
    check = '\n'.join(f'{k}={v}' for k, v in sorted(fields.items())).encode()
    secret = hmac.digest(b'WebAppData', token.encode(), 'sha256')
    if not hmac.compare_digest(hmac.new(secret, check, 'sha256').hexdigest(), supplied):
        raise ValueError()
    if not -30 <= time.time() - int(fields['auth_date']) <= 600:
        raise ValueError()
    user = json.loads(fields['user'])
    if not isinstance(user, dict) or type(user.get('id')) is not int or user['id'] not in allowed:
        raise ValueError()
    return user, fields.get('start_param')


def signed_player(raw, token, allowed):
    return signed_launch(raw, token, allowed)[0]


def player_id(raw, token, allowed):
    return signed_player(raw, token, allowed)['id']


def init_db(path):
    with closing(sqlite3.connect(path)) as db, db:
        db.executescript('CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, user INTEGER NOT NULL, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS welcome (user INTEGER PRIMARY KEY);')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Do not log URLs, headers, or Telegram credentials.

    def send(self, status, body, kind='application/json', cookie=None, *, cache='no-store'):
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', cache)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        item = FILES.get(urlsplit(self.path).path)
        if item:
            return self.send(200, (PUBLIC / item[0]).read_bytes(), item[1])
        if self.path == '/api/album':
            return self.api('album')
        self.send(404, b'{}')

    def do_POST(self):
        if self.path not in ('/api/session', '/api/welcome'):
            return self.send(404, b'{}')
        if self.headers.get('Origin') != self.server.origin:
            return self.send(403, b'{}')
        if self.headers.get_content_type() != 'application/json':
            return self.send(415, b'{}')
        self.api(self.path.split('/')[-1])

    def api(self, action):
        try:
            with closing(sqlite3.connect(self.server.db)) as db, db:
                now = int(time.time())
                if action == 'session':
                    n = int(self.headers.get('Content-Length', '0'))
                    if not 0 < n <= 16384:
                        return self.send(400, b'{}')
                    uid = player_id(json.loads(self.rfile.read(n))['initData'], self.server.token, self.server.allowed)
                    sid = secrets.token_urlsafe(32)
                    db.execute('DELETE FROM sessions WHERE expires<=?', (now,))
                    db.execute('INSERT INTO sessions VALUES (?,?,?)', (hashlib.sha256(sid.encode()).hexdigest(), uid, now+3600))
                    db.commit()
                    return self.send(200, b'{}', cookie=f'__Host-grim={sid}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=3600')
                jar = SimpleCookie(self.headers.get('Cookie', ''))
                sid = jar['__Host-grim'].value
                row = db.execute('SELECT user FROM sessions WHERE digest=? AND expires>?', (hashlib.sha256(sid.encode()).hexdigest(), now)).fetchone()
                if not row or row[0] not in self.server.allowed:
                    raise ValueError()
                if action == 'welcome':
                    db.execute('INSERT OR IGNORE INTO welcome VALUES (?)', row)
                    db.commit()
                owned = bool(db.execute('SELECT 1 FROM welcome WHERE user=?', row).fetchone())
                self.send(200, json.dumps({'cards': [CARD] if owned else []}).encode())
        except (ValueError, KeyError, TypeError, CookieError):
            self.send(401, b'{}')
        except sqlite3.Error:
            self.send(503, b'{}')


def main():
    origin = os.environ['GRIM_ORIGIN'].rstrip('/')
    if not origin.startswith('https://') or not urlsplit(origin).hostname or urlsplit(origin).path:
        raise SystemExit('GRIM_ORIGIN must be an HTTPS origin')
    token = os.environ['TELEGRAM_BOT_TOKEN'].strip()
    allowed = {int(v) for v in os.environ['GRIM_TEST_USERS'].split(',')}
    if not token or not allowed:
        raise SystemExit('Missing bot token or allowlist')
    os.umask(0o077)
    path = Path.home() / '.grimdeck' / 'beta.sqlite3'
    path.parent.mkdir(mode=0o700, exist_ok=True)
    init_db(path)
    server = ThreadingHTTPServer(('127.0.0.1', 8787), Handler)
    server.origin, server.token, server.allowed, server.db = origin, token, allowed, path
    print('Closed beta listening on 127.0.0.1:8787', flush=True)
    server.serve_forever()

if __name__ == '__main__':
    main()
