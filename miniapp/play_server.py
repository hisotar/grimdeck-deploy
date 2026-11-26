"""Playable GrimDeck, separate from the welcome demo."""
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time

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
from pathlib import Path
from urllib.parse import urlsplit
from server import Handler, ThreadingHTTPServer, SimpleCookie, CookieError, player_id

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
PACK_SIZES = (1, 10, 50)
GRANT_SIZES = (10, 50)
MAX_TEST_SPINS = 500
TEST_ACTIONS = {'grant': GRANT_SIZES, 'clear-collection': (0,), 'reset-shuffle': (0,)}
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
DRAW_THRESHOLDS = (34, 61, 82, 98, 100)
BOOSTED_DRAW_THRESHOLDS = (25, 52, 73, 97, 100)
ACTION_SIZES = {'draw': PACK_SIZES, 'break': (0,), 'craft': tuple(CRAFT_RECIPES),
                'activate-boost': tuple(BOOST_USES), **TEST_ACTIONS}


def schema(db):
    statements = '''CREATE TABLE IF NOT EXISTS play_sessions (digest TEXT PRIMARY KEY, uid TEXT, expires INTEGER);
        CREATE TABLE IF NOT EXISTS players (uid TEXT PRIMARY KEY, state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operations (uid TEXT, op TEXT, kind TEXT, size INTEGER, result TEXT,
        PRIMARY KEY(uid,op));'''
    for statement in statements.split(';'):
        if statement.strip():
            db.execute(statement)
    db.commit()


def refill_free_spins(state, now):
    next_at = state['freeNextAt']
    if next_at and now >= next_at:
        earned = 1 + (now - next_at) // FREE_INTERVAL
        state['freeSpins'] = min(MAX_FREE_SPINS, state['freeSpins'] + earned)
        state['freeNextAt'] = 0 if state['freeSpins'] == MAX_FREE_SPINS else next_at + earned * FREE_INTERVAL


def play(db, uid, kind, data, bonus, now):
    # Serialize mutations and the one-time migration of legacy balances.
    if postgres(db):
        execute(db, 'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', (uid,))
    else:
        db.execute('BEGIN IMMEDIATE')
    row = execute(db,'SELECT state FROM players WHERE uid=?',(uid,)).fetchone()
    state = json.loads(row[0]) if row else dict(freeSpins=MAX_FREE_SPINS, freeNextAt=0, spins=0, coins=bonus, dust=0, lastBreak=0, owned={})
    state.setdefault('spins', 0)
    if 'freeSpins' not in state:
        day = datetime.fromtimestamp(now, timezone.utc).date().isoformat()
        used = state.pop('used', 0)
        free = MAX_FREE_SPINS - used if state.pop('day', None) == day else MAX_FREE_SPINS
        state.update(freeSpins=free, freeNextAt=now + FREE_INTERVAL if free < MAX_FREE_SPINS else 0)
        execute(db,'UPDATE players SET state=? WHERE uid=?',(json.dumps(state),uid))
    refill_free_spins(state, now)
    utc_day = now // DAY
    shuffles = state.get('shuffleCount', 0) if state.get('shuffleDay') == utc_day else 0
    state.setdefault('rewardSpins', 0)
    inventory = state.setdefault('boostInventory', {})
    active = state.setdefault('activeBoosts', {})

    def reply():
        return dict(state=state, now=now, shuffleReadyAt=state['lastBreak'] + SHUFFLE_COOLDOWN if state['lastBreak'] else 0,
                    shuffleMastery=dict(count=shuffles, level=min(4, shuffles + 1), resetsAt=(utc_day + 1) * DAY,
                                        weights=SHUFFLE_BONUSES), craftRecipes=CRAFT_RECIPES,
                    maxCraftBatch=MAX_CRAFT_BATCH)

    def spend_boost(boost, units):
        left = active.get(boost, 0)
        used = min(left, units)
        if used == left:
            active.pop(boost, None)
        else:
            active[boost] = left - used
        return used

    if kind == 'state':
        return 200, reply()
    op, size = data.get('op'), data.get('size', 0)
    if not isinstance(op,str) or not re.fullmatch(r'[a-zA-Z0-9-]{16,64}',op):
        return 400, {'error':'Некорректный номер операции'}
    if type(size) is not int or size not in ACTION_SIZES.get(kind, ()):
        return 400, {'error':'Некорректный размер пакета'}
    quantity = data.get('quantity', 1)
    if type(quantity) is not int or not 1 <= quantity <= (MAX_CRAFT_BATCH if kind == 'craft' else 1):
        return 400, {'error': 'Некорректное количество'}
    old = execute(db,'SELECT kind,size,result FROM operations WHERE uid=? AND op=?',(uid,op)).fetchone()
    if old:
        # Legacy craft results describe a single recipe execution.
        result = json.loads(old[2])
        if old[:2] != (kind,size) or result.get('craftedQuantity', 1) != quantity:
            return 409, {'error':'Операция уже использована'}
        return 200, {**reply(),**result}
    owned = state['owned']
    if kind == 'draw':
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
            roll = secrets.randbelow(100)
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
    elif kind == 'reset-shuffle':
        state['lastBreak'] = 0
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
    execute(db,'INSERT INTO players VALUES (?,?) ON CONFLICT(uid) DO UPDATE SET state=excluded.state',(uid,json.dumps(state)))
    execute(db,'INSERT INTO operations VALUES (?,?,?,?,?)',(uid,op,kind,size,json.dumps(result)))
    db.commit()
    return 200, {**reply(),**result}


class Play(Handler):
    def player_key(self, uid):
        return hmac.new(self.server.token.encode(), uid.encode(), "sha256").hexdigest()[:24]

    def response(self, status, data, cookie=None):
        self.send(status,json.dumps(data,ensure_ascii=False).encode(),'application/json; charset=utf-8',cookie)

    def do_GET(self):
        path=urlsplit(self.path).path
        files={'/':(WEB/'index.html','text/html; charset=utf-8'),'/play.css':(WEB/'play.css','text/css'),'/play.js':(WEB/'play.js','text/javascript'),'/draw-sound.js':(ROOT/'draw-sound.js','text/javascript'),'/cards.js':(ROOT/'cards.js','text/javascript')}
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
                    if secure: uid='tg:'+str(player_id(data.get('initData'),self.server.token,self.server.allowed))
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
                status,out=play(db,row[0],kind,data,3 if secure else 120,now)
                if kind=='state' and status==200:
                    out['canGrantSpins']=True
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
    server.serve_forever()

if __name__=='__main__': main()
