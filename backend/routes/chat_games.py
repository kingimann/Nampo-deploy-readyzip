"""In-chat games (iMessage / GamePigeon style).

A turn-based game lives in a conversation and is surfaced as a `game` message
both players watch and play. The first game is tic-tac-toe. Polling-based: the
chat already polls, and each move POSTs the new board. Kept separate from the
mini-games *platform* (routes/games.py) — different collection, different paths.
"""
import random
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Header, HTTPException

from core import db, get_current_user
from models import (
    BlackjackView, CheckersMoveBody, CheckersView, ChessMoveBody, ChessView,
    GameCreate, GameMove, GameScoreBody, GameScores, GameStats, GameView,
    Message, PokerDrawBody, PokerView,
)
from routes.messaging import _decrypt_msg
from routes.notifications import emit_notification
from services import chess_engine as ce
from services import checkers_engine as ck
from services import poker_engine as pk

router = APIRouter()

_GAME_TYPES = {"tictactoe", "blackjack", "chess", "checkers", "poker",
               "pong", "snake"}
# Real-time arcade games run entirely on the client; the server only drops the
# card and (for Pong) records the reported result.
_LOCAL_TYPES = {"pong", "snake"}
_HIDDEN_CARD = {"r": "?", "s": "?"}
# All eight tic-tac-toe winning lines.
_TTT_LINES = [
    (0, 1, 2), (3, 4, 5), (6, 7, 8),   # rows
    (0, 3, 6), (1, 4, 7), (2, 5, 8),   # cols
    (0, 4, 8), (2, 4, 6),              # diagonals
]


_CPU = "cpu"   # the computer opponent's sentinel user id


def _winner_mark(board: list) -> Optional[str]:
    for a, b, c in _TTT_LINES:
        if board[a] and board[a] == board[b] == board[c]:
            return board[a]
    return None


def _cpu_move(board: list, me: str = "O", opp: str = "X") -> Optional[int]:
    """A competent tic-tac-toe move: take a win, block a loss, then prefer the
    centre, corners and sides."""
    empties = [i for i, c in enumerate(board) if not c]
    if not empties:
        return None
    for mark in (me, opp):                     # 1. win, then 2. block
        for i in empties:
            b = list(board)
            b[i] = mark
            if _winner_mark(b) == mark:
                return i
    for i in (4, 0, 2, 6, 8, 1, 3, 5, 7):      # 3. centre, corners, sides
        if not board[i]:
            return i
    return empties[0]


async def _conv_or_404(conv_id: str, user: dict) -> dict:
    conv = await db.conversations.find_one({"id": conv_id}, {"_id": 0})
    if not conv or user["user_id"] not in conv.get("participant_ids", []):
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


_ACTIVE_STATES = {"active", "revealing", None}


def _outcomes(game: dict) -> list:
    """(user_id, 'win'|'loss'|'tie') for each HUMAN player of a finished game."""
    gt = game["game_type"]
    status = game.get("status")
    if gt in ("tictactoe",):
        if status == "draw":
            return [(game["x_player"], "tie"), (game["o_player"], "tie")]
        w = game.get("winner")
        loser = game["o_player"] if w == game["x_player"] else game["x_player"]
        return [(w, "win"), (loser, "loss")]
    if gt == "chess":
        if status in ("stalemate", "draw"):
            return [(game["white_player"], "tie"), (game["black_player"], "tie")]
        w = game.get("winner")
        loser = (game["black_player"] if w == game["white_player"]
                 else game["white_player"])
        return [(w, "win"), (loser, "loss")]
    if gt == "checkers":
        if status == "white_won":
            return [(game["white_player"], "win"), (game["black_player"], "loss")]
        return [(game["black_player"], "win"), (game["white_player"], "loss")]
    if gt in ("blackjack", "poker"):
        p = game["player_id"]
        if status in ("blackjack", "win"):
            return [(p, "win")]
        if status == "push":
            return [(p, "tie")]
        return [(p, "loss")]
    return []


async def _record_result(game: dict) -> None:
    """When a game first reaches a terminal state, tally win/loss/tie for each
    human player. Idempotent via an atomic claim on `stats_recorded`."""
    if game.get("status") in _ACTIVE_STATES or game.get("stats_recorded"):
        return
    claim = await db.chat_games.update_one(
        {"game_id": game["game_id"], "stats_recorded": False},
        {"$set": {"stats_recorded": True}})
    if getattr(claim, "matched_count", 0) != 1:
        return                                     # someone else recorded it
    field = {"win": "wins", "loss": "losses", "tie": "ties"}
    for uid, outcome in _outcomes(game):
        if uid == _CPU or not uid:
            continue
        await db.game_stats.update_one(
            {"user_id": uid},
            {"$inc": {field[outcome]: 1, "games": 1}}, upsert=True)


# ----- Blackjack (player vs dealer/house) -----
_SUITS = ["♠", "♥", "♦", "♣"]
_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]


def _new_deck() -> list:
    deck = [{"r": r, "s": s} for s in _SUITS for r in _RANKS]
    random.shuffle(deck)
    return deck


def _card_value(rank: str) -> int:
    if rank in ("J", "Q", "K"):
        return 10
    if rank == "A":
        return 11
    return int(rank)


def _hand_total(cards: list) -> int:
    total = sum(_card_value(c["r"]) for c in cards)
    aces = sum(1 for c in cards if c["r"] == "A")
    while total > 21 and aces:        # count an ace as 1 instead of 11
        total -= 10
        aces -= 1
    return total


def _dealer_finish(game: dict) -> None:
    """Dealer draws to 17+, then the outcome is decided. Mutates `game`."""
    deck, dealer = game["deck"], game["dealer"]
    while _hand_total(dealer) < 17:
        dealer.append(deck.pop())
    pt, dt = _hand_total(game["player"]), _hand_total(dealer)
    if dt > 21 or pt > dt:
        game["status"] = "win"
    elif pt < dt:
        game["status"] = "lose"
    else:
        game["status"] = "push"


def _blackjack_view(game: dict) -> BlackjackView:
    active = game["status"] == "active"
    dealer = game["dealer"]
    if active:
        # Hide the dealer's hole card (second card) until the hand resolves.
        shown = [dealer[0], {"r": "?", "s": "?"}]
        dealer_total = _card_value(dealer[0]["r"]) if dealer[0]["r"] != "A" else 11
    else:
        shown = dealer
        dealer_total = _hand_total(dealer)
    return BlackjackView(
        game_id=game["game_id"],
        conversation_id=game["conversation_id"],
        player=game["player"],
        dealer=shown,
        player_total=_hand_total(game["player"]),
        dealer_total=dealer_total,
        status=game["status"],
        updated_at=game["updated_at"],
    )


# ----- Chess -----
def _chess_view(game: dict) -> ChessView:
    st = game["chess"]
    white = st["turn"] == "w"
    status = game.get("status") or ce.status(st)
    winner = None
    if status == "checkmate":
        # The side to move is checkmated, so the other player won.
        winner = game["black_player"] if white else game["white_player"]
    return ChessView(
        game_id=game["game_id"],
        conversation_id=game["conversation_id"],
        board=st["board"],
        white_player=game["white_player"],
        black_player=game["black_player"],
        turn=game["white_player"] if white else game["black_player"],
        in_check=ce.in_check(st, white),
        status=status,
        winner=winner,
        updated_at=game["updated_at"],
    )


def _checkers_view(game: dict) -> CheckersView:
    st = game["checkers"]
    white = st["turn"] == "w"
    status = game.get("status") or "active"
    winner = None
    if status == "white_won":
        winner = game["white_player"]
    elif status == "black_won":
        winner = game["black_player"]
    return CheckersView(
        game_id=game["game_id"],
        conversation_id=game["conversation_id"],
        board=st["board"],
        white_player=game["white_player"],
        black_player=game["black_player"],
        turn=game["white_player"] if white else game["black_player"],
        chain=st.get("chain"),
        status=status,
        winner=winner,
        updated_at=game["updated_at"],
    )


def _poker_view(game: dict) -> PokerView:
    done = game["status"] in ("win", "lose", "push")
    return PokerView(
        game_id=game["game_id"],
        conversation_id=game["conversation_id"],
        you=game["player"],
        opponent=game["cpu"] if done else [_HIDDEN_CARD] * len(game["cpu"]),
        your_hand=pk.hand_name(game["player"]),
        opponent_hand=pk.hand_name(game["cpu"]) if done else None,
        status=game["status"],
        updated_at=game["updated_at"],
    )


def _view(game: dict) -> GameView:
    return GameView(
        game_id=game["game_id"],
        conversation_id=game["conversation_id"],
        game_type=game["game_type"],
        board=game["board"],
        x_player=game["x_player"],
        o_player=game["o_player"],
        turn=game["turn"],
        status=game.get("status", "active"),
        winner=game.get("winner"),
        updated_at=game["updated_at"],
    )


@router.post("/conversations/{conv_id}/chat-games", response_model=Message)
async def create_chat_game(
    conv_id: str, body: GameCreate, authorization: Optional[str] = Header(None)
):
    """Start a game in a DM. The creator is X and moves first; the other
    participant is O. Drops a `game` message both players can play."""
    user = await get_current_user(authorization)
    conv = await _conv_or_404(conv_id, user)
    if body.game_type not in _GAME_TYPES:
        raise HTTPException(status_code=400, detail="Unknown game")
    participants = list(conv.get("participant_ids", []))
    others = [p for p in participants if p != user["user_id"]]
    if conv.get("kind") == "group":
        raise HTTPException(
            status_code=400, detail="Games are for one-on-one chats")
    uid = user["user_id"]
    now = datetime.now(timezone.utc)
    game_id = str(uuid.uuid4())
    base = {
        "id": str(uuid.uuid4()),
        "game_id": game_id,
        "conversation_id": conv_id,
        "game_type": body.game_type,
        "status": "active",
        "stats_recorded": False,
        "created_at": now,
        "updated_at": now,
    }
    notify_other = None

    if body.game_type == "tictactoe":
        # Notes-to-self (no other) or an explicit request plays the computer.
        vs_cpu = body.vs_cpu or len(others) == 0
        if not vs_cpu and len(others) != 1:
            raise HTTPException(
                status_code=400, detail="Games are for one-on-one chats")
        game = {**base, "board": [""] * 9, "x_player": uid,
                "o_player": _CPU if vs_cpu else others[0], "vs_cpu": vs_cpu,
                "turn": uid, "winner": None}
        if not vs_cpu:
            notify_other = (others[0], "🎮 Wants to play tic-tac-toe")
    elif body.game_type == "blackjack":
        # Solo vs the dealer — works anywhere, including notes-to-self.
        deck = _new_deck()
        player = [deck.pop(), deck.pop()]
        dealer = [deck.pop(), deck.pop()]
        status = "active"
        if _hand_total(player) == 21:        # natural blackjack
            status = "push" if _hand_total(dealer) == 21 else "blackjack"
        game = {**base, "deck": deck, "player": player, "dealer": dealer,
                "player_id": uid, "status": status}
    elif body.game_type == "chess":  # strictly two human players
        if len(others) != 1:
            raise HTTPException(
                status_code=400, detail="Chess needs an opponent")
        st = ce.initial_state()
        game = {**base, "chess": st, "white_player": uid,
                "black_player": others[0], "winner": None, "move_count": 0}
        notify_other = (others[0], "♟️ Wants to play chess")
    elif body.game_type == "checkers":  # two human players
        if len(others) != 1:
            raise HTTPException(
                status_code=400, detail="Checkers needs an opponent")
        st = ck.initial_state()
        game = {**base, "checkers": st, "white_player": uid,
                "black_player": others[0], "winner": None, "move_count": 0}
        notify_other = (others[0], "🔴 Wants to play checkers")
    elif body.game_type == "poker":  # five-card draw vs the dealer (anywhere)
        deck = pk.new_deck()
        player = [deck.pop() for _ in range(5)]
        cpu = [deck.pop() for _ in range(5)]
        game = {**base, "deck": deck, "player": player, "cpu": cpu,
                "player_id": uid, "status": "active"}
    else:  # pong / snake — real-time arcade, played on the client
        game = {**base, "player_id": uid}

    await db.chat_games.insert_one(game.copy())
    msg = {
        "id": str(uuid.uuid4()),
        "conversation_id": conv_id,
        "sender_id": uid,
        "type": "game",
        "text": "",
        "game_id": game_id,
        "game_type": body.game_type,
        "deleted": False,
        "reactions": {},
        "created_at": now,
    }
    await db.messages.insert_one(msg.copy())
    await db.conversations.update_one(
        {"id": conv_id, "participant_ids": uid},
        {"$set": {"last_message_at": now},
         "$pull": {"deleted_by": {"$in": participants}}},
    )
    if notify_other:
        try:
            await emit_notification(
                user_id=notify_other[0], actor_id=uid, ntype="message",
                conversation_id=conv_id, message=notify_other[1])
        except Exception:
            pass
    return Message(**_decrypt_msg(msg))


@router.post("/chat-games/{game_id}/move", response_model=GameView)
async def play_move(
    game_id: str, body: GameMove, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    game = await db.chat_games.find_one({"game_id": game_id}, {"_id": 0})
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    await _conv_or_404(game["conversation_id"], user)
    if game.get("game_type") != "tictactoe":
        raise HTTPException(status_code=400, detail="Not a tic-tac-toe game")
    uid = user["user_id"]
    if uid not in (game["x_player"], game["o_player"]):
        raise HTTPException(status_code=403, detail="You're not in this game")
    if game.get("status") != "active":
        raise HTTPException(status_code=409, detail="The game is over")
    if game["turn"] != uid:
        raise HTTPException(status_code=409, detail="Not your turn")
    cell = body.cell
    if not isinstance(cell, int) or cell < 0 or cell > 8:
        raise HTTPException(status_code=400, detail="Invalid cell")
    board = list(game["board"])
    if board[cell]:
        raise HTTPException(status_code=409, detail="Cell already taken")
    mark = "X" if uid == game["x_player"] else "O"
    board[cell] = mark
    now = datetime.now(timezone.utc)
    patch = {"board": board, "updated_at": now}
    win = _winner_mark(board)
    if win:
        patch["status"] = "won"
        patch["winner"] = uid
        patch["turn"] = uid
    elif all(board):
        patch["status"] = "draw"
        patch["turn"] = ""
    else:
        other = game["o_player"] if uid == game["x_player"] else game["x_player"]
        patch["turn"] = other
    # Atomic claim on the turn so two quick taps can't both land a move.
    claim = await db.chat_games.update_one(
        {"game_id": game_id, "turn": uid, "status": "active"},
        {"$set": patch})
    if getattr(claim, "matched_count", 0) != 1:
        raise HTTPException(status_code=409, detail="Move no longer valid")
    updated = await db.chat_games.find_one({"game_id": game_id}, {"_id": 0})
    await _record_result(updated)
    # The CPU's reply is NOT played here — the client calls /cpu-move after a
    # short "thinking" pause so the computer doesn't respond instantly.
    return _view(updated)


@router.post("/chat-games/{game_id}/cpu-move", response_model=GameView)
async def cpu_move(game_id: str, authorization: Optional[str] = Header(None)):
    """Play the computer's pending move. The client calls this after a brief
    delay so the response feels deliberate rather than instant. Idempotent: if
    it isn't the CPU's turn, the current state is returned unchanged."""
    user = await get_current_user(authorization)
    game = await db.chat_games.find_one({"game_id": game_id}, {"_id": 0})
    if not game or game.get("game_type") != "tictactoe":
        raise HTTPException(status_code=404, detail="Game not found")
    await _conv_or_404(game["conversation_id"], user)
    if game.get("vs_cpu") and game.get("status") == "active" \
            and game.get("turn") == _CPU:
        game = await _play_cpu(game)
    await _record_result(game)
    return _view(game)


async def _play_cpu(game: dict) -> dict:
    """Apply the computer's move (it plays O) and hand the turn back."""
    cell = _cpu_move(game["board"], me="O", opp="X")
    if cell is None:
        return game
    board = list(game["board"])
    board[cell] = "O"
    now = datetime.now(timezone.utc)
    patch = {"board": board, "updated_at": now}
    if _winner_mark(board):
        patch["status"] = "won"
        patch["winner"] = _CPU
        patch["turn"] = _CPU
    elif all(board):
        patch["status"] = "draw"
        patch["turn"] = ""
    else:
        patch["turn"] = game["x_player"]
    await db.chat_games.update_one(
        {"game_id": game["game_id"], "turn": _CPU, "status": "active"},
        {"$set": patch})
    return await db.chat_games.find_one({"game_id": game["game_id"]}, {"_id": 0})


@router.get("/chat-games/{game_id}", response_model=GameView)
async def get_chat_game(
    game_id: str, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    game = await db.chat_games.find_one({"game_id": game_id}, {"_id": 0})
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    await _conv_or_404(game["conversation_id"], user)
    return _view(game)


# ===== Blackjack =====
async def _load_blackjack(game_id: str, user: dict) -> dict:
    game = await db.chat_games.find_one({"game_id": game_id}, {"_id": 0})
    if not game or game.get("game_type") != "blackjack":
        raise HTTPException(status_code=404, detail="Game not found")
    await _conv_or_404(game["conversation_id"], user)
    if game.get("player_id") != user["user_id"]:
        raise HTTPException(status_code=403, detail="Not your game")
    return game


@router.post("/chat-games/{game_id}/blackjack/hit", response_model=BlackjackView)
async def blackjack_hit(
    game_id: str, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    game = await _load_blackjack(game_id, user)
    if game["status"] != "active":
        raise HTTPException(status_code=409, detail="The hand is over")
    game["player"].append(game["deck"].pop())
    total = _hand_total(game["player"])
    if total > 21:
        game["status"] = "lose"            # bust
    elif total == 21:
        _dealer_finish(game)               # nothing to gain — stand automatically
    game["updated_at"] = datetime.now(timezone.utc)
    await db.chat_games.update_one(
        {"game_id": game_id},
        {"$set": {"deck": game["deck"], "player": game["player"],
                  "dealer": game["dealer"], "status": game["status"],
                  "updated_at": game["updated_at"]}})
    await _record_result(game)
    return _blackjack_view(game)


@router.post("/chat-games/{game_id}/blackjack/stand", response_model=BlackjackView)
async def blackjack_stand(
    game_id: str, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    game = await _load_blackjack(game_id, user)
    if game["status"] != "active":
        raise HTTPException(status_code=409, detail="The hand is over")
    _dealer_finish(game)
    game["updated_at"] = datetime.now(timezone.utc)
    await db.chat_games.update_one(
        {"game_id": game_id},
        {"$set": {"deck": game["deck"], "dealer": game["dealer"],
                  "status": game["status"], "updated_at": game["updated_at"]}})
    await _record_result(game)
    return _blackjack_view(game)


@router.get("/chat-games/{game_id}/blackjack", response_model=BlackjackView)
async def get_blackjack(
    game_id: str, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    game = await db.chat_games.find_one({"game_id": game_id}, {"_id": 0})
    if not game or game.get("game_type") != "blackjack":
        raise HTTPException(status_code=404, detail="Game not found")
    await _conv_or_404(game["conversation_id"], user)
    return _blackjack_view(game)


# ===== Chess =====
@router.post("/chat-games/{game_id}/chess/move", response_model=ChessView)
async def chess_move(
    game_id: str, body: ChessMoveBody, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    game = await db.chat_games.find_one({"game_id": game_id}, {"_id": 0})
    if not game or game.get("game_type") != "chess":
        raise HTTPException(status_code=404, detail="Game not found")
    await _conv_or_404(game["conversation_id"], user)
    uid = user["user_id"]
    if uid not in (game["white_player"], game["black_player"]):
        raise HTTPException(status_code=403, detail="You're not in this game")
    if game.get("status") != "active":
        raise HTTPException(status_code=409, detail="The game is over")
    st = game["chess"]
    mover = game["white_player"] if st["turn"] == "w" else game["black_player"]
    if uid != mover:
        raise HTTPException(status_code=409, detail="Not your turn")
    nxt = ce.apply_move(st, body.from_sq, body.to_sq, body.promotion)
    if nxt is None:
        raise HTTPException(status_code=400, detail="Illegal move")
    new_status = ce.status(nxt)
    moves = game.get("move_count", 0)
    patch = {"chess": nxt, "move_count": moves + 1,
             "updated_at": datetime.now(timezone.utc)}
    if new_status in ("checkmate", "stalemate", "draw"):
        patch["status"] = new_status
        patch["winner"] = uid if new_status == "checkmate" else None
    # Version guard (top-level fields only): the board we read must still be the
    # current one, so two submissions can't both land.
    claim = await db.chat_games.update_one(
        {"game_id": game_id, "status": "active", "move_count": moves},
        {"$set": patch})
    if getattr(claim, "matched_count", 0) != 1:
        raise HTTPException(status_code=409, detail="Move no longer valid")
    updated = await db.chat_games.find_one({"game_id": game_id}, {"_id": 0})
    await _record_result(updated)
    return _chess_view(updated)


@router.get("/chat-games/{game_id}/chess", response_model=ChessView)
async def get_chess(
    game_id: str, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    game = await db.chat_games.find_one({"game_id": game_id}, {"_id": 0})
    if not game or game.get("game_type") != "chess":
        raise HTTPException(status_code=404, detail="Game not found")
    await _conv_or_404(game["conversation_id"], user)
    return _chess_view(game)


# ===== Checkers =====
@router.post("/chat-games/{game_id}/checkers/move", response_model=CheckersView)
async def checkers_move(
    game_id: str, body: CheckersMoveBody, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    game = await db.chat_games.find_one({"game_id": game_id}, {"_id": 0})
    if not game or game.get("game_type") != "checkers":
        raise HTTPException(status_code=404, detail="Game not found")
    await _conv_or_404(game["conversation_id"], user)
    uid = user["user_id"]
    if uid not in (game["white_player"], game["black_player"]):
        raise HTTPException(status_code=403, detail="You're not in this game")
    if game.get("status") != "active":
        raise HTTPException(status_code=409, detail="The game is over")
    st = game["checkers"]
    mover = game["white_player"] if st["turn"] == "w" else game["black_player"]
    if uid != mover:
        raise HTTPException(status_code=409, detail="Not your turn")
    nxt = ck.apply_move(st, body.from_sq, body.to_sq)
    if nxt is None:
        raise HTTPException(status_code=400, detail="Illegal move")
    new_status = ck.status(nxt)
    moves = game.get("move_count", 0)
    patch = {"checkers": nxt, "move_count": moves + 1,
             "updated_at": datetime.now(timezone.utc)}
    if new_status != "active":
        patch["status"] = new_status
    claim = await db.chat_games.update_one(
        {"game_id": game_id, "status": "active", "move_count": moves},
        {"$set": patch})
    if getattr(claim, "matched_count", 0) != 1:
        raise HTTPException(status_code=409, detail="Move no longer valid")
    updated = await db.chat_games.find_one({"game_id": game_id}, {"_id": 0})
    await _record_result(updated)
    return _checkers_view(updated)


@router.get("/chat-games/{game_id}/checkers", response_model=CheckersView)
async def get_checkers(
    game_id: str, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    game = await db.chat_games.find_one({"game_id": game_id}, {"_id": 0})
    if not game or game.get("game_type") != "checkers":
        raise HTTPException(status_code=404, detail="Game not found")
    await _conv_or_404(game["conversation_id"], user)
    return _checkers_view(game)


# ===== Poker (five-card draw vs the dealer) =====
async def _load_poker(game_id: str, user: dict) -> dict:
    game = await db.chat_games.find_one({"game_id": game_id}, {"_id": 0})
    if not game or game.get("game_type") != "poker":
        raise HTTPException(status_code=404, detail="Game not found")
    await _conv_or_404(game["conversation_id"], user)
    if game.get("player_id") != user["user_id"]:
        raise HTTPException(status_code=403, detail="Not your game")
    return game


@router.post("/chat-games/{game_id}/poker/draw", response_model=PokerView)
async def poker_draw(
    game_id: str, body: PokerDrawBody, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    game = await _load_poker(game_id, user)
    if game["status"] != "active":
        raise HTTPException(status_code=409, detail="Already drawn")
    game["player"] = pk.draw(game["deck"], game["player"], body.holds)
    game["status"] = "revealing"
    game["updated_at"] = datetime.now(timezone.utc)
    await db.chat_games.update_one(
        {"game_id": game_id},
        {"$set": {"deck": game["deck"], "player": game["player"],
                  "status": "revealing", "updated_at": game["updated_at"]}})
    return _poker_view(game)


@router.post("/chat-games/{game_id}/poker/reveal", response_model=PokerView)
async def poker_reveal(
    game_id: str, authorization: Optional[str] = Header(None)
):
    """The dealer draws and the hands are shown. Called by the client after a
    short pause so the dealer doesn't act instantly."""
    user = await get_current_user(authorization)
    game = await _load_poker(game_id, user)
    if game["status"] != "revealing":
        return _poker_view(game)
    game["cpu"] = pk.draw(game["deck"], game["cpu"], pk.cpu_holds(game["cpu"]))
    result = pk.compare(game["player"], game["cpu"])
    game["status"] = "win" if result > 0 else ("lose" if result < 0 else "push")
    game["updated_at"] = datetime.now(timezone.utc)
    await db.chat_games.update_one(
        {"game_id": game_id},
        {"$set": {"deck": game["deck"], "cpu": game["cpu"],
                  "status": game["status"], "updated_at": game["updated_at"]}})
    await _record_result(game)
    return _poker_view(game)


@router.get("/chat-games/{game_id}/poker", response_model=PokerView)
async def get_poker(
    game_id: str, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    game = await _load_poker(game_id, user)
    return _poker_view(game)


# ===== Arcade (Pong / Snake) — high scores, compared between players =====
@router.post("/chat-games/{game_id}/score", response_model=GameScores)
async def report_arcade_score(
    game_id: str, body: GameScoreBody, authorization: Optional[str] = Header(None)
):
    """Client reports an arcade score; the player's best for that game type is
    kept so two people can compare who has the higher score."""
    user = await get_current_user(authorization)
    game = await db.chat_games.find_one({"game_id": game_id}, {"_id": 0})
    if not game or game.get("game_type") not in _LOCAL_TYPES:
        raise HTTPException(status_code=404, detail="Game not found")
    await _conv_or_404(game["conversation_id"], user)
    if game.get("player_id") != user["user_id"]:
        raise HTTPException(status_code=403, detail="Not your game")
    uid = user["user_id"]
    gt = game["game_type"]
    score = max(0, int(body.score))
    existing = await db.game_scores.find_one(
        {"user_id": uid, "game_type": gt}, {"_id": 0})
    best = max(score, (existing or {}).get("best", 0))
    await db.game_scores.update_one(
        {"user_id": uid, "game_type": gt},
        {"$set": {"user_id": uid, "game_type": gt, "best": best}}, upsert=True)
    return await get_game_scores(uid, authorization)


@router.get("/game-scores/{user_id}", response_model=GameScores)
async def get_game_scores(
    user_id: str, authorization: Optional[str] = Header(None)
):
    """A player's best score per arcade game type."""
    await get_current_user(authorization)
    rows = await db.game_scores.find(
        {"user_id": user_id}, {"_id": 0}).to_list(50)
    return GameScores(
        user_id=user_id,
        scores={r["game_type"]: r["best"] for r in rows if r.get("game_type")})


@router.get("/game-stats/{user_id}", response_model=GameStats)
async def get_game_stats(
    user_id: str, authorization: Optional[str] = Header(None)
):
    """A player's all-games win/loss/tie record."""
    await get_current_user(authorization)
    row = await db.game_stats.find_one({"user_id": user_id}, {"_id": 0}) or {}
    return GameStats(
        user_id=user_id,
        wins=row.get("wins", 0),
        losses=row.get("losses", 0),
        ties=row.get("ties", 0),
        games=row.get("games", 0),
    )
