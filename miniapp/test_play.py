import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from http.client import HTTPConnection
from threading import Thread
import hashlib
import json
import time
from unittest.mock import patch

import play_server as game


class FullGame(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.path = Path(folder.name)/'play.sqlite3'
        with closing(sqlite3.connect(self.path)) as db:
            game.schema(db)

    def run_play(self, kind, n=1, size=0, *, uid='A', now=100000, coins=7):
        with closing(sqlite3.connect(self.path)) as db, db:
            return game.play(db, uid, kind, {'op':f'operation-{n:06}', 'size':size}, coins, now)

    def test_retries_clock_and_dismantle(self):
        with patch.object(game.secrets,'randbelow',return_value=0), patch.object(game.secrets,'choice',return_value='WIT_C01'):
            status, draw = self.run_play('draw', size=10)
            self.assertEqual(status, 200)
            self.assertEqual(draw['newCount'], 1)
            self.assertEqual([c['new'] for c in draw['cards']], [True]+[False]*9)
            self.assertEqual(draw['state']['coins'], 2)
            self.assertEqual(self.run_play('draw',size=10), (status, draw))
            self.assertEqual(self.run_play('draw',size=1)[0], 409)
            status, broken = self.run_play('break',2)
            self.assertEqual((status,broken['gain'],broken['state']['owned']), (200,90,{'WIT_C01':1}))
            self.assertEqual(self.run_play('break',2), (status,broken))
            self.assertEqual(self.run_play('draw',3,1)[0], 200)
            self.assertEqual(self.run_play('break',4,now=100000+86399)[0], 409)
            self.assertEqual(self.run_play('break',4,now=100000+86400)[1]['gain'], 10)
            self.assertEqual(self.run_play('state',now=100000+86400)[1]['state']['used'], 0)
            self.assertEqual(self.run_play('state',uid='B')[1]['state']['owned'], {})

    def test_priority_and_full_price(self):
        with patch.object(game.secrets,'randbelow',side_effect=[99,99,90,90]+[0]*7), patch.object(game.secrets,'choice',side_effect=['WIT_M01','WIT_M01','WIT_L01','WIT_L01']+['WIT_C01']*7):
            self.run_play('draw',1,1)
            _, draw=self.run_play('draw',2,10)
            self.assertEqual((draw['featured'],draw['newCount'],draw['state']['coins']),(1,2,1))
            status,_=self.run_play('draw',3,50)
            self.assertEqual(status,409)
            self.assertEqual(self.run_play('state')[1]['state'],draw['state'])

    def test_grant_and_spend(self):
        status, grant = self.run_play('grant', size=10)
        self.assertEqual((status, grant['granted'], grant['state']['spins']), (200, 10, 10))
        self.assertEqual(self.run_play('grant', size=10), (status, grant))
        self.assertEqual(self.run_play('grant', 2, 500)[0], 400)
        self.assertEqual(self.run_play('draw', 2, 50)[0], 409)
        for n, expected in [(2, (5, 5, 7)), (3, (5, 0, 2))]:
            status, draw = self.run_play('draw', n, 10)
            self.assertEqual(status, 200)
            self.assertEqual(tuple(draw['state'][k] for k in ('used', 'spins', 'coins')), expected)

    def test_grant_requires_current_allowlisted_session(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            for sid, uid in [('allowed', 'tg:1'), ('removed', 'tg:2')]:
                db.execute('INSERT INTO play_sessions VALUES (?,?,?)',
                           (hashlib.sha256(sid.encode()).hexdigest(), uid, int(time.time())+60))
        with game.ThreadingHTTPServer(('127.0.0.1', 0), game.Play) as server:
            server.db, server.telegram = self.path, True
            server.origin, server.allowed = 'https://example.invalid', {1}
            worker = Thread(target=server.serve_forever, daemon=True)
            worker.start()
            def post(sid='', origin=server.origin):
                with closing(HTTPConnection(*server.server_address, timeout=3)) as conn:
                    conn.request('POST', '/api/grant', json.dumps({'op':'operation-000001','size':50,'uid':'tg:2'}),
                                 {'Content-Type':'application/json','Origin':origin,
                                  'Cookie':f'__Host-grim-play={sid}'})
                    response = conn.getresponse()
                    return response.status, json.loads(response.read())
            try:
                self.assertEqual(post()[0], 401)
                self.assertEqual(post('removed')[0], 401)
                self.assertEqual(post('allowed', 'https://other.invalid')[0], 403)
                status, result = post('allowed')
                self.assertEqual((status, result['state']['spins']), (200, 50))
                self.assertEqual(self.run_play('state', uid='tg:2')[1]['state']['spins'], 0)
                self.assertEqual(post('allowed')[1]['state']['spins'], 50)
            finally:
                server.shutdown()
                worker.join()

    def test_parallel_spending(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda n:self.run_play('draw',n,10,coins=5)[0], (1,2)))
        self.assertEqual(sorted(results),[200,409])
        self.assertEqual(sum(self.run_play('state')[1]['state']['owned'].values()),10)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.run_play('draw',1,10,uid='C',coins=5), range(2)))
        self.assertEqual(results[0],results[1])
        self.assertEqual(sum(self.run_play('state',uid='C')[1]['state']['owned'].values()),10)
