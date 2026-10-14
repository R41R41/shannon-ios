#!/usr/bin/env python3
"""Bundle her talk-screen face icons (Syzygy ADR-0013 D17, owner choice A: a small round face beside each reply).

Reads the face crops rendered from Live2D (Syzygy `artifacts/expressions/img`: `have-<expression>_face.webp` for the
33 faces the model has, `impl-<id>_face.webp` for the twelve single faces, named in `tools/recipes-impl12.json`) and
writes one `shannon-face-<presentationId>.png` per id into the app's resources: 108 px (36 pt @3x), 256 colours.
The names are keyed by the presentation id and stay stable: after the Live2D art changes, run this again.

    python3 scripts/render-face-icons.py <Syzygy>/artifacts/expressions
"""
import json
import sys
from pathlib import Path

from PIL import Image

SIZE = 108
OUT = Path(__file__).resolve().parent.parent / 'apps/ios/Sources/ShannonAppCore/Resources'


def main(source: Path) -> None:
    images = source / 'img'
    faces = {path.name[len('have-'):-len('_face.webp')]: path for path in images.glob('have-*_face.webp')}
    for recipe in json.loads((source / 'tools/recipes-impl12.json').read_text()):
        faces[recipe['base']] = images / f"{recipe['id']}_face.webp"
    for name, path in sorted(faces.items()):
        picture = Image.open(path).convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)
        picture.quantize(256, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG).save(OUT / f'shannon-face-{name}.png', optimize=True)
    print(f'{len(faces)} faces written to {OUT}')


if __name__ == '__main__':
    main(Path(sys.argv[1]))
