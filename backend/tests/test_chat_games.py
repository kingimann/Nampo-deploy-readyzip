"""Behavioural tests for in-chat tic-tac-toe (routes.chat_games).

Pins: creating a game (DM only) drops a `game` message and seeds the board;
turns alternate and are enforced; taken cells and out-of-turn moves are
rejected; a winning line ends the game; and only participants can move/read.
"""
import pytest
from fastapi import HTTPException

from routes import chat_games as games
from models import GameCreate, GameMove
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()
    monkeypatch.setattr(games, "db", db)

    async def noop_notify(**kwargs):
        return None

    monkeypatch.setattr(games, "emit_notification", noop_notify)
    db.conversations.docs = [
        {"id": "c1", "kind": "dm", "participant_ids": ["alice", "bob"]},
        {"id": "g1", "kind": "group", "participant_ids": ["alice", "bob", "carol"]},
        {"id": "self", "kind": "dm", "participant_ids": ["alice"]},  # notes-to-self
    ]
    return db, monkeypatch


def _as(monkeypatch, uid):
    async def _get(_a):
        return {"user_id": uid, "name": uid.title()}
    monkeypatch.setattr(games, "get_current_user", _get)


async def _new_game(db, mp):
    _as(mp, "alice")
    msg = await games.create_chat_game("c1", GameCreate(game_type="tictactoe"))
    return msg.game_id


@pytest.mark.asyncio
async def test_create_drops_message_and_board(env):
    db, mp = env
    gid = await _new_game(db, mp)
    assert gid
    game = await db.chat_games.find_one({"game_id": gid})
    assert game["board"] == [""] * 9
    assert game["x_player"] == "alice" and game["o_player"] == "bob"
    assert game["turn"] == "alice"
    assert await db.messages.count_documents(
        {"game_id": gid, "type": "game"}) == 1


@pytest.mark.asyncio
async def test_no_games_in_groups(env):
    db, mp = env
    _as(mp, "alice")
    with pytest.raises(HTTPException) as ei:
        await games.create_chat_game("g1", GameCreate(game_type="tictactoe"))
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_turns_alternate_and_are_enforced(env):
    db, mp = env
    gid = await _new_game(db, mp)
    # Bob can't move first.
    _as(mp, "bob")
    with pytest.raises(HTTPException) as ei:
        await games.play_move(gid, GameMove(cell=0))
    assert ei.value.status_code == 409
    # Alice (X) moves, then it's Bob's turn.
    _as(mp, "alice")
    out = await games.play_move(gid, GameMove(cell=0))
    assert out.board[0] == "X" and out.turn == "bob"
    # Alice can't move twice.
    with pytest.raises(HTTPException) as ei:
        await games.play_move(gid, GameMove(cell=1))
    assert ei.value.status_code == 409
    # Bob takes a cell; can't reuse a taken one.
    _as(mp, "bob")
    with pytest.raises(HTTPException) as ei:
        await games.play_move(gid, GameMove(cell=0))
    assert ei.value.status_code == 409
    out = await games.play_move(gid, GameMove(cell=4))
    assert out.board[4] == "O" and out.turn == "alice"


@pytest.mark.asyncio
async def test_winning_line_ends_game(env):
    db, mp = env
    gid = await _new_game(db, mp)
    # X: 0,1,2 (top row) beats O: 3,4.
    moves = [("alice", 0), ("bob", 3), ("alice", 1), ("bob", 4), ("alice", 2)]
    out = None
    for uid, cell in moves:
        _as(mp, uid)
        out = await games.play_move(gid, GameMove(cell=cell))
    assert out.status == "won" and out.winner == "alice"
    # No more moves once it's over.
    _as(mp, "bob")
    with pytest.raises(HTTPException) as ei:
        await games.play_move(gid, GameMove(cell=5))
    assert ei.value.status_code == 409


@pytest.mark.asyncio
async def test_notes_to_self_plays_the_cpu(env):
    db, mp = env
    _as(mp, "alice")
    # A self-chat (no other participant) starts a game vs the computer.
    msg = await games.create_chat_game("self", GameCreate(game_type="tictactoe"))
    gid = msg.game_id
    game = await db.chat_games.find_one({"game_id": gid})
    assert game["vs_cpu"] is True and game["o_player"] == "cpu"
    # Alice moves; the CPU replies within the same call, handing the turn back.
    out = await games.play_move(gid, GameMove(cell=0))
    assert out.board[0] == "X"
    assert out.board.count("O") == 1          # CPU made exactly one move
    if out.status == "active":
        assert out.turn == "alice"            # back to the human


@pytest.mark.asyncio
async def test_cpu_blocks_a_winning_line(env):
    db, mp = env
    _as(mp, "alice")
    msg = await games.create_chat_game("self", GameCreate(game_type="tictactoe"))
    gid = msg.game_id
    # Set a position where Alice (X) is one move from completing the top row:
    # X at 0, O at 4, and it's Alice's turn. She plays 1 -> threat at 2.
    await db.chat_games.update_one(
        {"game_id": gid},
        {"$set": {"board": ["X", "", "", "", "O", "", "", "", ""],
                  "turn": "alice", "status": "active"}})
    out = await games.play_move(gid, GameMove(cell=1))  # X now at 0,1
    # The CPU must block the 0,1,2 line by taking cell 2.
    assert out.board[2] == "O"


@pytest.mark.asyncio
async def test_non_participant_cannot_move_or_read(env):
    db, mp = env
    gid = await _new_game(db, mp)
    _as(mp, "carol")  # not in c1
    with pytest.raises(HTTPException) as ei:
        await games.play_move(gid, GameMove(cell=0))
    assert ei.value.status_code == 404
    with pytest.raises(HTTPException) as ei:
        await games.get_chat_game(gid)
    assert ei.value.status_code == 404
