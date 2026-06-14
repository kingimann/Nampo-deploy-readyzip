"""Unit tests for the chess engine (services.chess_engine): legal move counts,
checkmate/stalemate detection, castling, en passant and promotion."""
from services import chess_engine as ce


def _seq(moves):
    """Play a list of (from, to[, promo]) and return the final state."""
    st = ce.initial_state()
    for mv in moves:
        st = ce.apply_move(st, *mv)
        assert st is not None, f"illegal move in sequence: {mv}"
    return st


def test_initial_has_twenty_moves():
    st = ce.initial_state()
    assert len(ce.legal_moves(st)) == 20
    assert ce.status(st) == "active"


def test_illegal_move_rejected():
    st = ce.initial_state()
    # A bishop can't jump over its own pawns on the first move.
    assert ce.apply_move(st, "c1", "h6") is None


def test_fools_mate_is_checkmate():
    st = _seq([("f2", "f3"), ("e7", "e5"), ("g2", "g4"), ("d8", "h4")])
    assert ce.in_check(st, white=True)
    assert ce.status(st) == "checkmate"


def test_cannot_leave_king_in_check():
    # White: Ke1, black queen on e7 pinning down the e-file after pawns clear.
    st = ce.initial_state()
    st = _seq([("e2", "e4"), ("e7", "e5"), ("f1", "c4"), ("f8", "c5"),
               ("d1", "h5"), ("g8", "f6")])
    # Qxf7 would be ... let's just assert the move list never includes a move
    # that leaves white's own king in check by construction (sanity: all
    # generated moves are check-safe).
    for mv in ce.legal_moves(st):
        nxt = ce._apply(st, mv)
        assert not ce._attacked(
            nxt["board"], ce._king_sq(nxt["board"], st["turn"] == "w"),
            st["turn"] != "w")


def test_kingside_castle():
    st = _seq([("e2", "e4"), ("e7", "e5"), ("g1", "f3"), ("b8", "c6"),
               ("f1", "c4"), ("f8", "c5")])
    # White can now castle kingside: e1-g1.
    assert ce.apply_move(st, "e1", "g1") is not None
    after = ce.apply_move(st, "e1", "g1")
    assert after["board"][ce.sq_of("g1")] == "K"
    assert after["board"][ce.sq_of("f1")] == "R"


def test_en_passant():
    # 1.e4 a6 2.e5 d5 -> white e5 pawn can take d6 en passant.
    st = _seq([("e2", "e4"), ("a7", "a6"), ("e4", "e5"), ("d7", "d5")])
    assert st["ep"] == ce.sq_of("d6")
    after = ce.apply_move(st, "e5", "d6")
    assert after is not None
    assert after["board"][ce.sq_of("d6")] == "P"
    assert after["board"][ce.sq_of("d5")] == "."  # captured pawn removed


def test_promotion_defaults_to_queen():
    # Hand-build a position with a white pawn on a7 about to promote.
    st = ce.initial_state()
    board = list(st["board"])
    for i in range(64):
        board[i] = "."
    board[ce.sq_of("a7")] = "P"
    board[ce.sq_of("e1")] = "K"
    board[ce.sq_of("e8")] = "k"
    st = {"board": "".join(board), "turn": "w", "castling": "", "ep": None,
          "halfmove": 0}
    after = ce.apply_move(st, "a7", "a8")  # no promo given -> queen
    assert after is not None and after["board"][ce.sq_of("a8")] == "Q"
    promo_n = ce.apply_move(st, "a7", "a8", "n")
    assert promo_n["board"][ce.sq_of("a8")] == "N"
