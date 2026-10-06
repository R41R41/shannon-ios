"""Carry zones from the page's own answers (probe.mjs output), as Swift literals.

A sample carries when the page named a face part (forehead, cheek, face) or nothing named (a `tap`: `other`).
It is kept only when every sample within `margin` steps is of the same kind or outside her (no answer), so a zone
never borders hair, neck, legs or anything else. Kept samples are covered greedily by rectangles; each sample stands
for the square of one step around it.
"""
import json, sys

margin = int(sys.argv[1])
files = sys.argv[2:]
FACE = {'forehead', 'cheek', 'face'}

def kind(c):
    if c in FACE: return 'face'
    if c == 'TAP': return 'other'
    if c == '': return ''
    return 'no'

out = []
for f in files:
    d = json.load(open(f))
    S = {(round(u, 4), round(v, 4)): c for u, v, c in d['samples']}
    us = sorted({k[0] for k in S}); vs = sorted({k[1] for k in S})
    step = round(us[1] - us[0], 4)
    iu = {u: i for i, u in enumerate(us)}; iv = {v: j for j, v in enumerate(vs)}
    G = {(iu[u], iv[v]): kind(c) for (u, v), c in S.items()}
    safe = {}
    for (i, j), k in G.items():
        if k not in ('face', 'other'): continue
        ok = all(G.get((i + di, j + dj), '') in (k, '') for di in range(-margin, margin + 1) for dj in range(-margin, margin + 1))
        if ok: safe[(i, j)] = k
    covered = set()
    for (i, j) in sorted(safe, key=lambda c: (c[1], c[0])):
        if (i, j) in covered: continue
        k = safe[(i, j)]
        i1 = i
        while (i1 + 1, j) in safe and safe[(i1 + 1, j)] == k and (i1 + 1, j) not in covered: i1 += 1
        j1 = j
        while all(safe.get((x, j1 + 1)) == k and (x, j1 + 1) not in covered for x in range(i, i1 + 1)): j1 += 1
        for x in range(i, i1 + 1):
            for y in range(j, j1 + 1): covered.add((x, y))
        u0 = us[i] - step / 2; u1 = us[i1] + step / 2; v0 = vs[j] - step / 2; v1 = vs[j1] + step / 2
        out.append((k, u0, v0, u1 - u0, v1 - v0, (i1 - i + 1) * (j1 - j + 1)))
    print(f"// {f}: {len(S)} samples, step {step}, {sum(1 for k in G.values() if k=='face')} face, {sum(1 for k in G.values() if k=='other')} other, kept {len(safe)}", file=sys.stderr)

out.sort(key=lambda r: (r[0], r[2], r[1]))
for k, u0, v0, w, h, n in out:
    part = '.face' if k == 'face' else '.other'
    print(f"        Zone(part: {part}, box: CGRect(x: {u0:.4f}, y: {v0:.4f}, width: {w:.4f}, height: {h:.4f})),  // {n}")
print(f"// {len(out)} zones", file=sys.stderr)
