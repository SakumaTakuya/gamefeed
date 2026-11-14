"""Dump reference vectors for packages/domain/test/deviation.spec.ts (R-sc.A5-1, R-sc.A6-1).

Run: python3 verification/scoring_vectors.py > packages/domain/test/fixtures/deviation-vectors.json
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
    json.dump(out, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
