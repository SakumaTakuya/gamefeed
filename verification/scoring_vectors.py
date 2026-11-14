"""Dump reference vectors for packages/domain/test/deviation.spec.ts (R-sc.A5-1, R-sc.A6-1).

Run (from verification/):
  python3 scoring_vectors.py > ../packages/domain/test/fixtures/deviation-vectors.gen.ts
The distributions are the same seeded ones scoring_check.py uses, so the output is stable.
"""
from __future__ import annotations

import json
import random
import sys

from scoring_check import deviation, make_distributions, miss_below


def main() -> int:
    dists = make_distributions(random.Random(20261107))
    out = []
    for name, dist in dists.items():
        top = max(dist)
        scores = sorted(set(dist) | {0, 1, top + 1, top * 2 + 1})
        out.append({
            "name": name,
            "dist": dist,
            "miss_below": miss_below(dist),
            "deviations": [[s, deviation(s, dist)] for s in scores],
        })
    sys.stdout.write("// verification/scoring_vectors.py が生成する。手で直さない。\n")
    sys.stdout.write("export interface DeviationVector {\n  name: string;\n  dist: number[];\n"
                     "  miss_below: number;\n  deviations: [number, number][];\n}\n")
    sys.stdout.write("export const DEVIATION_VECTORS: DeviationVector[] = ")
    json.dump(out, sys.stdout, separators=(",", ":"))
    sys.stdout.write(";\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
