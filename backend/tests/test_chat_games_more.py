"""Behavioural tests for blackjack and chess in chat (routes.chat_games)."""
import pytest
from fastapi import HTTPException

from routes import chat_games as games
from models import (
    GameCreate, ChessMoveBody, CheckersMoveBody, PokerDrawBody,
)
from services import checkers_engine as ck
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
        {"id": "self", "kind": "dm", "participant_ids": ["alice"]},
    ]
    return db, monkeypatch


def _as(monkeypatch, uid):
    async def _get(_a):
        return {"user_id": uid, "name": uid.title()}
    monkeypatch.setattr(games, "get_current_user", _get)


# ----- Blackjack -----

@pytest.mark.asyncio
async def test_blackjack_deal_and_view(env):
    db, mp = env
    _as(mp, "alice")
    msg = await games.create_chat_game("self", GameCreate(game_type="blackjack"))
    gid = msg.game_id
    view = await games.get_blackjack(gid)
    assert len(view.player) == 2
    # While active, the dealer's hole card is hidden.
    if view.status == "active":
        assert view.dealer[1]["r"] == "?"


@pytest.mark.asyncio
async def test_blackjack_stand_resolves(env):
    db, mp = env
    _as(mp, "alice")
    msg = await games.create_chat_game("self", GameCreate(game_type="blackjack"))
    gid = msg.game_id
    g = await db.chat_games.find_one({"game_id": gid})
    if g["status"] != "active":
        return  # natural blackjack on the deal; nothing to stand on
    out = await games.blackjack_stand(gid)
    assert out.status in ("win", "lose", "push")
    # Dealer is fully revealed and finished on 17+ (or busted).
    assert out.dealer[0]["r"] != "?"
    assert out.dealer_total >= 17 or out.dealer_total > 21 or out.status == "win"


@pytest.mark.asyncio
async def test_blackjack_hit_bust(env):
    db, mp = env
    _as(mp, "alice")
    msg = await games.create_chat_game("self", GameCreate(game_type="blackjack"))
    gid = msg.game_id
    # Force a board guaranteed to bust on the next hit.
    await db.chat_games.update_one({"game_id": gid}, {"$set": {
        "player": [{"r": "K", "s": "♠"}, {"r": "Q", "s": "♥"}],
        "deck": [{"r": "K", "s": "♦"}], "status": "active"}})
    out = await games.blackjack_hit(gid)
    assert out.status == "lose" and out.player_total > 21


# ----- Chess -----

@pytest.mark.asyncio
async def test_chess_needs_opponent(env):
    db, mp = env
    _as(mp, "alice")
    with pytest.raises(HTTPException) as ei:
        await games.create_chat_game("self", GameCreate(game_type="chess"))
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_chess_move_and_turn_enforced(env):
    db, mp = env
    _as(mp, "alice")
    msg = await games.create_chat_game("c1", GameCreate(game_type="chess"))
    gid = msg.game_id
    g = await db.chat_games.find_one({"game_id": gid})
    assert g["white_player"] == "alice" and g["black_player"] == "bob"
    # Black can't move first.
    _as(mp, "bob")
    with pytest.raises(HTTPException) as ei:
        await games.chess_move(gid, ChessMoveBody(from_sq="e7", to_sq="e5"))
    assert ei.value.status_code == 409
    # White opens e2-e4; turn passes to black.
    _as(mp, "alice")
    out = await games.chess_move(gid, ChessMoveBody(from_sq="e2", to_sq="e4"))
    assert out.turn == "bob"
    # An illegal move is rejected.
    _as(mp, "bob")
    with pytest.raises(HTTPException) as ei:
        await games.chess_move(gid, ChessMoveBody(from_sq="e7", to_sq="e3"))
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_chess_checkmate_sets_winner(env):
    db, mp = env
    _as(mp, "alice")
    msg = await games.create_chat_game("c1", GameCreate(game_type="chess"))
    gid = msg.game_id
    # Fool's mate: 1.f3 e5 2.g4 Qh4#
    seq = [("alice", "f2", "f3"), ("bob", "e7", "e5"),
           ("alice", "g2", "g4"), ("bob", "d8", "h4")]
    out = None
    for uid, frm, to in seq:
        _as(mp, uid)
        out = await games.chess_move(gid, ChessMoveBody(from_sq=frm, to_sq=to))
    assert out.status == "checkmate" and out.winner == "bob"


# ----- Checkers -----

@pytest.mark.asyncio
async def test_checkers_needs_opponent(env):
    db, mp = env
    _as(mp, "alice")
    with pytest.raises(HTTPException) as ei:
        await games.create_chat_game("self", GameCreate(game_type="checkers"))
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_checkers_move_and_turn(env):
    db, mp = env
    _as(mp, "alice")
    msg = await games.create_chat_game("c1", GameCreate(game_type="checkers"))
    gid = msg.game_id
    g = await db.chat_games.find_one({"game_id": gid})
    assert g["white_player"] == "alice" and g["black_player"] == "bob"
    # Black can't move first (white opens in checkers).
    _as(mp, "bob")
    with pytest.raises(HTTPException) as ei:
        await games.checkers_move(
            gid, CheckersMoveBody(from_sq=ck._sq(1, 2), to_sq=ck._sq(0, 3)))
    assert ei.value.status_code == 409
    # White makes a legal opening step; the turn passes to black. A front white
    # man sits at (2,5) and can step up to (3,4).
    _as(mp, "alice")
    out = await games.checkers_move(
        gid, CheckersMoveBody(from_sq=ck._sq(2, 5), to_sq=ck._sq(3, 4)))
    assert out.turn == "bob"
    assert out.board[ck._sq(3, 4)] == "w"


# ----- Poker -----

@pytest.mark.asyncio
async def test_poker_draw_then_reveal(env):
    db, mp = env
    _as(mp, "alice")
    msg = await games.create_chat_game("self", GameCreate(game_type="poker"))
    gid = msg.game_id
    view = await games.get_poker(gid)
    assert len(view.you) == 5
    # Opponent hidden before showdown.
    assert all(c["r"] == "?" for c in view.opponent)
    drawn = await games.poker_draw(gid, PokerDrawBody(holds=[0, 1]))
    assert drawn.status == "revealing"
    final = await games.poker_reveal(gid)
    assert final.status in ("win", "lose", "push")
    assert all(c["r"] != "?" for c in final.opponent)   # revealed
    assert final.opponent_hand is not None
