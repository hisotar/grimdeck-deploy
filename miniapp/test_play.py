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

    def test_retries_clock_and_shuffle_keeps_duplicates(self):
        with patch.object(game.secrets,'randbelow',return_value=0), patch.object(game.secrets,'choice',return_value='WIT_C01'):
            status, draw = self.run_play('draw', size=10)
            self.assertEqual(status, 200)
            self.assertEqual(draw['newCount'], 1)
            self.assertEqual([c['new'] for c in draw['cards']], [True]+[False]*9)
            self.assertEqual(draw['state']['coins'], 2)
            self.assertEqual(self.run_play('draw',size=10), (status, draw))
            self.assertEqual(self.run_play('draw',size=1)[0], 409)
            status, broken = self.run_play('break',2)
            self.assertEqual((status,broken['gain'],broken['state']['owned']), (200,2,{'WIT_C01':10}))
            self.assertEqual(self.run_play('break',2), (status,broken))
            self.assertEqual(self.run_play('draw',3,1)[0], 200)
            self.assertEqual(self.run_play('break',4,now=100000+7199)[0], 409)
            self.assertEqual(broken['shuffleReadyAt'], 107200)
            status, reshuffled = self.run_play('break',4,now=107200)
            self.assertEqual((status, reshuffled['gain'], reshuffled['shuffleReadyAt']), (200, 2, 114400))
            self.assertEqual(reshuffled['state']['owned'], {'WIT_C01':11})
            self.assertEqual(reshuffled['state']['dust'], 4)
            self.assertEqual(self.run_play('state',now=100000+86400)[1]['state']['freeSpins'], 5)
            self.assertEqual(self.run_play('state',uid='B')[1]['state']['owned'], {})

    def test_shuffle_bonus_ranges_and_exactly_one_reward(self):
        checks = [(0, 'dust2', 10), (999, 'dust2', 10), (1000, 'spins', 5),
                  (1499, 'spins', 5), (1500, 'dust10', 50), (1799, 'dust10', 50),
                  (1800, 'legendary', 5), (1849, 'legendary', 5),
                  (1850, 'mythic', 5), (1854, 'mythic', 5), (1855, None, 5)]
        for roll, bonus, dust in checks:
            with self.subTest(roll=roll), patch.object(game.secrets, 'randbelow', side_effect=[4, roll]+[0]*10):
                uid = str(roll)
                status, out = self.run_play('break', uid=uid)
                self.assertEqual((status, out['bonus'], out['baseDust'], out['gain']), (200, bonus, 5, dust))
                state = out['state']
                self.assertEqual((state['dust'], state['rewardSpins'], state['freeSpins']), (dust, 3 if bonus == 'spins' else 0, 5))
                if bonus in ('legendary', 'mythic'):
                    cid = out['rewardCard']['id']
                    self.assertEqual(cid[4], bonus[0].upper())
                    self.assertEqual(state['owned'], {cid: 1})
                    self.assertTrue(out['rewardCard']['new'])
                else:
                    self.assertEqual(state['owned'], {})
                    self.assertNotIn('rewardCard', out)
                self.assertEqual(self.run_play('break', uid=uid), (status, out))
                if bonus == 'spins':
                    _, draw = self.run_play('draw', 2, 10, uid=uid)
                    self.assertEqual((draw['state']['freeSpins'], draw['state']['rewardSpins'], draw['state']['coins']), (0, 0, 5))

    def test_mastery_levels_reset_at_utc_midnight_without_resetting_cooldown(self):
        start = 2*game.DAY-5*game.SHUFFLE_COOLDOWN+1
        card = 'WIT_M01'
        for i, level in enumerate([1, 2, 3, 4, 4]):
            at = start+i*game.SHUFFLE_COOLDOWN
            with patch.object(game.secrets, 'randbelow', side_effect=[0, 1855*level-1]), patch.object(game.secrets, 'choice', return_value=card):
                status, out = self.run_play('break', i+1, now=at)
            self.assertEqual((status, out['masteryUsed'], out['bonus']), (200, level, 'mythic'))
            self.assertEqual((out['rewardCard']['new'], out['state']['owned'][card]), (i==0, i+1))
            self.assertEqual((out['shuffleMastery']['count'], out['shuffleMastery']['level']), (i+1, min(4, i+2)))
        midnight = 2*game.DAY
        _, state = self.run_play('state', now=midnight)
        self.assertEqual((state['shuffleMastery']['count'], state['shuffleMastery']['level'], state['shuffleReadyAt']), (0, 1, midnight+1))
        self.assertEqual(self.run_play('break', 6, now=midnight)[0], 409)
        with patch.object(game.secrets, 'randbelow', side_effect=[0, 1855]):
            _, out = self.run_play('break', 6, now=midnight+1)
        self.assertEqual((out['masteryUsed'], out['bonus'], out['gain']), (1, None, 1))

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

    def seed(self, **fields):
        state = {**self.run_play('state')[1]['state'], **fields}
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('INSERT INTO players VALUES (?,?)', ('A', json.dumps(state)))

    def test_craft_recipes_spend_materials_and_preserve_last_copies(self):
        owned = {'WIT_C01': 7, 'WIT_C02': 5, 'WIT_C03': 1, 'WIT_R01': 11,
                 'WIT_E01': 11, 'WIT_L01': 6, 'WIT_M01': 2}
        self.seed(dust=460, owned=owned)
        for recipe, expected_spins in enumerate((1, 3, 6, 11, 16, 26, 26, 26, 26), 1):
            status, out = self.run_play('craft', recipe, recipe)
            self.assertEqual((status, out['crafted'], out['state']['rewardSpins']), (200, recipe, expected_spins))
            self.assertEqual(self.run_play('craft', recipe, recipe), (status, out))
        state = out['state']
        self.assertEqual(state['owned'], dict.fromkeys(owned, 1))
        self.assertEqual(state['dust'], 0)
        self.assertEqual(state['boostInventory'], {'draw': 1, 'shuffle': 1, 'arena': 1})
        self.assertEqual(self.run_play('craft', 1, 2)[0], 409)
        for recipe in range(1, 10):
            self.assertEqual(self.run_play('craft', 10+recipe, recipe)[0], 409)
        self.assertEqual(self.run_play('activate-boost', 20, 9)[0], 400)
        self.assertEqual(self.run_play('state')[1]['state'], state)

    def test_draw_boost_consumes_only_covered_cards_and_respects_retries(self):
        self.seed(boostInventory={'draw': 2}, coins=60)
        status, activated = self.run_play('activate-boost', 1, 7)
        self.assertEqual((status, activated['state']['activeBoosts']), (200, {'draw': 10}))
        self.assertEqual(self.run_play('activate-boost', 1, 7), (status, activated))
        self.assertEqual(self.run_play('activate-boost', 2, 7)[0], 409)
        self.assertEqual(self.run_play('draw', 2, 50, uid='B')[0], 409)
        with patch.object(game.secrets, 'randbelow', side_effect=[73, 97, 25, 52, 24]+[97]*46):
            _, first = self.run_play('draw', 3, 1)
            self.assertEqual(first['state']['activeBoosts'], {'draw': 9})
            _, pack = self.run_play('draw', 4, 50)
        self.assertEqual(first['cards'][0]['id'][4], 'L')
        self.assertEqual([c['id'][4] for c in pack['cards'][:9]], list('MRECM'+'MMMM'))
        self.assertEqual({c['id'][4] for c in pack['cards'][9:]}, {'L'})
        self.assertEqual(pack['state']['activeBoosts'], {})
        self.assertEqual(pack['state']['boostInventory'], {'draw': 1})
        self.assertEqual(self.run_play('draw', 4, 50), (200, pack))
        self.assertEqual(self.run_play('activate-boost', 5, 7)[0], 200)
        self.assertEqual(self.run_play('draw', 6, 50)[0], 409)
        self.assertEqual(self.run_play('state')[1]['state']['activeBoosts'], {'draw': 10})

    def test_shuffle_boost_reaches_five_and_expires_after_four_successes(self):
        self.seed(boostInventory={'shuffle': 1}, shuffleDay=1, shuffleCount=4)
        self.assertEqual(self.run_play('activate-boost', 1, 8)[0], 200)
        for i, level in enumerate((5, 5, 5, 5, 4)):
            now = 100000+i*game.SHUFFLE_COOLDOWN
            with patch.object(game.secrets, 'randbelow', side_effect=[0, 1855*level-1]):
                status, out = self.run_play('break', i+2, now=now)
            self.assertEqual((status, out['masteryUsed'], out['bonus']), (200, level, 'mythic'))
            self.assertEqual(out['state']['activeBoosts'].get('shuffle', 0), max(0, 3-i))
            self.assertEqual(out['shuffleMastery']['level'], 4)
            self.assertEqual(self.run_play('break', i+2, now=now), (status, out))
            self.assertEqual(self.run_play('break', 20+i, now=now+1)[0], 409)

    def test_parallel_craft_does_not_double_spend(self):
        self.seed(dust=10)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda n: self.run_play('craft', n, 1)[0], (1, 2)))
        self.assertEqual(sorted(results), [200, 409])
        state = self.run_play('state')[1]['state']
        self.assertEqual((state['dust'], state['rewardSpins']), (0, 1))

    def test_parallel_spending(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda n:self.run_play('draw',n,10,coins=5)[0], (1,2)))
        self.assertEqual(sorted(results),[200,409])
        self.assertEqual(sum(self.run_play('state')[1]['state']['owned'].values()),10)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.run_play('draw',1,10,uid='C',coins=5), range(2)))
        self.assertEqual(results[0],results[1])
        self.assertEqual(sum(self.run_play('state',uid='C')[1]['state']['owned'].values()),10)
