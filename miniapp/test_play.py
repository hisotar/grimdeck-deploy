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
            self.assertEqual(self.run_play('break',4,now=100000+7199)[0], 409)
            self.assertEqual(broken['shuffleReadyAt'], 107200)
            status, reshuffled = self.run_play('break',4,now=107200)
            self.assertEqual((status, reshuffled['gain'], reshuffled['shuffleReadyAt']), (200, 10, 114400))
            self.assertEqual(reshuffled['state']['owned'], {'WIT_C01':1})
            self.assertEqual(reshuffled['state']['dust'], 100)
            self.assertEqual(self.run_play('state',now=100000+86400)[1]['state']['freeSpins'], 5)
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
        for n, expected in [(2, (0, 5, 7)), (3, (0, 0, 2))]:
            status, draw = self.run_play('draw', n, 10)
            self.assertEqual(status, 200)
            self.assertEqual(tuple(draw['state'][k] for k in ('freeSpins', 'spins', 'coins')), expected)

    def test_free_spins_refill_offline_and_stop_at_cap(self):
        start = 100000
        interval = 10800
        _, draw = self.run_play('draw', size=10, now=start)
        self.assertEqual((draw['state']['freeSpins'], draw['state']['freeNextAt']), (0, start+interval))
        for seconds, expected in [(interval-1, (0, start+interval)),
                                  (interval, (1, start+2*interval)),
                                  (3*interval+1, (3, start+4*interval)),
                                  (9*interval, (5, 0))]:
            state = self.run_play('state', now=start+seconds)[1]['state']
            self.assertEqual((state['freeSpins'], state['freeNextAt']), expected)
        _, draw = self.run_play('draw', 2, 1, now=start+9*interval)
        self.assertEqual((draw['state']['freeSpins'], draw['state']['freeNextAt']), (4, start+10*interval))
        _, draw = self.run_play('draw', 3, 1, now=start+9*interval+120)
        self.assertEqual((draw['state']['freeSpins'], draw['state']['freeNextAt']), (3, start+10*interval))

    def test_legacy_free_spins_migrate_once(self):
        legacy = dict(day='1970-01-02', used=4, coins=20, dust=50, lastBreak=99999, owned={'WIT_C01': 2}, spins=7)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.executemany('INSERT INTO players VALUES (?,?)', [(uid, json.dumps(legacy)) for uid in ['A', 'B']])
        state = self.run_play('state')[1]['state']
        self.assertEqual((state['freeSpins'], state['freeNextAt']), (1, 110800))
        self.assertEqual({k:state[k] for k in legacy if k not in ('day','used')},
                         {k:v for k,v in legacy.items() if k not in ('day','used')})
        state = self.run_play('state', now=110800)[1]['state']
        self.assertEqual((state['freeSpins'], state['freeNextAt']), (2, 121600))
        self.assertEqual(self.run_play('state', uid='B', now=200000)[1]['state']['freeSpins'], 5)

    def test_clear_collection_and_reset_shuffle_are_separate_and_idempotent(self):
        with patch.object(game.secrets,'randbelow',return_value=0), patch.object(game.secrets,'choice',return_value='WIT_C01'):
            self.run_play('draw', 1, 10)
            self.run_play('draw', 1, 1, uid='B')
            self.run_play('break', 2)
            self.run_play('draw', 3, 1)
            before = self.run_play('state')[1]['state']
            status, clear = self.run_play('clear-collection', 4)
            self.assertEqual((status, clear['removed'], clear['state']), (200, 1, {**before, 'owned':{}}))
            self.assertEqual(clear['shuffleReadyAt'], 107200)
            _, draw = self.run_play('draw', 5, 1)
            self.assertTrue(draw['cards'][0]['new'])
            self.assertEqual(self.run_play('clear-collection', 4)[1]['state'], draw['state'])
            self.assertEqual(self.run_play('state', uid='B')[1]['state']['owned'], {'WIT_C01':1})
            status, reset = self.run_play('reset-shuffle', 6)
            self.assertEqual((status, reset['shuffleReadyAt'], reset['state']), (200, 0, {**draw['state'], 'lastBreak':0}))
            self.run_play('grant', 9, 10)
            self.assertEqual(self.run_play('draw', 7, 1)[0], 200)
            status, shuffled = self.run_play('break', 8, now=100001)
            self.assertEqual(status, 200)
            self.assertEqual(self.run_play('reset-shuffle', 6, now=100001)[1]['shuffleReadyAt'], shuffled['shuffleReadyAt'])

    def test_tester_actions_require_current_allowlisted_session(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            for sid, uid in [('allowed', 'tg:1'), ('removed', 'tg:2')]:
                db.execute('INSERT INTO play_sessions VALUES (?,?,?)',
                           (hashlib.sha256(sid.encode()).hexdigest(), uid, int(time.time())+60))
        with game.ThreadingHTTPServer(('127.0.0.1', 0), game.Play) as server:
            server.db, server.telegram = self.path, True
            server.origin, server.allowed = 'https://example.invalid', {1}
            worker = Thread(target=server.serve_forever, daemon=True)
            worker.start()
            def post(sid='', origin=server.origin, kind='grant'):
                with closing(HTTPConnection(*server.server_address, timeout=3)) as conn:
                    conn.request('POST', f'/api/{kind}', json.dumps({'op':f'operation-{kind}-000001','size':50 if kind=='grant' else 0,'uid':'tg:2'}),
                                 {'Content-Type':'application/json','Origin':origin,
                                  'Cookie':f'__Host-grim-play={sid}'})
                    response = conn.getresponse()
                    return response.status, json.loads(response.read())
            try:
                for kind in game.TEST_ACTIONS:
                    self.assertEqual(post(kind=kind)[0], 401)
                    self.assertEqual(post('removed', kind=kind)[0], 401)
                    self.assertEqual(post('allowed', 'https://other.invalid', kind)[0], 403)
                    self.assertEqual(post('allowed', kind=kind)[0], 200)
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
