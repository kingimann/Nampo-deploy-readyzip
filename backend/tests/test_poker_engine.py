"""Unit tests for poker hand evaluation and comparison (services.poker_engine)."""
from services import poker_engine as pk


def H(*cards):
    out = []
    for c in cards:
        out.append({"r": c[:-1], "s": c[-1]})
    return out


def test_category_ranking_order():
    royal = H("10♠", "J♠", "Q♠", "K♠", "A♠")          # straight flush
    quads = H("9♠", "9♥", "9♦", "9♣", "K♠")
    boat = H("8♠", "8♥", "8♦", "K♣", "K♠")            # full house
    flush = H("2♠", "5♠", "7♠", "9♠", "J♠")
    straight = H("4♠", "5♥", "6♦", "7♣", "8♠")
    trips = H("Q♠", "Q♥", "Q♦", "2♣", "5♠")
    two_pair = H("J♠", "J♥", "3♦", "3♣", "9♠")
    pair = H("A♠", "A♥", "4♦", "7♣", "9♠")
    high = H("A♠", "Q♥", "9♦", "5♣", "2♠")
    order = [high, pair, two_pair, trips, straight, flush, boat, quads, royal]
    evals = [pk.evaluate(h) for h in order]
    assert evals == sorted(evals)           # already in ascending strength
    assert pk.hand_name(royal) == "Straight flush"
    assert pk.hand_name(boat) == "Full house"


def test_wheel_straight():
    wheel = H("A♠", "2♥", "3♦", "4♣", "5♠")
    assert pk.evaluate(wheel)[0] == 4       # a straight
    higher = H("2♠", "3♥", "4♦", "5♣", "6♠")
    assert pk.compare(higher, wheel) == 1   # 6-high beats the 5-high wheel


def test_kicker_breaks_ties():
    aces_k = H("A♠", "A♥", "K♦", "5♣", "2♠")
    aces_q = H("A♦", "A♣", "Q♦", "5♥", "2♥")
    assert pk.compare(aces_k, aces_q) == 1
    same = H("A♦", "A♣", "K♣", "5♥", "2♥")
    assert pk.compare(aces_k, same) == 0    # identical ranks -> tie


def test_full_house_beats_flush():
    boat = H("8♠", "8♥", "8♦", "K♣", "K♠")
    flush = H("2♠", "5♠", "7♠", "9♠", "J♠")
    assert pk.compare(boat, flush) == 1


def test_draw_replaces_unheld_cards():
    deck = [{"r": "K", "s": "♠"}, {"r": "K", "s": "♥"}]  # popped from the end
    hand = H("A♠", "2♥", "3♦", "4♣", "5♠")
    # Hold the ace (index 0); the other four would be replaced (deck has 2).
    new = pk.draw(deck, hand, [0, 1, 2])    # hold first three, draw two
    assert new[0]["r"] == "A" and new[1]["r"] == "2" and new[2]["r"] == "3"
    assert new[3]["r"] == "K" and new[4]["r"] == "K"


def test_cpu_keeps_a_pair():
    hand = H("Q♠", "Q♥", "2♦", "7♣", "9♠")
    assert sorted(pk.cpu_holds(hand)) == [0, 1]   # keep the queens
