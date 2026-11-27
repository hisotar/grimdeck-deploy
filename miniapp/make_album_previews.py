"""Generate committed album previews from the original WebPs (Pillow 13.0.0).

Run from the checkout with `python3 miniapp/make_album_previews.py [CARD_ID ...]`.
Without IDs, refresh all available card previews. No runtime Pillow dependency.
"""
import re
import sys
from pathlib import Path

from PIL import Image

ART = Path(__file__).resolve().parent / 'play' / 'art'


def main(ids):
    if any(not re.fullmatch(r'WIT_[CRELM][0-9]{2}', cid) for cid in ids):
        raise SystemExit('Expected card IDs like WIT_C01')
    sources = [ART / f'{cid}.webp' for cid in ids] if ids else sorted(ART.glob('WIT_[CRELM][0-9][0-9].webp'))
    output = ART / 'album'
    output.mkdir(exist_ok=True)
    for source in sources:
        with Image.open(source) as image:
            image.thumbnail((256, 384), Image.Resampling.LANCZOS)
            image.save(output / source.name, format='WEBP', quality=72, method=6)


if __name__ == '__main__':
    main(sys.argv[1:])
