import type {
  NodeContext,
  NodeHandler,
  TextPayload,
} from "@brain/sdk";
import { LLMRegistry, generateText } from "@brain/core";

const DEFAULT_MODEL = "ollama/gemma4:e4b";

export type Mark = "X" | "O";
export type Cell = Mark | null;
export type GameStatus = "idle" | "playing" | "won" | "tie";

export interface GameState {
  status: GameStatus;
  board: Cell[];       // length 9, indexed 0..8 (numpad-style: 1..9 = index 0..8)
  player: Mark;        // which mark the human plays
  llm: Mark;           // which mark the LLM plays
  turn: Mark;          // whose turn it is
  winner: Mark | "tie" | null;
  winning_line: number[] | null; // indices of the 3 winning cells, or null
  started_at: number | null;
  ended_at: number | null;
  move_count: number;
}

export type ControlAction = "start" | "quit" | "status";

export interface ControlPayload {
  action?: ControlAction;
  mark?: Mark;
}

const WIN_LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],   // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8],   // cols
  [0, 4, 8], [2, 4, 6],              // diagonals
];

function emptyState(player: Mark = "X"): GameState {
  return {
    status: "idle",
    board: Array<Cell>(9).fill(null),
    player,
    llm: player === "X" ? "O" : "X",
    turn: "X", // X always moves first by tic-tac-toe convention
    winner: null,
    winning_line: null,
    started_at: null,
    ended_at: null,
    move_count: 0,
  };
}

function getState(ctx: NodeContext): GameState {
  const existing = ctx.state.game as GameState | undefined;
  if (existing) return existing;
  const fresh = emptyState();
  ctx.state.game = fresh;
  return fresh;
}

/** Convert a 1-based numpad index (1..9) to a 0-based board index. */
export function parseCell(input: string): number | null {
  const s = input.trim();
  if (!/^[1-9]$/.test(s)) return null;
  return parseInt(s, 10) - 1;
}

/** Indices of every empty cell. */
export function emptyCells(board: Cell[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 9; i++) if (board[i] === null) out.push(i);
  return out;
}

/** Returns the winning mark + the three cells in line, or null if no winner yet. */
export function checkWin(board: Cell[]): { mark: Mark; line: number[] } | null {
  for (const [a, b, c] of WIN_LINES) {
    const v = board[a];
    if (v && board[b] === v && board[c] === v) {
      return { mark: v, line: [a, b, c] };
    }
  }
  return null;
}

/** A pretty multi-line board for the chat narration (Markdown-friendly). */
export function renderBoard(board: Cell[]): string {
  const cell = (i: number) => board[i] ?? String(i + 1);
  return [
    ` ${cell(0)} | ${cell(1)} | ${cell(2)}`,
    `-----------`,
    ` ${cell(3)} | ${cell(4)} | ${cell(5)}`,
    `-----------`,
    ` ${cell(6)} | ${cell(7)} | ${cell(8)}`,
  ].join("\n");
}

/** Best-move heuristic: center → corners → edges. Used when the LLM declines. */
export function pickFallbackMove(board: Cell[]): number {
  const order = [4, 0, 2, 6, 8, 1, 3, 5, 7];
  for (const i of order) if (board[i] === null) return i;
  return 0;
}

const LLM_MOVE_SYSTEM = [
  "You are playing tic-tac-toe.",
  "The board cells are numbered 1-9 like a numpad keypad:",
  " 1 | 2 | 3",
  " 4 | 5 | 6",
  " 7 | 8 | 9",
  "Reply with EXACTLY one digit (1-9) — the cell you choose. No words, no explanation.",
  "Goals (in order): win if you can in one move, block your opponent's winning move, take the center, take a corner.",
].join("\n");

async function callLLM(
  modelName: string,
  system: string,
  user: string,
  signal: AbortSignal,
  maxOutputTokens = 8,
): Promise<string | null> {
  const registry = LLMRegistry.getInstance();
  await registry.initialize();
  const model = registry.getModel(modelName);
  const result = await generateText({
    model,
    system,
    messages: [{ role: "user", content: user }],
    maxOutputTokens,
    abortSignal: signal,
  });
  const r = result as unknown as Record<string, unknown>;
  if (typeof result.text === "string" && result.text) return result.text;
  if (Array.isArray(r.steps) && r.steps.length > 0) {
    const s = r.steps[0] as Record<string, unknown>;
    if (typeof s.text === "string") return s.text;
  }
  return null;
}

async function pickLlmMove(ctx: NodeContext, state: GameState): Promise<number> {
  const model = (ctx.node.config_overrides?.model as string | undefined) ?? DEFAULT_MODEL;
  const available = emptyCells(state.board).map((i) => i + 1).join(", ");
  const prompt = [
    `You play ${state.llm}. Opponent plays ${state.player}.`,
    "",
    "Current board:",
    renderBoard(state.board),
    "",
    `Available cells: ${available}`,
    "Pick the best cell.",
  ].join("\n");
  try {
    const text = await callLLM(model, LLM_MOVE_SYSTEM, prompt, ctx.signal);
    const match = text?.match(/[1-9]/);
    if (match) {
      const cell = parseInt(match[0], 10) - 1;
      if (state.board[cell] === null) return cell;
    }
  } catch (err) {
    ctx.log("warn", `tictactoe: LLM move failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Fallback (LLM picked a taken cell, junk, or threw): heuristic.
  return pickFallbackMove(state.board);
}

function publishState(ctx: NodeContext, state: GameState): void {
  ctx.publish("game.tictactoe.state", {
    type: "text",
    criticality: 1,
    payload: { content: JSON.stringify(state) },
  });
}

function narrate(ctx: NodeContext, text: string): void {
  ctx.publish("chat.response", {
    type: "text",
    criticality: 3,
    payload: { content: text },
    metadata: { from_game: "tictactoe" },
  });
}

function applyMove(state: GameState, idx: number, mark: Mark): void {
  state.board[idx] = mark;
  state.move_count += 1;
  const win = checkWin(state.board);
  if (win) {
    state.status = "won";
    state.winner = win.mark;
    state.winning_line = win.line;
    state.ended_at = Date.now();
    return;
  }
  if (state.move_count >= 9) {
    state.status = "tie";
    state.winner = "tie";
    state.ended_at = Date.now();
    return;
  }
  state.turn = state.turn === "X" ? "O" : "X";
}

async function maybePlayLlmTurn(ctx: NodeContext, state: GameState): Promise<void> {
  while (state.status === "playing" && state.turn === state.llm) {
    narrate(ctx, `🤖 ${state.llm} thinking…`);
    publishState(ctx, state);
    const cell = await pickLlmMove(ctx, state);
    applyMove(state, cell, state.llm);
    publishState(ctx, state);
    narrate(ctx, `🤖 ${state.llm} played cell *${cell + 1}*.\n\`\`\`\n${renderBoard(state.board)}\n\`\`\``);
    if (state.status !== "playing") {
      announceEnd(ctx, state);
      return;
    }
  }
}

function announceEnd(ctx: NodeContext, state: GameState): void {
  if (state.winner === "tie") {
    narrate(ctx, `🤝 Tie game. \`game.tictactoe.command {action:'start'}\` to play again.`);
  } else if (state.winner === state.player) {
    narrate(ctx, `🎉 You win! Beat me ${state.player} vs ${state.llm}.`);
  } else {
    narrate(ctx, `💀 I win — ${state.llm} got three in a row. Rematch?`);
  }
}

async function startGame(ctx: NodeContext, requestedMark: Mark | null): Promise<void> {
  const player = requestedMark ?? "X";
  const state: GameState = emptyState(player);
  state.status = "playing";
  state.started_at = Date.now();
  ctx.state.game = state;
  publishState(ctx, state);
  narrate(ctx, `🎮 Tic-tac-toe — you are *${state.player}*, I'm *${state.llm}*. X starts.\n\`\`\`\n${renderBoard(state.board)}\n\`\`\``);
  if (state.turn === state.llm) {
    await maybePlayLlmTurn(ctx, state);
  } else {
    narrate(ctx, `Your move — pick a cell 1-9.`);
  }
}

async function handlePlayerMove(ctx: NodeContext, state: GameState, cell: number): Promise<void> {
  if (state.turn !== state.player) {
    narrate(ctx, `Not your turn — wait for ${state.llm}.`);
    return;
  }
  if (state.board[cell] !== null) {
    narrate(ctx, `Cell *${cell + 1}* is already taken (${state.board[cell]}). Pick a free one.`);
    return;
  }
  applyMove(state, cell, state.player);
  publishState(ctx, state);
  narrate(ctx, `✅ ${state.player} → cell *${cell + 1}*.\n\`\`\`\n${renderBoard(state.board)}\n\`\`\``);
  if (state.status !== "playing") {
    announceEnd(ctx, state);
    return;
  }
  await maybePlayLlmTurn(ctx, state);
}

/**
 * Parse a control payload either as strict JSON (`{action, mark?}`) or as a
 * loose natural string the brain might emit ("start", "start O", "quit").
 */
export function parseControl(content: string | undefined, metaFallback?: ControlPayload): ControlPayload {
  const raw = (content ?? "").trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ControlPayload;
      if (parsed && typeof parsed === "object" && parsed.action) return parsed;
    } catch { /* not JSON */ }
    const m = raw.match(/^(start|quit|stop|abandon|status)\b\s*(.*)$/i);
    if (m) {
      const verb = m[1].toLowerCase();
      const action: ControlAction =
        verb === "stop" || verb === "abandon" ? "quit" :
        (verb as ControlAction);
      const rest = m[2]?.trim().toUpperCase();
      const out: ControlPayload = { action };
      if (action === "start" && (rest === "X" || rest === "O")) out.mark = rest;
      return out;
    }
  }
  return metaFallback ?? {};
}

export const handler: NodeHandler = async (ctx) => {
  const state = getState(ctx);

  for (const msg of ctx.messages) {
    if (msg.topic === "game.tictactoe.command") {
      const payload = msg.payload as TextPayload;
      const ctrl = parseControl(payload.content, msg.metadata as ControlPayload | undefined);
      if (ctrl.action === "start") {
        await startGame(ctx, ctrl.mark ?? null);
      } else if (ctrl.action === "quit") {
        if (state.status === "playing") narrate(ctx, "Game abandoned.");
        ctx.state.game = emptyState();
        publishState(ctx, ctx.state.game as GameState);
      } else if (ctrl.action === "status") {
        publishState(ctx, state);
      }
      continue;
    }

    if (msg.topic !== "chat.input") continue;
    // Skip our own narrations that loop back through bridges.
    const meta = (msg.metadata ?? {}) as { from_game?: string };
    if (meta.from_game === "tictactoe") continue;

    if (state.status !== "playing") continue;

    const payload = msg.payload as TextPayload;
    const raw = payload?.content?.trim();
    if (!raw) continue;
    const cell = parseCell(raw);
    if (cell === null) continue; // unrelated chat
    await handlePlayerMove(ctx, state, cell);
  }
};

export default handler;
