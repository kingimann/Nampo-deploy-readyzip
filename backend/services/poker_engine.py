"""Five-card draw poker: deal, one draw round, and showdown with full hand
evaluation. Cards are dicts {"r": rank, "s": suit}; ranks are "2".."10","J",
"Q","K","A". No betting — the better five-card hand wins the round.

`evaluate` returns a tuple that sorts so the stronger hand compares greater, so
two hands can be ranked with plain tuple comparison.
"""
import random
from collections import Counter
from typing import List, Tuple

_SUITS = ["♠", "♥", "♦", "♣"]
_RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"]
_RANK_VALUE = {r: i + 2 for i, r in enumerate(_RANKS)}  # 2..14 (A=14)

HAND_NAMES = {
    8: "Straight flush", 7: "Four of a kind", 6: "Full house", 5: "Flush",
    4: "Straight", 3: "Three of a kind", 2: "Two pair", 1: "Pair",
    0: "High card",
}


def new_deck() -> list:
    deck = [{"r": r, "s": s} for s in _SUITS for r in _RANKS]
    random.shuffle(deck)
    return deck


def _values(cards: List[dict]) -> List[int]:
    return sorted((_RANK_VALUE[c["r"]] for c in cards), reverse=True)


def _straight_high(values: List[int]) -> int:
    """Return the high card of a straight, or 0 if not a straight. Handles the
    A-2-3-4-5 wheel (treats the ace as low, high card = 5)."""
    v = sorted(set(values), reverse=True)
    if len(v) != 5:
        return 0
    if v[0] - v[4] == 4:
        return v[0]
    if v == [14, 5, 4, 3, 2]:   # wheel
        return 5
    return 0


def evaluate(cards: List[dict]) -> Tuple:
    """Rank a 5-card hand. Higher tuple = stronger hand."""
    values = _values(cards)
    flush = len({c["s"] for c in cards}) == 1
    straight_high = _straight_high(values)
    counts = Counter(values)
    # Ranks ordered by (count desc, value desc) — the standard tiebreak order.
    by_count = sorted(values, key=lambda x: (counts[x], x), reverse=True)
    distinct_counts = sorted(counts.values(), reverse=True)

    if straight_high and flush:
        return (8, straight_high)
    if distinct_counts == [4, 1]:
        return (7, *by_count)              # quads, then kicker
    if distinct_counts == [3, 2]:
        return (6, *by_count)              # trips value, then pair value
    if flush:
        return (5, *values)
    if straight_high:
        return (4, straight_high)
    if distinct_counts == [3, 1, 1]:
        return (3, *by_count)
    if distinct_counts == [2, 2, 1]:
        return (2, *by_count)              # high pair, low pair, kicker
    if distinct_counts == [2, 1, 1, 1]:
        return (1, *by_count)
    return (0, *values)


def hand_name(cards: List[dict]) -> str:
    return HAND_NAMES[evaluate(cards)[0]]


def compare(h1: List[dict], h2: List[dict]) -> int:
    """1 if h1 wins, -1 if h2 wins, 0 on a tie."""
    e1, e2 = evaluate(h1), evaluate(h2)
    return 1 if e1 > e2 else (-1 if e1 < e2 else 0)


def draw(deck: list, hand: List[dict], holds: List[int]) -> List[dict]:
    """Keep the cards at indices in `holds`, replace the rest from the deck."""
    keep = {i for i in holds if 0 <= i < len(hand)}
    new_hand = []
    for i, card in enumerate(hand):
        new_hand.append(card if i in keep else deck.pop())
    return new_hand


def cpu_holds(hand: List[dict]) -> List[int]:
    """A simple CPU draw policy: keep anything that's part of a pair-or-better;
    otherwise keep the single highest card. Discards the rest."""
    values = [_RANK_VALUE[c["r"]] for c in hand]
    counts = Counter(values)
    cat = evaluate(hand)[0]
    if cat >= 4:                       # straight/flush or better — stand pat
        return list(range(5))
    holds = [i for i, v in enumerate(values) if counts[v] >= 2]
    if holds:
        return holds                   # keep the pair/trips/two-pair cards
    best = max(range(5), key=lambda i: values[i])
    return [best]                      # keep the top card, draw four
