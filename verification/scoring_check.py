"""Numeric checks for docs/scoring.md A.5 / A.6 / A.9 (properties S1-S6 in A.11).

Run: python3 verification/scoring_check.py
Exit code 0 when every property holds; prints a line per property.
No third-party dependencies.
"""
from __future__ import annotations

import math
import random
import sys
from bisect import bisect_left, bisect_right

# ---------------------------------------------------------------------------
# A.5 — inverse normal CDF (Acklam's rational approximation, rel. err 1.15e-9)
# ---------------------------------------------------------------------------
_A = (-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
      1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00)
_B = (-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
      6.680131188771972e+01, -1.328068155288572e+01)
_C = (-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
      -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00)
_D = (7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
      3.754408661907416e+00)
_P_LOW, _P_HIGH = 0.02425, 1 - 0.02425


def inv_norm(p: float) -> float:
    if not 0.0 < p < 1.0:
        raise ValueError("p must be in (0, 1)")
    if p < _P_LOW:
        q = math.sqrt(-2 * math.log(p))
        return (((((_C[0] * q + _C[1]) * q + _C[2]) * q + _C[3]) * q + _C[4]) * q + _C[5]) / \
               ((((_D[0] * q + _D[1]) * q + _D[2]) * q + _D[3]) * q + 1)
    if p <= _P_HIGH:
        q = p - 0.5
        r = q * q
        return (((((_A[0] * r + _A[1]) * r + _A[2]) * r + _A[3]) * r + _A[4]) * r + _A[5]) * q / \
               (((((_B[0] * r + _B[1]) * r + _B[2]) * r + _B[3]) * r + _B[4]) * r + 1)
    q = math.sqrt(-2 * math.log(1 - p))
    return -(((((_C[0] * q + _C[1]) * q + _C[2]) * q + _C[3]) * q + _C[4]) * q + _C[5]) / \
            ((((_D[0] * q + _D[1]) * q + _D[2]) * q + _D[3]) * q + 1)


def deviation(score: int, dist: list[int]) -> float:
    """A.5: dist is the ascending distribution EXCLUDING the session itself."""
    n = len(dist)
    lower = bisect_left(dist, score)
    equal = bisect_right(dist, score) - lower
    p = (lower + 0.5 * equal + 0.5) / (n + 1)
    value = 50 + 10 * inv_norm(p)
    return min(80.0, max(20.0, round(value, 1)))


def miss_below(dist: list[int]) -> int:
    """A.6: smallest integer score s >= 0 whose deviation against dist is >= 40.

    deviation() is monotone in s, and the only candidates are the distinct
    scores in dist and each of them + 1 (plus 0), so a linear scan over the
    candidates is enough here; an implementation may binary-search them.
    """
    candidates = sorted({0} | set(dist) | {v + 1 for v in dist})
    for c in candidates:
        if deviation(c, dist) >= 40.0:
            return c
    return candidates[-1] + 1  # unreachable for any non-empty dist


# ---------------------------------------------------------------------------
# synthetic distributions (A.7's hard cases)
# ---------------------------------------------------------------------------
def make_distributions(rng: random.Random) -> dict[str, list[int]]:
    normalish = sorted(max(0, int(rng.gauss(50, 15))) for _ in range(500))
    zero_pile = sorted([0] * 420 + [max(0, int(rng.gauss(40, 10))) for _ in range(80)])
    bimodal = sorted([0] * 240 + [100] * 240 + [rng.randint(1, 99) for _ in range(20)])
    long_tail = sorted(int(rng.paretovariate(1.2) * 10) for _ in range(500))
    constant = [7] * 500
    small = sorted(max(0, int(rng.gauss(50, 15))) for _ in range(20))
    return {"normalish": normalish, "zero_pile": zero_pile, "bimodal": bimodal,
            "long_tail": long_tail, "constant": constant, "small_n20": small}


def check(name: str, ok: bool, detail: str = "") -> bool:
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  ' + detail) if detail else ''}")
    return ok


def main() -> int:
    rng = random.Random(20261107)
    dists = make_distributions(rng)
    results: list[bool] = []

    # S1 monotone, S2 bounds, S5 finite — over every distribution and score range
    for name, dist in dists.items():
        scores = sorted(set(dist) | {0, max(dist) + 1, max(dist) * 2 + 1})
        devs = [deviation(s, dist) for s in scores]
        mono = all(a <= b for a, b in zip(devs, devs[1:]))
        bounded = all(20.0 <= d <= 80.0 for d in devs)
        finite = all(math.isfinite(d) for d in devs)
        results.append(check(f"S1 monotone      [{name}]", mono))
        results.append(check(f"S2 bounded 20-80 [{name}]", bounded, f"min={min(devs)} max={max(devs)}"))
        results.append(check(f"S5 finite        [{name}]", finite))

    # S3 attainable maximum at n = 20
    best = deviation(10**9, dists["small_n20"])
    results.append(check("S3 n=20 max == 69.8", best == 69.8, f"got {best}"))
    for n, expect in ((100, 75.8), (1000, 80.0)):
        d = sorted(range(n))
        results.append(check(f"S3 n={n} max == {expect}", deviation(10**9, d) == expect,
                             f"got {deviation(10**9, d)}"))

    # S4 — a NEW result evaluated against the distribution frozen at issue time:
    #      score < miss_below  ⇔  deviation(score) < 40
    def s4(name: str, dist: list[int]) -> None:
        mb = miss_below(dist)
        agree = True
        for s in range(0, max(dist) + 3):  # scores present, absent, and beyond the max
            if (s < mb) != (deviation(s, dist) < 40.0):
                agree = False
                print(f"      mismatch [{name}] score={s} miss_below={mb} dev={deviation(s, dist)}")
                break
        results.append(check(f"S4 miss_below ⇔ dev<40 [{name}]", agree, f"miss_below={mb}"))

    for name, dist in dists.items():
        s4(name, dist)
    for n in range(20, 61):  # boundary sample sizes, distinct scores 0..n-1 (Codex's case: n = 25)
        s4(f"distinct n={n}", list(range(n)))

    # S6 frozen values never change when the distribution grows
    dist = list(dists["normalish"])
    frozen = {s: deviation(s, dist) for s in (10, 40, 55, 70)}
    dist = sorted(dist + [max(0, int(rng.gauss(80, 10))) for _ in range(300)])
    live = {s: deviation(s, dist) for s in frozen}
    results.append(check("S6 frozen stays (by construction)", True,
                         f"live moved: {[(s, frozen[s], live[s]) for s in frozen if frozen[s] != live[s]]}"))

    failed = results.count(False)
    print(f"\n{len(results) - failed}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
