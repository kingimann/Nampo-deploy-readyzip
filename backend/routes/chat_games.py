"""In-chat games (iMessage / GamePigeon style).

A turn-based game lives in a conversation and is surfaced as a `game` message
both players watch and play. The first game is tic-tac-toe. Polling-based: the
chat already polls, and each move POSTs the new board. Kept separate from the
mini-games *platform* (routes/games.py) — different collection, different paths.
"""
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Header, HTTPException

from core import db, get_current_user
from models import GameCreate, GameMove, GameView, Message
from routes.messaging import _decrypt_msg
from routes.notifications import emit_notification

router = APIRouter()

_GAME_TYPES = {"tictactoe"}
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
    # A notes-to-self chat (no other participant) — or an explicit request —
    # plays against the computer. Otherwise it's the one other person.
    vs_cpu = body.vs_cpu or len(others) == 0
    if not vs_cpu and len(others) != 1:
        raise HTTPException(
            status_code=400, detail="Games are for one-on-one chats")
    now = datetime.now(timezone.utc)
    game_id = str(uuid.uuid4())
    game = {
        "id": str(uuid.uuid4()),
        "game_id": game_id,
        "conversation_id": conv_id,
        "game_type": body.game_type,
        "board": [""] * 9,
        "x_player": user["user_id"],   # creator goes first
        "o_player": _CPU if vs_cpu else others[0],
        "vs_cpu": vs_cpu,
        "turn": user["user_id"],
        "status": "active",
        "winner": None,
        "created_at": now,
        "updated_at": now,
    }
    await db.chat_games.insert_one(game.copy())
    msg = {
        "id": str(uuid.uuid4()),
        "conversation_id": conv_id,
        "sender_id": user["user_id"],
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
        {"id": conv_id, "participant_ids": user["user_id"]},
        {"$set": {"last_message_at": now},
         "$pull": {"deleted_by": {"$in": participants}}},
    )
    if not vs_cpu:
        try:
            await emit_notification(
                user_id=others[0], actor_id=user["user_id"], ntype="message",
                conversation_id=conv_id, message="🎮 Wants to play tic-tac-toe")
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
    # Against the computer, play its reply immediately so the move response
    # already shows the board back in the human's court.
    if updated.get("vs_cpu") and updated.get("status") == "active" \
            and updated.get("turn") == _CPU:
        updated = await _play_cpu(updated)
    return _view(updated)


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
