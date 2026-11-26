import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from http.client import HTTPConnection
from threading import Thread
import hashlib
import hmac
import json
import time
from unittest.mock import patch
from urllib.parse import urlencode

import play_server as game


class FullGame(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.path = Path(folder.name)/'play.sqlite3'
        with closing(sqlite3.connect(self.path)) as db:
            game.schema(db, now=100000)

    def run_play(self, kind, n=1, size=0, *, uid='A', now=100000, coins=7, **params):
        with closing(sqlite3.connect(self.path)) as db, db:
            return game.play(db, uid, kind, {'op':f'operation-{n:06}', 'size':size, **params}, coins, now)

    def test_retries_clock_and_shuffle_keeps_duplicates(self):
        with patch.object(game.secrets,'randbelow',return_value=0), patch.object(game.secrets,'choice',return_value='WIT_C01'):
            status, draw = self.run_play('draw', size=10)
            self.assertEqual(status, 200)
            self.assertEqual(draw['newCount'], 1)
            self.assertEqual([c['new'] for c in draw['cards']], [True]+[False]*9)
            self.assertEqual(draw['state']['coins'] - sum(q['coins'] for q in draw['questRewards']), 2)
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

    def test_shuffle_ranges_and_exactly_one_reward(self):
        checks = [(0, 'dust2', 10), (999, 'dust2', 10), (1000, 'spins', 0),
                  (1499, 'spins', 0), (1500, 'dust10', 50), (1799, 'dust10', 50),
                  (1800, 'legendary', 0), (1849, 'legendary', 0),
                  (1850, 'mythic', 0), (1854, 'mythic', 0), (1855, None, 5)]
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
                    self.assertEqual((draw['state']['freeSpins'], draw['state']['rewardSpins'],
                                      draw['state']['coins'] - sum(q['coins'] for q in draw['questRewards'])), (0, 0, state['coins']-2))

    def test_legacy_shuffle_receipt_replays_without_new_rewards(self):
        card = 'WIT_M01'
        self.seed(dust=5, owned={card: 1}, lastBreak=100000, shuffleDay=1, shuffleCount=1)
        receipt = dict(gain=5, baseDust=5, bonus='mythic', masteryUsed=1,
                       rewardCard=dict(id=card, new=True))
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('INSERT INTO operations VALUES (?,?,?,?,?)',
                       ('A', 'operation-000001', 'break', 0, json.dumps(receipt)))
        status, replay = self.run_play('break')
        self.assertEqual(status, 200)
        self.assertEqual({k: replay[k] for k in receipt}, receipt)
        self.assertEqual((replay['state']['dust'], replay['state']['owned']), (5, {card: 1}))
        self.assertEqual(self.run_play('break'), (status, replay))

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
            self.assertEqual((draw['featured'],draw['newCount'],
                              draw['state']['coins'] - sum(q['coins'] for q in draw['questRewards'])), (1,2,1))
            status,_=self.run_play('draw',3,50)
            self.assertEqual(status,409)
            self.assertEqual(self.run_play('state')[1]['state'],draw['state'])

    def test_grant_and_spend(self):
        status, grant = self.run_play('grant', size=10)
        self.assertEqual((status, grant['granted'], grant['state']['spins']), (200, 10, 10))
        self.assertEqual(self.run_play('grant', size=10), (status, grant))
        self.assertEqual(self.run_play('grant', 2, 500)[0], 400)
        self.assertEqual(self.run_play('draw', 2, 50)[0], 409)
        earned = 0
        for n, expected in [(2, (0, 5, 7)), (3, (0, 0, 2))]:
            status, draw = self.run_play('draw', n, 10)
            self.assertEqual(status, 200)
            earned += sum(q['coins'] for q in draw['questRewards'])
            self.assertEqual((draw['state']['freeSpins'], draw['state']['spins'], draw['state']['coins'] - earned), expected)

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
            self.assertEqual((status, clear['removed'], clear['state']), (200, 1, {**before, 'owned':{}, 'deck':[None] * 6}))
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
            db.execute('UPDATE players SET state=? WHERE uid=?', (json.dumps(state), 'A'))

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

    def test_health_rune_batch_stays_in_inventory_until_arena(self):
        self.seed(dust=400, boostInventory={'arena': 1})
        status, order = self.run_play('craft', size=10, quantity=2)
        self.assertEqual((status, order['crafted'], order['craftedQuantity']), (200, 10, 2))
        self.assertEqual(order['state']['boostInventory'], {'arena': 1, 'arenaHealth': 2})
        self.assertEqual(order['state']['dust'], 0)
        self.assertEqual(self.run_play('craft', size=10, quantity=2), (status, order))
        self.assertEqual(self.run_play('craft', 2, 10)[0], 409)
        self.assertEqual(self.run_play('activate-boost', 2, 10)[0], 400)
        self.assertEqual(self.run_play('state')[1]['state'], order['state'])

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

    def test_batch_craft_spends_and_rewards_atomically(self):
        self.seed(dust=230, owned={'WIT_C01': 17, 'WIT_C02': 5})
        status, out = self.run_play('craft', 1, 1, quantity=3)
        self.assertEqual((status, out['craftedQuantity'], out['state']['dust'], out['state']['rewardSpins']),
                         (200, 3, 200, 3))
        self.assertEqual(self.run_play('craft', 1, 1, quantity=3), (status, out))
        self.assertEqual(self.run_play('craft', 1, 1, quantity=2)[0], 409)
        self.assertEqual(self.run_play('craft', 2, 2, quantity=3)[0], 409)
        self.assertEqual(self.run_play('state')[1]['state'], out['state'])
        status, out = self.run_play('craft', 2, 2, quantity=2)
        self.assertEqual((status, out['state']['owned'], out['state']['rewardSpins']),
                         (200, {'WIT_C01': 1, 'WIT_C02': 1}, 7))
        status, out = self.run_play('craft', 3, 7, quantity=2)
        self.assertEqual((status, out['state']['dust'], out['state']['boostInventory']), (200, 0, {'draw': 2}))
        self.assertEqual(self.run_play('craft', 3, 7, quantity=2), (status, out))

    def test_craft_quantity_validated_and_legacy_operations_replay(self):
        self.seed(dust=game.MAX_CRAFT_BATCH * 10)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('INSERT INTO operations VALUES (?,?,?,?,?)', ('A', 'operation-000001', 'craft', 1, '{"crafted":1}'))
        self.assertEqual(self.run_play('craft', 1, 1, quantity=1)[0], 200)
        self.assertEqual(self.run_play('craft', 1, 1, quantity=2)[0], 409)
        for bad in (None, True, 0, -1, 1.5, '2', game.MAX_CRAFT_BATCH + 1):
            with self.subTest(bad=bad):
                self.assertEqual(self.run_play('craft', 2, 1, quantity=bad)[0], 400)
        self.assertEqual(self.run_play('activate-boost', 2, 7, quantity=2)[0], 400)
        status, out = self.run_play('craft', 2, 1, quantity=game.MAX_CRAFT_BATCH)
        self.assertEqual((status, out['state']['dust'], out['state']['rewardSpins']), (200, 0, game.MAX_CRAFT_BATCH))

    def test_parallel_craft_does_not_double_spend(self):
        self.seed(dust=30)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda n: self.run_play('craft', n, 1, quantity=3)[0], (1, 2)))
        self.assertEqual(sorted(results), [200, 409])
        state = self.run_play('state')[1]['state']
        self.assertEqual((state['dust'], state['rewardSpins']), (0, 3))

    def test_parallel_spending(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda n:self.run_play('draw',n,10,coins=5)[0], (1,2)))
        self.assertEqual(sorted(results),[200,409])
        self.assertEqual(sum(self.run_play('state')[1]['state']['owned'].values()),10)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.run_play('draw',1,10,uid='C',coins=5), range(2)))
        self.assertEqual(results[0],results[1])
        self.assertEqual(sum(self.run_play('state',uid='C')[1]['state']['owned'].values()),10)

    def test_personal_board_rollover_and_active_order(self):
        midnight = 2 * game.DAY - game.hunts.MOSCOW
        def board(uid, now):
            return self.run_play('state', uid=uid, now=now)[1]['state']['board']
        first = board('A', midnight-1)
        self.assertEqual(first, board('A', midnight-2))
        self.assertNotEqual(first['notices'], board('B', midnight-1)['notices'])
        self.assertEqual(first['resetsAt'], midnight)
        self.assertIn(len(first['notices']), range(3, 7))
        self.assertLessEqual({q['kind'] for q in first['notices']}, {'hunt','draw','craft','break'})
        a, b = [q for q in first['notices'] if q['kind']=='hunt']
        status, take = self.run_play('take-contract', 1, now=midnight-1, contract=a['id'])
        self.assertEqual((status, take['state']['contract']['id']), (200, a['id']))
        self.assertEqual(self.run_play('take-contract', 1, now=midnight-1, contract=b['id'])[0], 409)
        self.assertEqual(self.run_play('take-contract', 2, now=midnight-1, contract=b['id'])[0], 409)
        state = self.run_play('state', now=midnight)[1]['state']
        self.assertEqual(state['board']['day'], first['day']+1)
        self.assertEqual(state['contract'], take['state']['contract'])
        self.assertTrue(all(q.get('progress', 0)==0 for q in state['board']['notices']))
        self.assertEqual(self.run_play('take-contract', 3, uid='C', now=midnight, contract=a['id'])[0], 409)

    def test_tester_renew_board_and_clear_dust_preserve_other_state(self):
        self.seed(dust=480, coins=31, owned={'WIT_C01':1}, deck=['WIT_C01']+[None]*5)
        before = self.run_play('state')[1]['state']
        old_board = before['board']
        contract = next(q for q in old_board['notices'] if q['kind']=='hunt')['id']
        self.assertEqual(self.run_play('take-contract', 1, contract=contract)[0], 200)
        self.assertEqual(self.run_play('start-hunt', 2, contract=contract)[0], 200)
        before = self.run_play('state')[1]['state']
        status, changed = self.run_play('renew-board', 3)
        new_board = changed['state']['board']
        self.assertEqual((status, changed['state']), (200, {**before, 'board':new_board}))
        self.assertEqual(new_board['resetsAt'], old_board['resetsAt'])
        self.assertIn(len(new_board['notices']), range(3, 7))
        self.assertTrue({q['id'] for q in old_board['notices']}.isdisjoint(q['id'] for q in new_board['notices']))
        self.assertTrue({q['name'] for q in old_board['notices'] if q['kind']=='hunt'}.isdisjoint(
                        q['name'] for q in new_board['notices'] if q['kind']=='hunt'))
        self.assertEqual(self.run_play('renew-board', 3)[1]['state']['board'], new_board)
        status, cleared = self.run_play('clear-dust', 4)
        self.assertEqual((status, cleared['dustRemoved'], cleared['state']),
                         (200, 480, {**changed['state'], 'dust':0}))
        later = self.run_play('renew-board', 5)[1]['state']
        self.assertNotEqual(later['board'], new_board)
        self.assertEqual(self.run_play('renew-board', 3)[1]['state'], later)
        with patch.object(game.secrets, 'randbelow', side_effect=[0, 9999]):
            earned = self.run_play('break', 6)[1]['state']
        self.assertEqual(earned['dust'], 1)
        self.assertEqual(self.run_play('clear-dust', 4)[1]['state'], earned)
        self.assertEqual(self.run_play('state', uid='B')[1]['state']['dust'], 0)

    def test_rear_tactic_uses_server_preview_and_falls_back_to_front(self):
        contract = dict(id='gryphon', name='Грифон', tier=2, reward=4)
        self.seed(contract=contract, owned={'WIT_C01':1, 'WIT_C02':1},
                  deck=['WIT_C01',None,None,'WIT_C02',None,None])
        status, out = self.run_play('start-hunt', 1, contract=contract['id'])
        self.assertEqual((status, out['huntTarget'], out['state']['fight']['monster']['tactic']), (200, 3, 'rear'))
        fight = out['state']['fight']
        fight['monster']['hp'] = 999
        fight['units'][3]['hp'] = 1
        saved = {**out['state'], 'fight':fight}
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('UPDATE players SET state=? WHERE uid=?', (json.dumps(saved), 'A'))
        status, next_round = self.run_play('strike', 2, contract=contract['id'], turn=0)
        self.assertEqual((status, next_round['strike']['events'][-1]['slot'], next_round['huntTarget']), (200, 3, 0))
        self.assertEqual(self.run_play('state')[1]['huntTarget'], 0)
        _, last = self.run_play('strike', 3, contract=contract['id'], turn=1)
        self.assertEqual(last['strike']['events'][-1]['slot'], 0)

    def test_season_boundary_resets_only_seasonal_state_and_fences_retries(self):
        before = game.seasons.calendar(100000)[1] - 1
        after = before + 1
        self.seed(owned={'WIT_C01': 2}, dust=44, coins=8, spins=13, rewardSpins=3,
                  boostInventory={'draw': 2}, activeBoosts={'shuffle': 3},
                  profile={'name': 'Ночной охотник', 'frame': 'ivy'}, earnedFrames=['ivy'],
                  contractsCompleted=5, deck=['WIT_C01']+[None]*5)
        _, draw = self.run_play('draw', 90, 1, now=before)
        self.assertGreater(draw['state']['influence'], 0)
        self.assertTrue(draw['state']['owned'])
        for step, op in enumerate((90, 91), 1):
            self.assertEqual(self.run_play('draw', op, 1, now=after, season='1970-01')[0], 409, step)
        def fetch(_):
            return self.run_play('state', now=after)[1]['state']
        with ThreadPoolExecutor(max_workers=3) as pool:
            rolled = list(pool.map(fetch, range(3)))
        for state in rolled:
            self.assertEqual((state['season'], state['owned'], state['influence']), ('1970-02', {}, 0))
            self.assertNotIn('deck', state)
            self.assertNotIn('contract', state)
            self.assertNotIn('fight', state)
            for key in ('coins','dust','spins','rewardSpins','boostInventory','activeBoosts',
                        'profile','earnedFrames','contractsCompleted'):
                self.assertEqual(state[key], draw['state'][key])
        self.assertEqual(self.run_play('draw', 92, 1, now=after, season='1970-02')[1]['state']['influence'] >= 1, True)
        self.assertEqual(self.run_play('draw', 90, 1, now=after)[0], 409)

    def test_inactive_legacy_players_roll_in_public_projection_at_midnight(self):
        legacy = dict(freeSpins=5, freeNextAt=0, coins=42, dust=2, lastBreak=0,
                      owned={'WIT_C01':3}, influence=30, profile={'name':'Искатель'})
        end = game.seasons.calendar(100000)[1]
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('INSERT INTO players VALUES (?,?)', ('B', json.dumps(legacy)))
            project = lambda now: game.standings(db, now, lambda uid: uid.lower(), 'a', lambda uid: True)[1]
            self.assertEqual(project(end-1)['rows'][0]['influence'], 30)
            self.assertEqual(project(end)['rows'][0]['influence'], 0)
            public = game.standings(db, end, str.lower, 'a', lambda uid: True, 'b')[1]
            self.assertEqual((public['cards'], public['name']), (0, 'Искатель'))
            self.assertEqual(set(public) & {'coins','owned','premiumUntil','state','uid'}, set())
        state = self.run_play('state', uid='B', now=end)[1]['state']
        self.assertEqual((state['coins'], state['owned'], state['influence']), (42, {}, 0))

    def test_rank_order_and_authenticated_public_profile(self):
        now = int(time.time())
        self.run_play('draw', size=10, uid='tg:1', now=now)
        self.run_play('state', uid='tg:2', now=now)
        self.run_play('draw', size=10, uid='tg:3', now=now)
        with closing(sqlite3.connect(self.path)) as db, db:
            for sid, uid in [('first', 'tg:1'), ('second', 'tg:2'), ('removed', 'tg:3')]:
                db.execute('INSERT INTO play_sessions VALUES (?,?,?)',
                           (hashlib.sha256(sid.encode()).hexdigest(), uid, now+60))
        with game.ThreadingHTTPServer(('127.0.0.1', 0), game.Play) as server:
            server.db, server.telegram, server.token, server.allowed = self.path, True, 'fake-token', {1, 2}
            worker = Thread(target=server.serve_forever, daemon=True)
            worker.start()
            def get(path, sid=''):
                with closing(HTTPConnection(*server.server_address, timeout=3)) as conn:
                    conn.request('GET', path, headers={'Cookie':f'__Host-grim-play={sid}'})
                    res = conn.getresponse()
                    return res.status, json.loads(res.read())
            try:
                self.assertEqual(get('/api/top')[0], 401)
                self.assertEqual(get('/api/top', 'removed')[0], 401)
                status, top = get('/api/top', 'second')
                rows = top['rows']
                self.assertEqual((status, len(rows), [p['rank'] for p in rows]), (200, 2, [1, 2]))
                self.assertGreaterEqual(rows[0]['influence'], 10)
                self.assertEqual((rows[1]['influence'], rows[1]['id']), (0, top['me']))
                self.assertEqual(set(rows[0]), {'id','rank','name','avatar','frame','universe','influence'})
                status, other = get('/api/profile/'+rows[0]['id'], 'second')
                self.assertEqual((status, other['rank'], other['arenaWins']), (200, 1, 0))
                self.assertFalse(set(other) & {'mine','premiumUntil','coins','owned','uid','avatars'})
                status, own = get('/api/profile/me', 'second')
                self.assertEqual((status, own['id'], own['mine'], own['premiumUntil']), (200, top['me'], True, None))
                self.assertEqual(get('/api/profile/'+'0'*24, 'second')[0], 404)
            finally:
                server.shutdown()
                worker.join()

    def test_signed_telegram_defaults_and_durable_custom_profile(self):
        token = 'fixture-token'
        photo = 'https://t.me/i/userpic/320/grimdeck-fixture.jpg'
        user = dict(id=1, first_name='  Анна ', last_name='Волкова', username='fixture', photo_url=photo,
                    language_code='ru')
        def sign(telegram_user):
            fields = dict(auth_date=str(int(time.time())), user=json.dumps(telegram_user))
            check = '\n'.join(f'{k}={v}' for k, v in sorted(fields.items())).encode()
            secret = hmac.digest(b'WebAppData', token.encode(), 'sha256')
            return urlencode(dict(fields, hash=hmac.digest(secret, check, 'sha256').hex()))

        with game.ThreadingHTTPServer(('127.0.0.1', 0), game.Play) as server:
            server.db, server.telegram, server.token, server.allowed = self.path, True, token, {1, 2}
            server.origin = 'https://game.example.invalid'
            self.addCleanup(server.shutdown)
            Thread(target=server.serve_forever, daemon=True).start()
            def request(path, payload=None, cookie=''):
                with closing(HTTPConnection(*server.server_address, timeout=3)) as conn:
                    conn.request('GET' if payload is None else 'POST', '/api/'+path,
                                 None if payload is None else json.dumps(payload),
                                 {'Origin':server.origin,'Content-Type':'application/json','Cookie':cookie})
                    res = conn.getresponse()
                    return res.status, json.loads(res.read()), (res.getheader('Set-Cookie') or '').split(';')[0]

            valid = sign(user)
            self.assertEqual(request('session', dict(initData=valid.replace('fixture', 'edited')))[0], 401)
            self.assertEqual(request('session', dict(initData=valid.split('&hash=')[0]))[0], 401)
            self.assertEqual(request('session', dict(initData=sign(dict(user, id=3))))[0], 401)
            status, session, cookie = request('session', dict(initData=valid))
            self.assertEqual((status, set(session)), (200, {'player'}))
            status, own, _ = request('profile/me', cookie=cookie)
            self.assertEqual((status, own['name'], own['avatar'], own['telegramAvatar']), (200, 'Анна Волкова', photo, photo))
            top = request('top', cookie=cookie)[1]
            self.assertEqual((top['rows'][0]['name'], top['rows'][0]['avatar']), ('Анна Волкова', photo))
            defaults = request('state', cookie=cookie)[1]['state']['telegramProfile']
            self.assertEqual(defaults, dict(name='Анна Волкова', avatar=photo))
            _, _, other_cookie = request('session', dict(initData=sign(dict(id=2))))
            other_own = request('profile/me', cookie=other_cookie)[1]
            self.assertTrue(other_own['name'].startswith('Искатель '))
            self.assertEqual(other_own['avatar'], 'wolf')
            other_view = request('profile/'+session['player'], cookie=other_cookie)[1]
            self.assertTrue(other_view['name'].startswith('Искатель '))
            self.assertEqual(other_view['avatar'], 'wolf')
            self.assertNotIn('telegramAvatar', other_view)
            other_top = request('top', cookie=other_cookie)[1]
            self.assertNotIn('Анна Волкова', str(other_top))
            self.assertNotIn(photo, str(other_top))
            for index, params in enumerate([dict(name='Белый Волк'), dict(avatar='moon'), dict(frame='steel')]):
                payload = dict(op=f'fixture-profile-{index:03}', size=0, **params)
                status, out, _ = request('edit-profile', payload, cookie)
                self.assertEqual(status, 200)
                self.assertEqual({key: out['profileIdentity'][key] for key in params}, params)
                self.assertEqual(request('edit-profile', payload, cookie)[1]['profileIdentity'], out['profileIdentity'])
            _, _, cookie = request('session', dict(initData=sign(dict(user, first_name='Трисс'))))
            own = request('profile/me', cookie=cookie)[1]
            self.assertEqual((own['name'], own['avatar'], own['frame']), ('Белый Волк', 'moon', 'steel'))
            other_view = request('profile/'+session['player'], cookie=other_cookie)[1]
            self.assertEqual((other_view['name'], other_view['avatar'], other_view['frame']), ('Белый Волк', 'moon', 'steel'))
            reset = request('edit-profile', dict(op='fixture-profile-reset', size=0, avatar='telegram'), cookie)
            self.assertEqual((reset[0], reset[1]['profileIdentity']['avatar']), (200, photo))
            _, _, cookie = request('session', dict(initData=sign(dict(user, photo_url='https://t.me.example.invalid/i/userpic/x'))))
            own = request('profile/me', cookie=cookie)[1]
            self.assertEqual((own['name'], own['avatar'], own['telegramAvatar']), ('Белый Волк', 'wolf', None))

    def test_telegram_identity_optional_fields_and_photo_rules(self):
        normalize = game.seasons.telegram_identity
        self.assertEqual(normalize(dict(id=1)), {})
        self.assertEqual(normalize(dict(first_name='  ', username='player_1')), {'name':'player_1'})
        url = 'https://cdn4.telegram-cdn.org/file/grimdeck-fixture.png'
        self.assertEqual(normalize(dict(photo_url=url)), {'avatar':url})
        for bad in ('http://t.me/i/userpic/320/x', 'https://t.me/i/userpic/../x', 'https://t.me:443/i/userpic/x',
                    'https://t.me@other.invalid/i/userpic/x', 'https://t.me/i/userpic/x#fragment', 'https://t.me/somebody'):
            with self.subTest(bad=bad):
                self.assertEqual(normalize(dict(photo_url=bad)), {})

    def test_profile_permissions_and_idempotent_edit(self):
        self.seed(influence=99)
        self.assertEqual(self.run_play('edit-profile', name='x')[0], 400)
        self.assertEqual(self.run_play('edit-profile', avatar='https://example.invalid/avatar.png')[0], 400)
        self.assertEqual(self.run_play('edit-profile', frame='eclipse')[0], 400)
        self.assertEqual(self.run_play('edit-profile', frame='ember')[0], 400)
        self.assertEqual(self.run_play('draw', 2, 1)[0], 200)
        status, out = self.run_play('edit-profile', frame='ember')
        self.assertEqual((status, out['state']['profile']['frame']), (200, 'ember'))
        self.assertEqual(self.run_play('edit-profile', frame='ember'), (status, out))
        self.assertEqual(self.run_play('edit-profile', frame='steel')[0], 409)
        status, out = self.run_play('edit-profile', 3, name='  Белый   Волк  ')
        self.assertEqual((status, out['state']['profile']['name']), (200, 'Белый Волк'))
        status, out = self.run_play('edit-profile', 4, avatar='moon')
        self.assertEqual((status, out['state']['profile']['avatar']), (200, 'moon'))
        self.assertNotIn('profile', self.run_play('state', uid='B')[1]['state'])

    def test_contract_influence_only_for_victory_and_once(self):
        contract = dict(id='hunt-fixture', name='Грифон', tier=2, reward=4)
        fight = dict(id=contract['id'], turn=0, status='active', monster={**contract,'hp':1,'atk':2},
                     units=[dict(id='WIT_C01', atk=1, hp=1)]+[None]*5)
        self.seed(contract=contract, fight=fight)
        status, out = self.run_play('strike', contract=contract['id'], turn=0)
        self.assertEqual((status, out['state']['influence'], out['state']['contractsCompleted']), (200, 10, 1))
        self.assertEqual(self.run_play('strike', contract=contract['id'], turn=0), (status, out))
        self.assertEqual(self.run_play('strike', 2, contract=contract['id'], turn=0)[0], 409)
        with closing(sqlite3.connect(self.path)) as db, db:
            profile = game.standings(db, 100000, str.lower, 'other', lambda uid: True, 'a')[1]
        self.assertEqual((profile['arenaWins'], profile['contracts']), (0, 1))

    def test_batches_and_multiple_daily_rewards_once(self):
        board = dict(day=1, resetsAt=2*game.DAY-game.hunts.MOSCOW, notices=[
            dict(id='a', kind='craft', goal=1, progress=0, reward=2),
            dict(id='b', kind='craft', goal=4, progress=0, reward=3),
            dict(id='c', kind='draw', goal=6, progress=0, reward=4),
            dict(id='d', kind='break', goal=2, progress=0, reward=2),
        ])
        self.seed(board=board, dust=50, spins=10)
        status, out = self.run_play('craft', 1, 1, quantity=4)
        self.assertEqual((status, out['state']['coins'], out['questRewards']),
                         (200, 12, [dict(id='a', coins=2), dict(id='b', coins=3)]))
        self.assertEqual(out['state']['influence'], 10)
        self.assertEqual(self.run_play('craft', 1, 1, quantity=4), (status, out))
        craft = self.run_play('craft', 2, 1)[1]
        self.assertEqual((craft['questRewards'], craft['state']['influence']), ([], 10))
        draw = self.run_play('draw', 3, 10)[1]
        self.assertEqual((draw['questRewards'], draw['state']['influence']), ([dict(id='c', coins=4)], 25))
        first_shuffle = self.run_play('break', 4)[1]
        self.assertEqual((first_shuffle['questRewards'], first_shuffle['state']['influence']), ([], 25))
        second_shuffle = self.run_play('break', 5, now=107200)[1]
        self.assertEqual((second_shuffle['questRewards'], second_shuffle['state']['influence']),
                         ([dict(id='d', coins=2)], 30))
        self.assertEqual(self.run_play('state', now=107200)[1]['state']['coins'], 18)

    def test_hunt_validation_snapshot_parallel_strike_and_reward(self):
        strongest = max(game.CARDS, key=lambda cid:game.CARDS[cid][3])
        self.seed(owned={strongest:3})
        board = self.run_play('state')[1]['state']['board']
        a, b = [q for q in board['notices'] if q['kind']=='hunt']
        contract = a['id']
        self.assertEqual(self.run_play('take-contract', 1, contract=contract)[0], 200)
        self.assertEqual(self.run_play('start-hunt', 2, contract=contract)[0], 409)
        for bad in ([None]*5, ['WIT_X00']+[None]*5, [strongest]*6, [{}]+[None]*5):
            self.assertEqual(self.run_play('save-deck', 3, slots=bad)[0], 400)
        slots = [None]*3+[strongest]+[None]*2
        self.assertEqual(self.run_play('save-deck', 4, slots=slots)[0], 200)
        self.assertEqual(self.run_play('save-deck', 4, slots=[None]*6)[0], 409)
        _, out = self.run_play('start-hunt', 5, contract=contract)
        self.assertEqual(out['state']['fight']['units'][3]['atk'], game.CARDS[strongest][3])
        self.assertEqual(self.run_play('save-deck', 6, slots=[None]*6)[0], 200)
        self.assertEqual(self.run_play('start-hunt', 7, contract=contract)[0], 409)
        self.assertEqual(self.run_play('strike', 8, contract=contract, turn=True)[0], 400)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda n:self.run_play('strike', n, contract=contract, turn=0), (9,10)))
        self.assertEqual(sorted(code for code, _ in results), [200,409])
        last = next(out for code, out in results if code==200)
        self.assertEqual(self.run_play('state')[1]['state']['fight'], last['state']['fight'])
        if last['state']['fight']['status']=='active':
            self.assertEqual(last['strike']['events'][-1]['slot'], 3)
            _, last = self.run_play('strike', 11, contract=contract, turn=1)
        self.assertEqual(last['state']['fight']['status'], 'won')
        self.assertEqual(last['state']['coins'], 7+a['reward'])
        self.assertIsNone(last['state']['contract'])
        self.assertEqual(self.run_play('strike', 12, contract=contract, turn=0)[0], 409)
        self.assertEqual(self.run_play('state')[1]['state']['coins'], 7+a['reward'])
        self.assertEqual(self.run_play('take-contract', 13, contract=contract)[0], 409)
        self.assertEqual(self.run_play('take-contract', 14, contract=b['id'])[0], 200)

    def test_strikes_front_first_and_third_round_win_or_loss(self):
        for hp, status in [(9, 'won'), (10, 'lost')]:
            with self.subTest(hp=hp):
                contract = dict(id='a', name='Волк альфа', tier=1, reward=3)
                monster = {**contract, 'hp':hp, 'maxHp':hp, 'atk':1}
                front = dict(id='WIT_C01', atk=2, hp=1, maxHp=1)
                rear = dict(id='WIT_C02', atk=3, hp=4, maxHp=4)
                fight = dict(id='a', status='active', turn=0, monster=monster,
                             units=[front, None, None, rear, None, None])
                # Total attack: 4 + 3 + 3 = 10.
                fight['monster']['hp'] = hp+1
                state = dict(owned={}, contract=contract, fight=fight, coins=7)
                for turn in range(3):
                    self.assertEqual(fight['status'], 'active')
                    code, result = game.hunts.action(state, game.CARDS, 'strike', {'contract':'a','turn':turn})
                    self.assertEqual(code, 200)
                    if turn<2:
                        self.assertEqual(result['strike']['events'][-1]['slot'], [0,3][turn])
                self.assertEqual(fight['status'], status)
                self.assertIsNone(state['contract'])
                self.assertEqual(state['coins'], 10 if status=='won' else 7)
