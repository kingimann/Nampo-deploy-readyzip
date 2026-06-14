"""Unit tests for the checkers engine (services.checkers_engine)."""
from services import checkers_engine as ck


def _empty():
    return {"board": "." * 64, "turn": "w", "chain": None}


def _place(state, sq, piece):
    b = list(state["board"])
    b[sq] = piece
    state["board"] = "".join(b)


def test_initial_white_has_seven_moves():
    st = ck.initial_state()
    moves = ck.legal_moves(st)
    assert len(moves) == 7
    assert ck.status(st) == "active"


def test_capture_is_mandatory():
    st = _empty()
    _place(st, ck._sq(2, 5), "w")   # white man
    _place(st, ck._sq(3, 4), "b")   # adjacent black, jumpable to (4,3)
    moves = ck.legal_moves(st)
    # Only the capture is offered, not the quiet step.
    assert moves == [(ck._sq(2, 5), ck._sq(4, 3))]


def test_multi_jump_keeps_the_turn():
    st = _empty()
    _place(st, ck._sq(2, 5), "w")
    _place(st, ck._sq(3, 4), "b")
    _place(st, ck._sq(5, 2), "b")
    s1 = ck.apply_move(st, ck._sq(2, 5), ck._sq(4, 3))
    assert s1 is not None
    assert s1["turn"] == "w" and s1["chain"] == ck._sq(4, 3)  # must continue
    assert s1["board"][ck._sq(3, 4)] == "."                   # first man taken
    s2 = ck.apply_move(s1, ck._sq(4, 3), ck._sq(6, 1))
    assert s2["turn"] == "b" and s2["chain"] is None          # chain complete
    assert s2["board"][ck._sq(5, 2)] == "."                   # second man taken


def test_promotion_to_king():
    st = _empty()
    _place(st, ck._sq(2, 1), "w")   # one row from the top
    s1 = ck.apply_move(st, ck._sq(2, 1), ck._sq(1, 0))
    assert s1 is not None
    assert s1["board"][ck._sq(1, 0)] == "W"   # promoted to king
    assert s1["turn"] == "b"


def test_no_moves_is_a_loss():
    st = _empty()
    # A lone white man boxed into a corner with no diagonal forward squares.
    _place(st, ck._sq(0, 7), "w")   # a1: white moves up to (1,6)
    _place(st, ck._sq(1, 6), "w")   # block its only forward square with own man
    # White to move: the front man (1,6) can still move, so active. Flip turn to
    # black, who has no pieces -> black has lost.
    st["turn"] = "b"
    assert ck.status(st) == "white_won"
