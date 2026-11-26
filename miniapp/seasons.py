"""GrimDeck season rules and the public profile projection."""
import unicodedata
from datetime import datetime, timedelta, timezone

MSK = timezone(timedelta(hours=3))
UNIVERSE = 'Ведьмак'
SPIN_INFLUENCE = 1
TASK_INFLUENCE = 5
CONTRACT_INFLUENCE = 10
FRAMES = (
    ('iron', 'Воронёное железо', 'Бесплатная'),
    ('copper', 'Старая медь', 'Бесплатная'),
    ('steel', 'Лунная сталь', 'Бесплатная'),
    ('ember', 'Искры Пограничья', '100 влияния за сезон'),
    ('ivy', 'Терновый венец', '5 выполненных заказов'),
    ('frost', 'Северное сияние', '25 разных карт за сезон'),
    ('blood', 'Кровь древних', '20 выполненных заказов'),
    ('regal', 'Королевская печать', 'Донат · пока недоступна'),
    ('eclipse', 'Чёрное солнце', 'Донат · пока недоступна'),
)
SIGILS = ('wolf', 'raven', 'moon', 'swords')


def calendar(now):
    month = datetime.fromtimestamp(now, MSK).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    following = (month + timedelta(days=32)).replace(day=1)
    return month.strftime('%Y-%m'), int(following.timestamp())


def current(state, season, baseline):
    return state.get('season', baseline) == season


def roll(state, season, baseline):
    if not current(state, season, baseline):
        state.update(owned={}, influence=0)
        for name in ('deck', 'fight', 'contract', 'board'):
            state.pop(name, None)
    state['season'] = season


def collection(state, cards):
    return sum(cid in cards and qty > 0 for cid, qty in state.get('owned', {}).items())


def unlock(state, cards):
    contracts = state.get('contractsCompleted', 0)
    goals = (state.get('influence', 0) >= 100, contracts >= 5,
             collection(state, cards) >= 25, contracts >= 20)
    earned = state.setdefault('earnedFrames', [])
    for (key, _, _), reached in zip(FRAMES[3:7], goals):
        if reached and key not in earned:
            earned.append(key)


def available(state):
    return [key for key, _, _ in FRAMES[:3]] + [key for key, _, _ in FRAMES[3:7]
                                               if key in state.get('earnedFrames', [])]


def edit(state, params, avatars):
    fields = [key for key in ('name', 'avatar', 'frame') if key in params]
    if len(fields) != 1:
        return 'Выбери, что изменить в профиле'
    key = fields[0]
    value = params[key]
    if not isinstance(value, str):
        return 'Некорректное значение'
    if key == 'name':
        value = ' '.join(unicodedata.normalize('NFC', value).split())
        if not 2 <= len(value) <= 24 or any(unicodedata.category(ch)[0] == 'C' for ch in value):
            return 'Имя должно содержать от 2 до 24 видимых символов'
    elif key == 'avatar' and value not in avatars:
        return 'Такой аватарки нет'
    elif key == 'frame' and value not in available(state):
        return 'Эта рамка пока недоступна'
    state.setdefault('profile', {})[key] = value
    return None


def profile(state, key, cards, live):
    identity = state.get('profile', {})
    return dict(id=key, name=identity.get('name', f'Искатель {key[:6].upper()}'),
                avatar=identity.get('avatar', 'wolf'), frame=identity.get('frame', 'iron'),
                universe=UNIVERSE, influence=state.get('influence', 0) if live else 0,
                cards=collection(state, cards) if live else 0, totalCards=len(cards),
                arenaWins=0, contracts=state.get('contractsCompleted', 0),
                achievements=state.get('earnedFrames', []))
