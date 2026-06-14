"""A small, self-contained chess engine: legal-move generation, move
application, and game-status detection (check / checkmate / stalemate).

Board is a 64-char string, index 0 = a8 … 63 = h1. White pieces are uppercase
(PNBRQK), black lowercase, '.' is empty. State also tracks side to move,
castling rights, and the en-passant target square. Squares are named like
"e2"; moves are (from, to, promotion) where promotion is one of q/r/b/n.

Scope: full legal moves incl. castling, en passant and promotion, with
checkmate/stalemate detection. It is a rules validator, not an AI.
"""
from typing import List, Optional, Tuple

START_BOARD = (
    "rnbqkbnr"
    "pppppppp"
    "........"
    "........"
    "........"
    "........"
    "PPPPPPPP"
    "RNBQKBNR"
)

# (file, rank) deltas. rank index 0 = rank 8 (top), 7 = rank 1 (bottom).
_KNIGHT = [(1, 2), (2, 1), (2, -1), (1, -2), (-1, -2), (-2, -1), (-2, 1), (-1, 2)]
_KING = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]
_BISHOP = [(1, 1), (1, -1), (-1, 1), (-1, -1)]
_ROOK = [(1, 0), (-1, 0), (0, 1), (0, -1)]


def initial_state() -> dict:
    return {
        "board": START_BOARD,
        "turn": "w",
        "castling": "KQkq",
        "ep": None,           # en-passant target square index, or None
        "halfmove": 0,        # plies since last capture/pawn move (50-move rule)
    }


def sq_of(name: str) -> int:
    f = ord(name[0]) - ord("a")
    r = 8 - int(name[1])
    return r * 8 + f


def name_of(sq: int) -> str:
    return f"{chr(ord('a') + sq % 8)}{8 - sq // 8}"


def _fr(sq: int) -> Tuple[int, int]:
    return sq % 8, sq // 8


def _sq(f: int, r: int) -> int:
    return r * 8 + f


def _is_white(p: str) -> bool:
    return p.isupper()


def _same_side(p: str, white: bool) -> bool:
    return p != "." and _is_white(p) == white


def _enemy(p: str, white: bool) -> bool:
    return p != "." and _is_white(p) != white


def _king_sq(board: str, white: bool) -> int:
    k = "K" if white else "k"
    return board.index(k)


def _attacked(board: str, sq: int, by_white: bool) -> bool:
    """Is `sq` attacked by any piece of the given colour?"""
    f0, r0 = _fr(sq)
    # Pawns: a white pawn attacks the squares one rank "up" (toward rank 8).
    pawn = "P" if by_white else "p"
    pr = 1 if by_white else -1   # white pawns sit one rank below the square they attack
    for df in (-1, 1):
        f, r = f0 + df, r0 + pr
        if 0 <= f < 8 and 0 <= r < 8 and board[_sq(f, r)] == pawn:
            return True
    # Knights.
    knight = "N" if by_white else "n"
    for df, dr in _KNIGHT:
        f, r = f0 + df, r0 + dr
        if 0 <= f < 8 and 0 <= r < 8 and board[_sq(f, r)] == knight:
            return True
    # King (adjacency).
    king = "K" if by_white else "k"
    for df, dr in _KING:
        f, r = f0 + df, r0 + dr
        if 0 <= f < 8 and 0 <= r < 8 and board[_sq(f, r)] == king:
            return True
    # Sliders: bishop/queen on diagonals, rook/queen on files/ranks.
    for dirs, pieces in ((_BISHOP, ("B", "Q")), (_ROOK, ("R", "Q"))):
        want = tuple(p if by_white else p.lower() for p in pieces)
        for df, dr in dirs:
            f, r = f0 + df, r0 + dr
            while 0 <= f < 8 and 0 <= r < 8:
                p = board[_sq(f, r)]
                if p != ".":
                    if p in want:
                        return True
                    break
                f += df
                r += dr
    return False


def in_check(state: dict, white: bool) -> bool:
    return _attacked(state["board"], _king_sq(state["board"], white), not white)


def _pseudo_moves(state: dict) -> List[Tuple[int, int, Optional[str]]]:
    """All moves legal by piece-movement rules, ignoring whether they leave the
    mover's own king in check (that's filtered in legal_moves)."""
    board = state["board"]
    white = state["turn"] == "w"
    moves: List[Tuple[int, int, Optional[str]]] = []
    for sq in range(64):
        p = board[sq]
        if p == "." or _is_white(p) != white:
            continue
        f0, r0 = _fr(sq)
        up = p.upper()
        if up == "P":
            dr = -1 if white else 1
            start = 6 if white else 1
            promo = 0 if white else 7
            # Forward one.
            r1 = r0 + dr
            if 0 <= r1 < 8 and board[_sq(f0, r1)] == ".":
                if r1 == promo:
                    for pr in ("q", "r", "b", "n"):
                        moves.append((sq, _sq(f0, r1), pr))
                else:
                    moves.append((sq, _sq(f0, r1), None))
                # Forward two from the start rank.
                if r0 == start and board[_sq(f0, r0 + 2 * dr)] == ".":
                    moves.append((sq, _sq(f0, r0 + 2 * dr), None))
            # Captures (incl. en passant).
            for df in (-1, 1):
                f1 = f0 + df
                if not (0 <= f1 < 8 and 0 <= r1 < 8):
                    continue
                t = _sq(f1, r1)
                if _enemy(board[t], white):
                    if r1 == promo:
                        for pr in ("q", "r", "b", "n"):
                            moves.append((sq, t, pr))
                    else:
                        moves.append((sq, t, None))
                elif state["ep"] is not None and t == state["ep"]:
                    moves.append((sq, t, None))
        elif up == "N":
            for df, dr in _KNIGHT:
                f, r = f0 + df, r0 + dr
                if 0 <= f < 8 and 0 <= r < 8 and not _same_side(board[_sq(f, r)], white):
                    moves.append((sq, _sq(f, r), None))
        elif up == "K":
            for df, dr in _KING:
                f, r = f0 + df, r0 + dr
                if 0 <= f < 8 and 0 <= r < 8 and not _same_side(board[_sq(f, r)], white):
                    moves.append((sq, _sq(f, r), None))
            moves.extend(_castle_moves(state, white, sq))
        else:
            dirs = _BISHOP if up == "B" else _ROOK if up == "R" else _KING
            for df, dr in dirs:
                f, r = f0 + df, r0 + dr
                while 0 <= f < 8 and 0 <= r < 8:
                    t = _sq(f, r)
                    if board[t] == ".":
                        moves.append((sq, t, None))
                    else:
                        if _enemy(board[t], white):
                            moves.append((sq, t, None))
                        break
                    f += df
                    r += dr
    return moves


def _castle_moves(state: dict, white: bool, ksq: int):
    board = state["board"]
    rights = state["castling"]
    out = []
    if white and ksq == sq_of("e1"):
        if "K" in rights and board[sq_of("f1")] == "." and board[sq_of("g1")] == ".":
            if not _attacked(board, sq_of("e1"), False) and \
               not _attacked(board, sq_of("f1"), False) and \
               not _attacked(board, sq_of("g1"), False):
                out.append((ksq, sq_of("g1"), None))
        if "Q" in rights and board[sq_of("d1")] == "." and board[sq_of("c1")] == "." \
                and board[sq_of("b1")] == ".":
            if not _attacked(board, sq_of("e1"), False) and \
               not _attacked(board, sq_of("d1"), False) and \
               not _attacked(board, sq_of("c1"), False):
                out.append((ksq, sq_of("c1"), None))
    elif not white and ksq == sq_of("e8"):
        if "k" in rights and board[sq_of("f8")] == "." and board[sq_of("g8")] == ".":
            if not _attacked(board, sq_of("e8"), True) and \
               not _attacked(board, sq_of("f8"), True) and \
               not _attacked(board, sq_of("g8"), True):
                out.append((ksq, sq_of("g8"), None))
        if "q" in rights and board[sq_of("d8")] == "." and board[sq_of("c8")] == "." \
                and board[sq_of("b8")] == ".":
            if not _attacked(board, sq_of("e8"), True) and \
               not _attacked(board, sq_of("d8"), True) and \
               not _attacked(board, sq_of("c8"), True):
                out.append((ksq, sq_of("c8"), None))
    return out


def _apply(state: dict, mv: Tuple[int, int, Optional[str]]) -> dict:
    """Apply a (already-legal) move, returning the next state."""
    frm, to, promo = mv
    board = list(state["board"])
    white = state["turn"] == "w"
    piece = board[frm]
    up = piece.upper()
    capture = board[to] != "."
    castling = state["castling"]
    new_ep = None

    # En-passant capture: the taken pawn is beside the destination, not on it.
    if up == "P" and state["ep"] is not None and to == state["ep"] and board[to] == ".":
        cap_sq = to + (8 if white else -8)
        board[cap_sq] = "."
        capture = True

    board[to] = piece
    board[frm] = "."

    # Pawn promotion.
    if up == "P" and (to // 8 == 0 or to // 8 == 7):
        pr = (promo or "q")
        board[to] = pr.upper() if white else pr.lower()

    # Double pawn push sets the en-passant target.
    if up == "P" and abs(to // 8 - frm // 8) == 2:
        new_ep = (frm + to) // 2

    # Castling: move the rook too.
    if up == "K" and abs((to % 8) - (frm % 8)) == 2:
        if to == sq_of("g1"):
            board[sq_of("f1")] = "R"; board[sq_of("h1")] = "."
        elif to == sq_of("c1"):
            board[sq_of("d1")] = "R"; board[sq_of("a1")] = "."
        elif to == sq_of("g8"):
            board[sq_of("f8")] = "r"; board[sq_of("h8")] = "."
        elif to == sq_of("c8"):
            board[sq_of("d8")] = "r"; board[sq_of("a8")] = "."

    # Update castling rights when a king/rook moves or a rook is captured.
    def strip(ch):
        nonlocal castling
        castling = castling.replace(ch, "")
    if up == "K":
        strip("K") if white else None
        strip("Q") if white else None
        if not white:
            strip("k"); strip("q")
    for s, ch in ((sq_of("a1"), "Q"), (sq_of("h1"), "K"),
                  (sq_of("a8"), "q"), (sq_of("h8"), "k")):
        if frm == s or to == s:
            strip(ch)

    halfmove = 0 if (up == "P" or capture) else state["halfmove"] + 1
    return {
        "board": "".join(board),
        "turn": "b" if white else "w",
        "castling": castling or "",
        "ep": new_ep,
        "halfmove": halfmove,
    }


def legal_moves(state: dict) -> List[Tuple[int, int, Optional[str]]]:
    white = state["turn"] == "w"
    out = []
    for mv in _pseudo_moves(state):
        nxt = _apply(state, mv)
        # The mover's king must not be in check after the move.
        if not _attacked(nxt["board"], _king_sq(nxt["board"], white), not white):
            out.append(mv)
    return out


def apply_move(state: dict, frm: str, to: str,
               promotion: Optional[str] = None) -> Optional[dict]:
    """Validate and apply a move given by square names. Returns the new state,
    or None if the move is illegal."""
    f, t = sq_of(frm), sq_of(to)
    promo = promotion.lower() if promotion else None
    for mv in legal_moves(state):
        if mv[0] == f and mv[1] == t and (mv[2] == promo or mv[2] is None and promo is None):
            return _apply(state, mv)
        # Allow a promotion default to queen if the client omitted it.
        if mv[0] == f and mv[1] == t and mv[2] is not None and promo is None and mv[2] == "q":
            return _apply(state, mv)
    return None


def status(state: dict) -> str:
    """'active' | 'checkmate' | 'stalemate' | 'draw' (50-move)."""
    if not legal_moves(state):
        return "checkmate" if in_check(state, state["turn"] == "w") else "stalemate"
    if state["halfmove"] >= 100:
        return "draw"
    return "active"
