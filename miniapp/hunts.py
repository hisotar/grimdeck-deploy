"""Daily notices and server-authoritative monster hunts."""
import hashlib
import random

DAY = 86400
MOSCOW = 3 * 3600
# Names, optional catalog portrait, and difficulty (1–3). Missing art is handled by the client.
MONSTERS = (
    ('Альгуль', 'WIT_C03', 1), ('Главоглаз', None, 2),
    ('Земляной элементаль', 'WIT_C16', 2), ('Огненный элементаль', 'WIT_C17', 3),
    ('Ледяной элементаль', 'WIT_C18', 2), ('Ифрит', 'WIT_C19', 3), ('Голем', 'WIT_C20', 2),
    ('Волколак', 'WIT_C22', 1), ('Полуденница', 'WIT_C33', 1), ('Полуночница', 'WIT_C34', 2),
    ('Тролль', 'WIT_C32', 1), ('Хим', 'WIT_R14', 3), ('Катакан', 'WIT_R08', 2),
    ('Брукса', 'WIT_R07', 3), ('Леший', 'WIT_R03', 3), ('Вилохвост', 'WIT_R05', 2),
    ('Грифон', 'WIT_R01', 2),
)
PORTRAITS = {name: art for name, art, _ in MONSTERS if art}
LEGACY_NAMES = {'Водный элементаль': 'Ледяной элементаль', 'Волк альфа': 'Волколак'}
# Fixed by tier: empty slots do not make a contract easier. Existing fights keep their snapshot.
MONSTER_STATS = {1: (81, 13), 2: (91, 16), 3: (104, 16)}  # (health, attack)
REAR_HUNTERS = {'Полуденница', 'Полуночница', 'Катакан', 'Брукса', 'Вилохвост', 'Грифон'}
ACTIONS = {'take-contract': 'contract', 'save-deck': 'slots', 'start-hunt': 'contract',
           'strike': 'turn'}


def tactic(name):
    return 'rear' if name in REAR_HUNTERS else 'front'


def rename_saved_monsters(state):
    """Update display names in existing notices, contracts and combat snapshots."""
    changed = False
    notices = state.get('board', {}).get('notices', ())
    fight = state.get('fight') or {}
    for monster in (*notices, state.get('contract'), fight.get('monster')):
        if monster and monster.get('name') in LEGACY_NAMES:
            monster['name'] = LEGACY_NAMES[monster['name']]
            changed = True
    return changed


def board_for(state, uid, now, *, renew=False):
    day = (now + MOSCOW) // DAY
    previous = state.get('board', {})
    same_day = previous.get('day') == day
    if same_day and not renew:
        return
    generation = previous.get('generation', 0) + 1 if same_day else 0
    suffix = f':{generation}' if generation else ''
    notice_id = f'{day}{suffix}'
    seed = hashlib.sha256(f'grimdeck-board-v1:{day}:{uid}{suffix}'.encode()).digest()
    rng = random.Random(seed)
    count = rng.randint(3, 6)
    actions = ['draw', 'craft', 'break']
    rng.shuffle(actions)
    if count == 6:
        actions.append(rng.choice(actions))
    limits = {'draw': 6, 'craft': 4, 'break': 2}
    notices = []
    for i, kind in enumerate(actions[:count - 2]):
        goals = [n for n in range(1, limits[kind] + 1)
                 if not any(q['kind'] == kind and q['goal'] == n for q in notices)]
        goal = rng.choice(goals)
        notices.append(dict(id=f'{notice_id}:task:{i}', kind=kind, goal=goal, progress=0,
                            reward=1 + goal // 2))
    old_hunts = {q['name'] for q in previous['notices'] if q['kind'] == 'hunt'} if renew and same_day else set()
    pool = [i for i, (name, _, _) in enumerate(MONSTERS) if name not in old_hunts]
    for i in rng.sample(pool, 2):
        name, art, tier = MONSTERS[i]
        notices.append(dict(id=f'{notice_id}:hunt:{i}', kind='hunt', name=name, art=art,
                            tier=tier, reward=2 + tier, taken=False))
    rng.shuffle(notices)
    state['board'] = dict(day=day, generation=generation, resetsAt=(day + 1) * DAY - MOSCOW, notices=notices)


def award(state, quest):
    state['coins'] += quest['reward']
    return dict(id=quest['id'], coins=quest['reward'])


def progress(state, kind, count):
    rewards = []
    for quest in state['board']['notices']:
        if quest['kind'] == kind and quest['progress'] < quest['goal']:
            quest['progress'] = min(quest['goal'], quest['progress'] + count)
            if quest['progress'] == quest['goal']:
                rewards.append(award(state, quest))
    return rewards


def counter_target(fight):
    if not fight or fight['status'] != 'active':
        return None
    units = fight['units']
    order = (3, 4, 5, 0, 1, 2) if fight['monster'].get('tactic') == 'rear' else range(6)
    return next((i for i in order if units[i] and units[i]['hp']), None)


def action(state, cards, kind, params):
    owned = state['owned']
    contract = state.get('contract')
    fight = state.get('fight')
    contract_id = params.get('contract')
    if kind == 'take-contract':
        if contract:
            return 409, {'error': 'Уже взят заказ'}
        notice = next((q for q in state['board']['notices']
                       if q['kind'] == 'hunt' and q['id'] == contract_id and not q['taken']), None)
        if not notice:
            return 409, {'error': 'Этот заказ больше недоступен'}
        notice['taken'] = True
        state['contract'] = notice.copy()
        return 200, {'taken': notice['id']}
    if kind == 'save-deck':
        slots = params.get('slots')
        if not isinstance(slots, list) or len(slots) != 6:
            return 400, {'error': 'У колоды должно быть шесть слотов'}
        chosen = set()
        for cid in slots:
            if cid is None:
                continue
            if not isinstance(cid, str) or cid not in cards or cid in chosen or not owned.get(cid, 0):
                return 400, {'error': 'Выбери разные карты из своей коллекции'}
            chosen.add(cid)
        state['deck'] = slots
        return 200, {}
    if kind == 'start-hunt':
        if not contract or contract['id'] != contract_id or (fight and fight['status'] == 'active'):
            return 409, {'error': 'Заказ недоступен или охота уже началась'}
        units = [dict(id=cid, atk=cards[cid][3], hp=cards[cid][4], maxHp=cards[cid][4])
                 if cid in cards and owned.get(cid) else None for cid in state.get('deck', [None] * 6)]
        if not any(units):
            return 409, {'error': 'Поставь на стол хотя бы одну карту'}
        hp, atk = MONSTER_STATS[contract['tier']]
        monster = {**contract, 'hp': hp, 'maxHp': hp, 'atk': atk}
        monster['tactic'] = tactic(contract['name'])
        state['fight'] = dict(id=contract_id, turn=0, status='active', units=units, monster=monster)
        return 200, {'started': contract_id}
    if (not contract or not fight or fight['status'] != 'active' or fight['id'] != contract_id
            or type(params.get('turn')) is not int or params['turn'] != fight['turn']):
        return 409, {'error': 'Ход уже завершён или охота недоступна'}
    units, monster = fight['units'], fight['monster']
    events = []
    for i, unit in enumerate(units):
        if not unit or not unit['hp']:
            continue
        damage = (unit['atk'] + 1) // 2 if i < 3 else unit['atk']
        monster['hp'] = max(0, monster['hp'] - damage)
        events.append(dict(slot=i, monsterHp=monster['hp'], damage=damage))
        if not monster['hp']:
            break
    if monster['hp']:
        target = counter_target(fight)
        if target is not None:
            unit = units[target]
            unit['hp'] = max(0, unit['hp'] - monster['atk'])
            events.append(dict(slot=target, unitHp=unit['hp'], damage=monster['atk']))
    fight['turn'] += 1
    result = dict(strike=dict(id=contract_id, turn=fight['turn'], events=events))
    if not monster['hp']:
        fight['status'] = 'won'
        result['questRewards'] = [award(state, contract)]
    elif fight['turn'] == 3 or not any(unit and unit['hp'] for unit in units):
        fight['status'] = 'lost'
    if fight['status'] != 'active':
        state['contract'] = None
    return 200, result
