# brAIn-games

Game nodes that turn the brAIn chat bus into a multi-surface playground. Spawn a `hangman` node and any chat surface plugged into the bus — web chat, telegram, whatsapp, discord — becomes a place to play.

| Node | Status | What the LLM brings |
|---|---|---|
| `hangman` | ✅ working | picks themed words, gives flavorful hints, narrates each guess |
| `tictactoe` | planned | playable opponent + commentary |
| `pet` | planned | persistent companion that talks back on a timer (Tamagotchi-style) |

## Bus contract

Each game subscribes to `chat.input` (so guesses can come from any platform) plus a per-game `game.<name>.command` topic for explicit start / hint / quit commands published by the UI. State broadcasts go on `game.<name>.state`, and player-facing narration is published on `chat.response` so every connected bridge picks it up like any other brain reply.

```
   web chat ─┐
   telegram ─┼─ chat.input ─► hangman ──► chat.response ──► all surfaces
   whatsapp ─┤                  │  ▲
   discord  ─┘                  │  └── game.hangman.command (UI buttons)
                                ▼
                         game.hangman.state (board / lives / tried)
```

## Per-node UI

Each game has `has_ui: true` and ships a single-page HTML — board / status / inputs. The same game is mirrored across every chat surface at the same time; the UI is for visual playing and admin (theme picker, hint button, abandon).
