"""Playable GrimDeck, separate from the welcome demo."""
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time

import hunts
import seasons

try:
    import psycopg
except ImportError:  # The local SQLite demo has no external dependencies.
    psycopg = None

DB_ERRORS = (sqlite3.Error,) + ((psycopg.Error,) if psycopg else ())


def postgres(db):
    return psycopg is not None and isinstance(db, psycopg.Connection)


def execute(db, sql, args=()):
    return db.execute(sql.replace("?", "%s") if postgres(db) else sql, args)


def connect(target):
    if isinstance(target, str) and target.startswith(("postgresql://", "postgres://")):
        if not psycopg:
            raise RuntimeError("PostgreSQL driver missing")
        return psycopg.connect(target, connect_timeout=10, prepare_threshold=None)
    return sqlite3.connect(target)
from contextlib import closing
from datetime import datetime, timezone
from itertools import accumulate
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from server import Handler, ThreadingHTTPServer, SimpleCookie, CookieError, signed_launch

WEB = Path(__file__).resolve().parent / 'play'
ROOT = WEB.parents[1]
CATALOG = json.loads((ROOT/'cards.js').read_text().split('=',1)[1].strip().removesuffix(';'))
CARDS = {c[0]:c for c in CATALOG}
POOLS = {r:[c[0] for c in CATALOG if c[0][4]==r] for r in 'CRELM'}
DAY = 86400
SHUFFLE_COOLDOWN = 2 * 3600
# Weights are in basis points. The remainder of the roll awards ordinary dust.
SHUFFLE_BONUSES = {'dust2': 1000, 'spins': 500, 'dust10': 300, 'legendary': 50, 'mythic': 5}
FREE_INTERVAL = 3 * 3600
MAX_FREE_SPINS = 5
HISTORY_PAGE_SIZE = 20
REFERRAL_SPINS = 5
PACK_SIZES = (1, 10, 50)
GRANT_SIZES = (10, 50)
MAX_TEST_SPINS = 500
TEST_ACTIONS = {'grant': GRANT_SIZES, 'clear-collection': (0,), 'reset-shuffle': (0,),
                'clear-dust': (0,), 'renew-board': (0,)}
# Recipe IDs are stable: the operation journal also uses them on retries.
CRAFT_RECIPES = {
    1: dict(material='dust', cost=10, spins=1),
    2: dict(material='C', cost=10, spins=2),
    3: dict(material='R', cost=10, spins=3),
    4: dict(material='E', cost=10, spins=5),
    5: dict(material='L', cost=5, spins=5),
    6: dict(material='M', cost=1, spins=10),
    7: dict(material='dust', cost=100, boost='draw'),
    8: dict(material='dust', cost=150, boost='shuffle'),
    9: dict(material='dust', cost=200, boost='arena'),
    10: dict(material='dust', cost=200, boost='arenaHealth'),
}
MAX_CRAFT_BATCH = 99
BOOST_USES = {7: 10, 8: 4}
# Basis points per individual spin. The draw rune adds 50% to L/M, paid by C.
DRAW_WEIGHTS = dict(C=5900, R=2700, E=950, L=400, M=50)
BOOSTED_DRAW_WEIGHTS = {**DRAW_WEIGHTS, 'L': DRAW_WEIGHTS['L'] * 3 // 2, 'M': DRAW_WEIGHTS['M'] * 3 // 2}
BOOSTED_DRAW_WEIGHTS['C'] -= sum(BOOSTED_DRAW_WEIGHTS.values()) - 10000
DRAW_THRESHOLDS = tuple(accumulate(DRAW_WEIGHTS.values()))
BOOSTED_DRAW_THRESHOLDS = tuple(accumulate(BOOSTED_DRAW_WEIGHTS.values()))
ACTION_SIZES = {'draw': PACK_SIZES, 'break': (0,), 'craft': tuple(CRAFT_RECIPES),
                'activate-boost': tuple(BOOST_USES), 'edit-profile': (0,),
                **TEST_ACTIONS, **dict.fromkeys(hunts.ACTIONS, (0,))}


def schema(db, *, now=None):
    statements = '''CREATE TABLE IF NOT EXISTS play_sessions (digest TEXT PRIMARY KEY, uid TEXT, expires INTEGER);
        CREATE TABLE IF NOT EXISTS players (uid TEXT PRIMARY KEY, state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operations (uid TEXT, op TEXT, kind TEXT, size INTEGER, result TEXT,
        PRIMARY KEY(uid,op));
        CREATE INDEX IF NOT EXISTS successful_draws ON operations (uid,op) WHERE kind='draw';
        CREATE TABLE IF NOT EXISTS draw_receipt_order (uid TEXT NOT NULL, op TEXT NOT NULL,
        position BIGINT NOT NULL, drawn_at BIGINT NOT NULL, PRIMARY KEY(uid,op), UNIQUE(uid,position));
        CREATE TABLE IF NOT EXISTS referral_codes (uid TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL);
        CREATE TABLE IF NOT EXISTS referrals (invitee TEXT PRIMARY KEY, inviter TEXT NOT NULL,
        earned INTEGER NOT NULL DEFAULT 0, applied INTEGER NOT NULL DEFAULT 0, CHECK(invitee<>inviter));
        CREATE INDEX IF NOT EXISTS referrals_by_inviter ON referrals (inviter,earned,applied);
        CREATE TABLE IF NOT EXISTS season_config (id INTEGER PRIMARY KEY, baseline TEXT NOT NULL);'''
    for statement in statements.split(';'):
        if statement.strip():
            db.execute(statement)
    baseline, _ = seasons.calendar(int(time.time()) if now is None else now)
    # Legacy players belong to the launch season even if they don't log in before rollover.
    execute(db, 'INSERT INTO season_config VALUES (1,?) ON CONFLICT(id) DO NOTHING', (baseline,))
    db.commit()


def spin_history(db, uid, offset):
    # Both totals and the page use one database snapshot, including on PostgreSQL.
    rows = execute(db, '''WITH totals AS (
        SELECT COUNT(*) AS openings, COALESCE(SUM(size), 0) AS spins FROM operations
        WHERE uid=? AND kind='draw'
    ), page AS (
        SELECT o.op, o.size, o.result, d.position, d.drawn_at FROM operations o
        LEFT JOIN draw_receipt_order d ON d.uid=o.uid AND d.op=o.op
        WHERE o.uid=? AND o.kind='draw'
        ORDER BY (d.position IS NULL), d.position DESC, o.op
        LIMIT ? OFFSET ?
    )
    SELECT totals.openings, totals.spins, page.size, page.result, page.drawn_at FROM totals
    LEFT JOIN page ON 1=1 ORDER BY (page.position IS NULL), page.position DESC, page.op''',
                   (uid, uid, HISTORY_PAGE_SIZE, offset)).fetchall()
    openings, total = rows[0][:2]
    entries = []
    for _, _, size, receipt, at in rows:
        if receipt is not None:
            result = json.loads(receipt)
            # Old IDs give a stable fallback for pagination, not a historical chronology.
            entries.append(dict(size=size, cards=result['cards'], at=at, season=result.get('receiptSeason')))
    end = offset + len(entries)
    return dict(total=total, openings=openings, entries=entries, next=end if end < openings else None)


def referral_app_url(raw):
    base = raw.strip().rstrip('/')
    if base and not re.fullmatch(r'https://t\.me/[A-Za-z0-9_]+(?:/[A-Za-z0-9_]+)?', base):
        raise SystemExit('GRIM_TELEGRAM_APP_URL must be https://t.me/<bot>[/<app>] without query or fragment')
    return base or None


def referral_info(db, uid, app_url):
    url = None
    if app_url:
        while True:
            row = execute(db, 'SELECT code FROM referral_codes WHERE uid=?', (uid,)).fetchone()
            if row:
                url = f'{app_url}?startapp={row[0]}'
                break
            execute(db, 'INSERT INTO referral_codes VALUES (?,?) ON CONFLICT DO NOTHING',
                    (uid, secrets.token_urlsafe(18)))
    count = execute(db, 'SELECT COUNT(*) FROM referrals WHERE inviter=? AND earned=1', (uid,)).fetchone()[0]
    return dict(url=url, count=count)


def first_season(db):
    return execute(db, 'SELECT baseline FROM season_config WHERE id=1').fetchone()[0]


def avatars():
    return (*seasons.SIGILS, *(cid for cid in CARDS if (WEB/'art'/f'{cid}.webp').is_file()))


def standings(db, now, key_for, me, include, requested=None):
    season, ends = seasons.calendar(now)
    baseline = first_season(db)
    rows = []
    telegram_avatar = None
    for uid, saved in execute(db, 'SELECT uid,state FROM players'):
        if not include(uid):
            continue
        state = json.loads(saved)
        key = key_for(uid)
        rows.append(seasons.profile(state, key, CARDS, seasons.current(state, season, baseline), mine=key == me))
        if requested and key == me:
            telegram_avatar = state.get('telegramProfile', {}).get('avatar')
    rows.sort(key=lambda row: (-row['influence'], row['id']))
    for rank, row in enumerate(rows, 1):
        row['rank'] = rank
    if requested:
        row = next((row for row in rows if row['id'] == (me if requested == 'me' else requested)), None)
        if not row:
            return 404, {'error': 'Профиль не найден'}
        if row['id'] == me:
            # No premium entitlement source exists in the current build.
            row.update(mine=True, premiumUntil=None, avatars=avatars(), frames=seasons.FRAMES,
                       telegramAvatar=telegram_avatar)
        return 200, row
    fields = ('id', 'name', 'avatar', 'frame', 'universe', 'influence', 'rank')
    return 200, dict(season=season, endsAt=ends, rules=[seasons.SPIN_INFLUENCE, seasons.TASK_INFLUENCE,
                                                        seasons.CONTRACT_INFLUENCE],
                     rows=[{key: row[key] for key in fields} for row in rows], me=me)


def refill_free_spins(state, now):
    next_at = state['freeNextAt']
    if next_at and now >= next_at:
        earned = 1 + (now - next_at) // FREE_INTERVAL
        state['freeSpins'] = min(MAX_FREE_SPINS, state['freeSpins'] + earned)
        state['freeNextAt'] = 0 if state['freeSpins'] == MAX_FREE_SPINS else next_at + earned * FREE_INTERVAL


def play(db, uid, kind, data, bonus, now=None, *, telegram_defaults=None, start_param=None, allowed=()):
    # Take the season timestamp under the lock, not while the request is waiting.
    if postgres(db):
        execute(db, 'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', (uid,))
    else:
        db.execute('BEGIN IMMEDIATE')
    if now is None:
        now = int(time.time())
    season, ends = seasons.calendar(now)
    baseline = first_season(db)
    row = execute(db,'SELECT state FROM players WHERE uid=?',(uid,)).fetchone()
    state = json.loads(row[0]) if row else dict(freeSpins=MAX_FREE_SPINS, freeNextAt=0, spins=0, coins=bonus, dust=0, lastBreak=0, owned={})
    needs_save = not row or state.get('season') != season or 'freeSpins' not in state
    seasons.roll(state, season, baseline)
    if telegram_defaults is not None and telegram_defaults != state.get('telegramProfile', {}):
        if telegram_defaults:
            state['telegramProfile'] = telegram_defaults
        else:
            state.pop('telegramProfile', None)
        needs_save = True
    state.setdefault('spins', 0)
    state.setdefault('influence', 0)
    state.setdefault('contractsCompleted', 0)

    def save():
        for (invitee,) in pending_rewards:
            execute(db, 'UPDATE referrals SET applied=1 WHERE invitee=?', (invitee,))
        execute(db, 'INSERT INTO players VALUES (?,?) ON CONFLICT(uid) DO UPDATE SET state=excluded.state',
                (uid, json.dumps(state)))

    if 'freeSpins' not in state:
        day = datetime.fromtimestamp(now, timezone.utc).date().isoformat()
        used = state.pop('used', 0)
        free = MAX_FREE_SPINS - used if state.pop('day', None) == day else MAX_FREE_SPINS
        state.update(freeSpins=free, freeNextAt=now + FREE_INTERVAL if free < MAX_FREE_SPINS else 0)
    seasons.unlock(state, CARDS)
    refill_free_spins(state, now)
    utc_day = now // DAY
    shuffles = state.get('shuffleCount', 0) if state.get('shuffleDay') == utc_day else 0
    state.setdefault('rewardSpins', 0)
    if not row and telegram_defaults is not None and re.fullmatch(r'[A-Za-z0-9_-]{24}', start_param or ''):
        candidate = execute(db, 'SELECT uid FROM referral_codes WHERE code=?', (start_param,)).fetchone()
        if candidate and candidate[0] != uid and candidate[0].startswith('tg:') and int(candidate[0][3:]) in allowed:
            execute(db, 'INSERT INTO referrals (invitee,inviter) VALUES (?,?) ON CONFLICT(invitee) DO NOTHING',
                    (uid, candidate[0]))
    # Only this player's transaction can settle these events, under its existing lock.
    # A reward earned concurrently but absent from this snapshot is left for next time.
    pending_rewards = execute(db, 'SELECT invitee FROM referrals WHERE inviter=? AND earned=1 AND applied=0',
                              (uid,)).fetchall()
    if pending_rewards:
        state['rewardSpins'] += REFERRAL_SPINS * len(pending_rewards)
        needs_save = True
    inventory = state.setdefault('boostInventory', {})
    active = state.setdefault('activeBoosts', {})
    if hunts.rename_saved_monsters(state):
        needs_save = True
    hunts.board_for(state, uid, now)

    def reply():
        return dict(state=state, now=now, shuffleReadyAt=state['lastBreak'] + SHUFFLE_COOLDOWN if state['lastBreak'] else 0,
                    shuffleMastery=dict(count=shuffles, level=min(4, shuffles + 1), resetsAt=(utc_day + 1) * DAY,
                                        weights=SHUFFLE_BONUSES), craftRecipes=CRAFT_RECIPES,
                    maxCraftBatch=MAX_CRAFT_BATCH, huntTarget=hunts.counter_target(state.get('fight')),
                    seasonEndsAt=ends, spinInfluence=seasons.SPIN_INFLUENCE,
                    drawOdds=dict(base=DRAW_WEIGHTS, boosted=BOOSTED_DRAW_WEIGHTS),
                    huntPortraits=hunts.PORTRAITS, legacyHuntStats=hunts.MONSTER_STATS,
                    contractTactic=hunts.tactic(state['contract']['name']) if state.get('contract') else None)

    def spend_boost(boost, units):
        left = active.get(boost, 0)
        used = min(left, units)
        if used == left:
            active.pop(boost, None)
        else:
            active[boost] = left - used
        return used

    if kind == 'state':
        if needs_save:
            save()
        db.commit()
        return 200, reply()
    op, size = data.get('op'), data.get('size', 0)
    if not isinstance(op,str) or not re.fullmatch(r'[a-zA-Z0-9-]{16,64}',op):
        return 400, {'error':'Некорректный номер операции'}
    if type(size) is not int or size not in ACTION_SIZES.get(kind, ()):
        return 400, {'error':'Некорректный размер пакета'}
    quantity = data.get('quantity', 1)
    if type(quantity) is not int or not 1 <= quantity <= (MAX_CRAFT_BATCH if kind == 'craft' else 1):
        return 400, {'error': 'Некорректное количество'}
    params = {hunts.ACTIONS[kind]: data.get(hunts.ACTIONS[kind])} if kind in hunts.ACTIONS else {}
    if kind == 'edit-profile':
        params = {key: data[key] for key in ('name', 'avatar', 'frame') if key in data}
    if kind == 'strike':
        params['contract'] = data.get('contract')
        if type(params['turn']) is not int:
            return 400, {'error': 'Некорректный номер хода'}
    old = execute(db,'SELECT kind,size,result FROM operations WHERE uid=? AND op=?',(uid,op)).fetchone()
    if old:
        # Legacy craft results describe a single recipe execution.
        result = json.loads(old[2])
        old_season = result.pop('receiptSeason', baseline)
        old_params = result.get('profileParams', result.get('huntParams', {}))
        if old[:2] != (kind,size) or result.get('craftedQuantity', 1) != quantity or old_params != params:
            return 409, {'error':'Операция уже использована'}
        if old_season != season:
            return 409, {'error': 'Операция уже завершена в прошлом сезоне'}
        if pending_rewards:
            save()
            db.commit()
        return 200, {**reply(),**result}
    if data.get('season', season) != season:
        return 409, {'error': 'Начался новый сезон. Повтори действие после обновления'}
    owned = state['owned']
    if kind == 'edit-profile':
        error = seasons.edit(state, params, avatars)
        if error:
            return 400, {'error': error}
        result = dict(profileParams=params)
    elif kind in hunts.ACTIONS:
        status, result = hunts.action(state, CARDS, kind, params)
        if status != 200:
            return status, result
        result['huntParams'] = params
    elif kind == 'draw':
        free = min(size,state['freeSpins'])
        reward = min(size-free,state['rewardSpins'])
        extra = min(size-free-reward,state['spins'])
        cost = size-free-reward-extra
        if cost > state['coins']:
            return 409, {'error':f"Не хватает монет: {cost-state['coins']}"}
        if free and not state['freeNextAt']:
            state['freeNextAt'] = now + FREE_INTERVAL
        state['freeSpins'] -= free; state['rewardSpins'] -= reward; state['spins'] -= extra; state['coins'] -= cost
        cards = []
        boosted = spend_boost('draw', size)
        for i in range(size):
            roll = secrets.randbelow(10000)
            thresholds = BOOSTED_DRAW_THRESHOLDS if i < boosted else DRAW_THRESHOLDS
            rarity = next(r for r, threshold in zip('CRELM', thresholds) if roll < threshold)
            cid = secrets.choice(POOLS[rarity]); qty = owned.get(cid,0)
            cards.append({'id':cid,'new':qty==0});owned[cid]=qty+1
        featured = max(range(size),key=lambda i:(cards[i]['new'],'CRELM'.index(cards[i]['id'][4])))
        result = dict(cards=cards,featured=featured,newCount=sum(c['new'] for c in cards))
    elif kind == 'craft':
        recipe = CRAFT_RECIPES[size]
        material, cost = recipe['material'], recipe['cost'] * quantity
        if material == 'dust':
            if state['dust'] < cost:
                return 409, {'error': 'Не хватает пыли'}
            state['dust'] -= cost
        else:
            # Spend the largest stacks first, using catalog IDs to break ties.
            copies = sorted(((cid, qty - 1) for cid, qty in owned.items()
                             if cid in CARDS and cid[4] == material and qty > 1),
                            key=lambda item: (-item[1], item[0]))
            if sum(qty for _, qty in copies) < cost:
                return 409, {'error': 'Не хватает повторок этой редкости'}
            for cid, qty in copies:
                take = min(qty, cost)
                owned[cid] -= take
                cost -= take
                if not cost:
                    break
        if 'spins' in recipe:
            state['rewardSpins'] += recipe['spins'] * quantity
        else:
            boost = recipe['boost']
            inventory[boost] = inventory.get(boost, 0) + quantity
        result = dict(crafted=size, craftedQuantity=quantity)
    elif kind == 'activate-boost':
        boost = CRAFT_RECIPES[size]['boost']
        if active.get(boost, 0):
            return 409, {'error': 'Такой усилитель уже активен'}
        if not inventory.get(boost, 0):
            return 409, {'error': 'Усилителя нет в инвентаре'}
        inventory[boost] -= 1
        active[boost] = BOOST_USES[size]
        result = dict(activated=boost)
    elif kind == 'grant':
        if state['spins']+size > MAX_TEST_SPINS:
            return 409, {'error':f'Лимит тестовых круток: {MAX_TEST_SPINS}'}
        state['spins'] += size
        result = dict(granted=size)
    elif kind == 'clear-collection':
        result = dict(removed=len(owned))
        state['owned'] = {}
        state['deck'] = [None] * 6
    elif kind == 'reset-shuffle':
        state['lastBreak'] = 0
        result = {}
    elif kind == 'clear-dust':
        result = dict(dustRemoved=state['dust'])
        state['dust'] = 0
    elif kind == 'renew-board':
        hunts.board_for(state, uid, now, renew=True)
        result = {}
    else:
        if state['lastBreak'] and now < state['lastBreak'] + SHUFFLE_COOLDOWN:
            return 409, {'error':'Перетасовка пока недоступна'}
        level = min(4, shuffles + 1) + spend_boost('shuffle', 1)
        base = 1 + secrets.randbelow(5)
        roll = secrets.randbelow(10000)
        bonus_kind = None
        for candidate, weight in SHUFFLE_BONUSES.items():
            roll -= weight * level
            if roll < 0:
                bonus_kind = candidate
                break
        gain = (base * {'dust2': 2, 'dust10': 10}.get(bonus_kind, 1)
                if bonus_kind in (None, 'dust2', 'dust10') else 0)
        result = dict(gain=gain, baseDust=base, bonus=bonus_kind, masteryUsed=level)
        if bonus_kind == 'spins':
            state['rewardSpins'] += 3
        elif bonus_kind in ('legendary', 'mythic'):
            cid = secrets.choice(POOLS['L' if bonus_kind == 'legendary' else 'M'])
            qty = owned.get(cid, 0)
            owned[cid] = qty + 1
            result['rewardCard'] = dict(id=cid, new=not qty)
        shuffles += 1
        state.update(dust=state['dust']+gain, lastBreak=now, shuffleDay=utc_day, shuffleCount=shuffles)
    if kind == 'draw':
        state['influence'] += size * seasons.SPIN_INFLUENCE
    if kind in ('draw', 'craft', 'break'):
        result['questRewards'] = hunts.progress(state, kind, size if kind == 'draw' else quantity)
        state['influence'] += len(result['questRewards']) * seasons.TASK_INFLUENCE
    if kind in ('strike', 'auto-hunt') and result.get('questRewards'):
        state['contractsCompleted'] += 1
        state['influence'] += seasons.CONTRACT_INFLUENCE
    seasons.unlock(state, CARDS)
    save()
    execute(db,'INSERT INTO operations VALUES (?,?,?,?,?)',
            (uid,op,kind,size,json.dumps({**result, 'receiptSeason': season})))
    if kind == 'draw':
        execute(db, '''INSERT INTO draw_receipt_order (uid,op,position,drawn_at)
                       SELECT ?,?,COALESCE(MAX(position),0)+1,? FROM draw_receipt_order WHERE uid=?''',
                (uid, op, now, uid))
        # The invitee is already locked. This writes no inviter state and commits with the draw receipt.
        execute(db, 'UPDATE referrals SET earned=1 WHERE invitee=? AND earned=0', (uid,))
    db.commit()
    return 200, {**reply(),**result}


class Play(Handler):
    def player_key(self, uid):
        return hmac.new(self.server.token.encode(), uid.encode(), "sha256").hexdigest()[:24]

    def response(self, status, data, cookie=None):
        self.send(status,json.dumps(data,ensure_ascii=False).encode(),'application/json; charset=utf-8',cookie)

    def do_GET(self):
        target = urlsplit(self.path)
        path = target.path
        files={'/':(WEB/'index.html','text/html; charset=utf-8'),'/play.css':(WEB/'play.css','text/css'),'/play.js':(WEB/'play.js','text/javascript'),'/draw-sound.js':(ROOT/'draw-sound.js','text/javascript'),'/cards.js':(ROOT/'cards.js','text/javascript')}
        files['/hunt.js'] = (WEB/'hunt.js', 'text/javascript')
        files['/season.js'] = (WEB/'season.js', 'text/javascript')
        files['/i18n.js'] = (WEB/'i18n.js', 'text/javascript')
        files['/settings.js'] = (WEB/'settings.js', 'text/javascript')
        if path == '/quest-complete.mp3':
            sound = WEB/'the_witcher_3_quests_completed_sound.mp3'
            if sound.is_file(): return self.send(200, sound.read_bytes(), 'audio/mpeg')
        if path in files:
            file,kind=files[path]; page=file.read_bytes()
            if path=='/' and not self.server.telegram:
                page=page.replace(b'<script defer src="https://telegram.org/js/telegram-web-app.js"></script>',b'').replace(b'data-mode="telegram"',b'data-mode="local"')
            return self.send(200,page,kind)
        if path=='/art/witcher-icon.png':
            file=WEB/'art'/'witcher icon.png'
            if file.is_file(): return self.send(200,file.read_bytes(),'image/png')
        if re.fullmatch(r'/art/(?:WIT_[CRELM][0-9]{2}|card-frame|GrimDeck_card_back)\.webp',path):
            file=WEB/'art'/path.rsplit('/',1)[1]
            if file.is_file(): return self.send(200,file.read_bytes(),'image/webp')
        if path=='/api/art': return self.response(200,[cid for cid in CARDS if (WEB/'art'/f'{cid}.webp').is_file()])
        if path=='/api/state': return self.api('state',{})
        if path=='/api/top': return self.api('top',{})
        if path=='/api/spin-history': return self.api('spin-history', {'query': target.query})
        if path=='/api/referral': return self.api('referral', {})
        if re.fullmatch(r'/api/profile/(?:me|[0-9a-f]{24})', path):
            return self.api('profile', {'id': path.rsplit('/', 1)[1]})
        self.response(404,{})

    def do_POST(self):
        if not self.path.startswith('/api/') or self.path[5:] not in ('session', *ACTION_SIZES): return self.response(404,{})
        if self.headers.get('Origin')!=self.server.origin: return self.response(403,{})
        try:
            n=int(self.headers.get('Content-Length','0'))
            if not 0<n<=16384 or self.headers.get_content_type()!='application/json': raise ValueError()
            data=json.loads(self.rfile.read(n));
            if not isinstance(data,dict): raise ValueError()
        except (ValueError, UnicodeError): return self.response(400,{})
        self.api(self.path.split('/')[-1],data)

    def api(self,kind,data):
        try:
            now=int(time.time()); secure=self.server.telegram
            name='__Host-grim-play' if secure else 'grim-local-play'
            jar=SimpleCookie(self.headers.get('Cookie','')); sid=jar[name].value if name in jar else ''
            digest=hashlib.sha256(sid.encode()).hexdigest()
            with closing(connect(self.server.db)) as db, db:
                row=execute(db,'SELECT uid FROM play_sessions WHERE digest=? AND expires>?',(digest,now)).fetchone()
                if kind=='session':
                    if secure:
                        user, start_param = signed_launch(data.get('initData'), self.server.token, self.server.allowed)
                        uid = 'tg:' + str(user['id'])
                        play(db, uid, 'state', {}, 3, telegram_defaults=seasons.telegram_identity(user),
                             start_param=start_param, allowed=self.server.allowed)
                    elif row: return self.response(200,{'player':self.player_key(row[0])})
                    else: uid='local:'+secrets.token_hex(16)
                    sid=secrets.token_urlsafe(32); ttl=3600 if secure else 30*DAY
                    execute(db,'DELETE FROM play_sessions WHERE expires<=?',(now,))
                    execute(db,'INSERT INTO play_sessions VALUES (?,?,?)',(hashlib.sha256(sid.encode()).hexdigest(),uid,now+ttl));db.commit()
                    flags='Secure; SameSite=None' if secure else 'SameSite=Strict'
                    return self.response(200,{'player':self.player_key(uid)},f'{name}={sid}; Path=/; HttpOnly; {flags}; Max-Age={ttl}')
                if not row or (secure and (not row[0].startswith('tg:') or int(row[0][3:]) not in self.server.allowed)):
                    return self.response(401,{'error':'Открой игру заново, чтобы войти'})
                # Only a current allowlisted Telegram session (or the loopback demo)
                # reaches play(), so grants always affect that tester's own account.
                uid = row[0]
                if kind == 'spin-history':
                    try:
                        offset, = parse_qs(data['query'], keep_blank_values=True, max_num_fields=32).get('offset', ['0'])
                        if not re.fullmatch(r'[0-9]{1,19}', offset) or int(offset) > 2**63-1:
                            raise ValueError()
                    except ValueError:
                        return self.response(400, {'error': 'Некорректное смещение'})
                    return self.response(200, spin_history(db, uid, int(offset)))
                if kind == 'referral':
                    if not secure:
                        return self.response(200, dict(url=None, count=0))
                    out = referral_info(db, uid, getattr(self.server, 'telegram_app_url', None))
                    db.commit()
                    return self.response(200, out)
                if kind in ('top', 'profile'):
                    def include(other):
                        return (other.startswith('tg:') and int(other[3:]) in self.server.allowed
                                if secure else other.startswith('local:'))
                    if data.get('id') == 'me':
                        play(db, uid, 'state', {}, 3 if secure else 120)
                    status, out = standings(db, int(time.time()), self.player_key, self.player_key(uid),
                                            include, data.get('id'))
                    return self.response(status, out)
                status,out=play(db,uid,kind,data,3 if secure else 120)
                if status == 200:
                    if kind == 'state':
                        out['canGrantSpins'] = True
                    elif kind == 'edit-profile':
                        out['profileIdentity'] = seasons.identity(out['state'], self.player_key(uid), mine=True)
                self.response(status,out)
        except (KeyError, ValueError, TypeError, CookieError): self.response(401,{'error':'Не удалось войти'})
        except DB_ERRORS: self.response(503,{'error':'Сохранение временно недоступно'})


def main():
    telegram=os.environ.get('GRIM_MODE')=='telegram'
    hosted=os.environ.get('RENDER')=='true'
    if hosted and not telegram: raise SystemExit('Render requires Telegram authentication')
    origin=(os.environ.get('GRIM_ORIGIN') or os.environ.get('RENDER_EXTERNAL_URL','')).rstrip('/') if telegram else 'http://127.0.0.1:8788'
    if telegram and not re.fullmatch(r'https://[a-zA-Z0-9.-]+(?::[0-9]+)?',origin): raise SystemExit('Требуется HTTPS-origin')
    token=os.environ['TELEGRAM_BOT_TOKEN'].strip() if telegram else ''
    allowed={int(u) for u in os.environ['GRIM_TEST_USERS'].split(',')} if telegram else set()
    if telegram and (not token or not allowed): raise SystemExit('Нужен токен и список тестировщиков')
    app_url = referral_app_url(os.environ.get('GRIM_TELEGRAM_APP_URL', '')) if telegram else None
    os.umask(0o077)
    if hosted:
        dbfile=os.environ.get('DATABASE_URL','')
        if not dbfile.startswith(('postgresql://','postgres://')): raise SystemExit('Render requires PostgreSQL')
        bind=('0.0.0.0',int(os.environ.get('PORT','10000')))
    else:
        folder=Path.home()/'.grimdeck';folder.mkdir(mode=0o700,exist_ok=True)
        dbfile=folder/('play-telegram.sqlite3' if telegram else 'play-local.sqlite3')
        bind=('127.0.0.1',8790 if telegram else 8788)
    with closing(connect(dbfile)) as db: schema(db)
    server=ThreadingHTTPServer(bind,Play)
    server.db,server.telegram,server.origin,server.token,server.allowed=dbfile,telegram,origin,token,allowed
    server.telegram_app_url = app_url
    server.serve_forever()

if __name__=='__main__': main()
