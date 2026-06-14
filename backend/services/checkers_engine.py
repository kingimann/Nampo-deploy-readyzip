"""A small checkers (American draughts) engine: legal move generation with
mandatory captures and multi-jumps, move application with promotion, and
game-status detection.

Board is a 64-char string, index 0 = a8 (top-left) … 63 = h1, matching the chess
engine. Pieces: 'w'/'W' = white man/king, 'b'/'B' = black man/king, '.' empty;
play is on the dark squares where (row+col) is odd. White men move "up" (toward
row 0), black men "down" (toward row 7); kings move both ways. Captures are
mandatory and chain.
"""
from typing import List, Optional, Tuple


def initial_state() -> dict:
    board = ["."] * 64
    for r in range(8):
        for c in range(8):
            if (r + c) % 2 == 1:
                if r < 3:
                    board[r * 8 + c] = "b"
                elif r > 4:
                    board[r * 8 + c] = "w"
    return {"board": "".join(board), "turn": "w", "chain": None}


def _fr(sq: int) -> Tuple[int, int]:
    return sq % 8, sq // 8


def _sq(f: int, r: int) -> int:
    return r * 8 + f


def _white(p: str) -> bool:
    return p in ("w", "W")


def _black(p: str) -> bool:
    return p in ("b", "B")


def _mine(p: str, white: bool) -> bool:
    return _white(p) if white else _black(p)


def _enemy(p: str, white: bool) -> bool:
    return _black(p) if white else _white(p)


def _dirs(piece: str) -> List[Tuple[int, int]]:
    """Diagonal step directions (df, dr) a piece may move/capture toward."""
    if piece in ("W", "B"):                      # kings: all four diagonals
        return [(-1, -1), (1, -1), (-1, 1), (1, 1)]
    if piece == "w":                             # white men move up (dr = -1)
        return [(-1, -1), (1, -1)]
    return [(-1, 1), (1, 1)]                      # black men move down


def _captures_from(board: list, sq: int) -> List[Tuple[int, int]]:
    """Capture steps (to, captured_sq) available for the piece on `sq`."""
    p = board[sq]
    if p == ".":
        return []
    white = _white(p)
    f0, r0 = _fr(sq)
    out = []
    for df, dr in _dirs(p):
        mf, mr = f0 + df, r0 + dr           # the jumped square
        lf, lr = f0 + 2 * df, r0 + 2 * dr   # the landing square
        if 0 <= lf < 8 and 0 <= lr < 8:
            mid = board[_sq(mf, mr)]
            if _enemy(mid, white) and board[_sq(lf, lr)] == ".":
                out.append((_sq(lf, lr), _sq(mf, mr)))
    return out


def _simple_from(board: list, sq: int) -> List[int]:
    p = board[sq]
    if p == ".":
        return []
    f0, r0 = _fr(sq)
    out = []
    for df, dr in _dirs(p):
        f, r = f0 + df, r0 + dr
        if 0 <= f < 8 and 0 <= r < 8 and board[_sq(f, r)] == ".":
            out.append(_sq(f, r))
    return out


def legal_moves(state: dict) -> List[Tuple[int, int]]:
    """All legal (from, to) moves. Captures are mandatory; when a multi-jump is
    in progress only the chaining piece may move."""
    board = list(state["board"])
    white = state["turn"] == "w"
    chain = state.get("chain")
    if chain is not None:
        return [(chain, to) for to, _ in _captures_from(board, chain)]
    mine = [s for s in range(64) if _mine(board[s], white)]
    caps = [(s, to) for s in mine for to, _ in _captures_from(board, s)]
    if caps:
        return caps                              # captures are forced
    return [(s, to) for s in mine for to in _simple_from(board, s)]


def _is_capture(state: dict, frm: int, to: int) -> Optional[int]:
    for t, cap in _captures_from(list(state["board"]), frm):
        if t == to:
            return cap
    return None


def apply_move(state: dict, frm: int, to: int) -> Optional[dict]:
    """Validate and apply a single (from, to) step. For a multi-jump the turn
    stays with the same player until no further capture is available."""
    if (frm, to) not in legal_moves(state):
        return None
    board = list(state["board"])
    white = state["turn"] == "w"
    piece = board[frm]
    cap = _is_capture(state, frm, to)
    board[frm] = "."
    if cap is not None:
        board[cap] = "."
    board[to] = piece

    # Promotion: a man reaching the far row becomes a king and the turn ends.
    promoted = False
    if piece == "w" and to // 8 == 0:
        board[to] = "W"; promoted = True
    elif piece == "b" and to // 8 == 7:
        board[to] = "B"; promoted = True

    new_state = {"board": "".join(board), "turn": state["turn"], "chain": None}
    # Continue the multi-jump with the same piece, unless it just promoted.
    if cap is not None and not promoted and _captures_from(board, to):
        new_state["chain"] = to
        return new_state
    new_state["turn"] = "b" if white else "w"
    return new_state


def status(state: dict) -> str:
    """'active' | 'white_won' | 'black_won'. The side with no legal move loses."""
    if legal_moves(state):
        return "active"
    return "black_won" if state["turn"] == "w" else "white_won"
