import type {
  NodeContext,
  NodeHandler,
  TextPayload,
} from "@brain/sdk";

const MAX_LIVES = 6;

/** Canonical Hangman stick-figure stages. Index = wrong guesses so far (0 = pristine). */
const STAGES = [
  ["  +---+", "  |   |", "      |", "      |", "      |", "      |", "========="],
  ["  +---+", "  |   |", "  O   |", "      |", "      |", "      |", "========="],
  ["  +---+", "  |   |", "  O   |", "  |   |", "      |", "      |", "========="],
  ["  +---+", "  |   |", "  O   |", " /|   |", "      |", "      |", "========="],
  ["  +---+", "  |   |", "  O   |", " /|\\  |", "      |", "      |", "========="],
  ["  +---+", "  |   |", "  O   |", " /|\\  |", " /    |", "      |", "========="],
  ["  +---+", "  |   |", "  O   |", " /|\\  |", " / \\  |", "      |", "========="],
];

export type GameStatus = "idle" | "playing" | "won" | "lost";

export interface GameState {
  status: GameStatus;
  word: string | null;
  theme: string | null;
  tried: string[];     // letters tried (right + wrong), uppercase
  wrong: string[];     // wrong letters only
  lives: number;
  started_at: number | null;
  ended_at: number | null;
  last_guesser?: string | null;
}

export type ControlAction = "start" | "hint" | "quit" | "status" | "guess";

export interface ControlPayload {
  action?: ControlAction;
  /** For action === "start": optional theme (e.g. "cuisine"). */
  theme?: string;
  /** For action === "guess": the letter or full word to play.
   *  classifyGuess() decides if it's a letter or a word based on the
   *  current answer length, so the caller doesn't have to. */
  value?: string;
}

/** Build the masked word as an array of letters or null (still hidden). */
export function maskWord(word: string, tried: string[]): (string | null)[] {
  const triedSet = new Set(tried.map((l) => l.toUpperCase()));
  return word.toUpperCase().split("").map((c) =>
    /[A-Z]/.test(c) ? (triedSet.has(c) ? c : null) : c, // non-letters (space, hyphen) shown
  );
}

/** Has every letter of the word been revealed by the player's guesses? */
export function isSolved(word: string, tried: string[]): boolean {
  return maskWord(word, tried).every((c) => c !== null);
}

/** Joined ASCII representation of the current hangman state for the bus / UI fallback. */
export function renderStage(wrongCount: number): string {
  const idx = Math.min(wrongCount, STAGES.length - 1);
  return STAGES[idx].join("\n");
}

/** Pretty version of the masked word for chat narration ("R _ A C _"). */
export function renderMasked(word: string, tried: string[]): string {
  return maskWord(word, tried).map((c) => c ?? "_").join(" ");
}

/** Single-letter or whole-word guess? Returns the canonical form, or null if neither. */
export function classifyGuess(input: string, wordLen: number): { kind: "letter" | "word"; value: string } | null {
  const s = input.trim();
  if (/^[a-zA-Z]$/.test(s)) return { kind: "letter", value: s.toUpperCase() };
  if (/^[a-zA-Z]+$/.test(s) && s.length === wordLen) return { kind: "word", value: s.toUpperCase() };
  return null;
}

function emptyState(): GameState {
  return {
    status: "idle",
    word: null,
    theme: null,
    tried: [],
    wrong: [],
    lives: MAX_LIVES,
    started_at: null,
    ended_at: null,
    last_guesser: null,
  };
}

function getState(ctx: NodeContext): GameState {
  const existing = ctx.state.game as GameState | undefined;
  if (existing) return existing;
  const fresh = emptyState();
  ctx.state.game = fresh;
  return fresh;
}

/** Publish a UI-bound state snapshot. We never publish the answer when the
 *  game is still active — only mask + tried letters — so chat surfaces
 *  can't leak it via metadata inspection. */
function publishState(ctx: NodeContext, state: GameState): void {
  const ended = state.status === "won" || state.status === "lost";
  ctx.publish("game.hangman.state", {
    type: "text",
    criticality: 1,
    payload: { content: JSON.stringify({
      status: state.status,
      theme: state.theme,
      masked: state.word ? renderMasked(state.word, state.tried) : null,
      tried: state.tried,
      wrong: state.wrong,
      lives: state.lives,
      max_lives: MAX_LIVES,
      stage: renderStage(state.wrong.length),
      // Only reveal the answer once the game is over.
      word: ended ? state.word : null,
      started_at: state.started_at,
      ended_at: state.ended_at,
    }) },
  });
}

/** Narration through chat.response — visible on every connected surface. */
function narrate(ctx: NodeContext, text: string): void {
  // Game events go to the brain via game.hangman.event — the brain is
  // the sole gateway that relays to the user on chat.response. Keeps
  // a single voice in the chat surface (the brain's), and avoids the
  // double-fire we got when the game published on chat.response itself.
  ctx.publish("game.hangman.event", {
    type: "text",
    criticality: 3,
    payload: { content: text },
    metadata: { from_game: "hangman" },
  });
}

// We don't ask the LLM for free text — we hand it a single tool with a
// strict schema and let ai-sdk validate. That way `pick_hangman_word`
// can ONLY emit a valid 4–12 letter alphabetic word; if the model
// would have replied with a sentence, ai-sdk forces it through the
// tool shape instead. No regex extraction, no half-parsed fallbacks.
const PICK_WORD_SYSTEM = [
  "You are picking ONE word for a Hangman round.",
  "The word must be common-enough that a fluent English speaker recognises it.",
  "Use the `pick_hangman_word` tool — that is the only valid response.",
].join("\n");

async function pickWord(ctx: NodeContext, theme: string | null): Promise<string | null> {
  const userPrompt = theme
    ? `A new Hangman round is starting. Pick ONE good word about: ${theme}.`
    : `A new Hangman round is starting. Pick ONE interesting word.`;
  try {
    const result = await ctx.llm.tool({
      tool: {
        name: "pick_hangman_word",
        description: "Pick exactly one word for the upcoming Hangman round.",
        inputSchema: {
          type: "object",
          required: ["word"],
          additionalProperties: false,
          properties: {
            word: {
              type: "string",
              minLength: 4,
              maxLength: 12,
              description: "The chosen word: 4 to 12 alphabetic letters, no spaces / hyphens / digits. Case doesn't matter.",
            },
          },
        },
      },
      system: PICK_WORD_SYSTEM,
      prompt: userPrompt,
      // Thinking-capable local models (gemma4) burn tokens on internal
      // reasoning BEFORE emitting the tool call. 64 tokens isn't enough
      // and the response gets cut off mid-thinking with no tool call at
      // all. Give them headroom.
      maxTokens: 512,
    });
    // Normalise + validate ourselves — keep the LLM tool schema permissive
    // (models emit TitleCase, UPPER, accents, trailing punctuation) and
    // apply the alphabetic-only rule in code. Strip diacritics so picks
    // like "réseau" become "reseau" and pass.
    const raw = String((result.args as { word?: unknown }).word ?? "")
      .trim()
      .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip accents
      .toLowerCase();
    return /^[a-z]{4,12}$/.test(raw) ? raw : null;
  } catch (err) {
    ctx.log("warn", `hangman: LLM pick word failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function pickHint(ctx: NodeContext, state: GameState): Promise<string | null> {
  if (!state.word) return null;
  const masked = renderMasked(state.word, state.tried);
  const system = [
    "You are a Hangman hint assistant.",
    "Give ONE short, playful hint about the word — without revealing it directly.",
    "Two sentences max. Never mention any letter of the word.",
  ].join("\n");
  try {
    const text = await ctx.llm.text({
      system,
      prompt: `Word (hidden, do NOT echo): ${state.word}\nMasked so far: ${masked}\nTheme: ${state.theme ?? "any"}\nGive one hint.`,
      maxTokens: 120,
    });
    return text.trim() || null;
  } catch (err) {
    ctx.log("warn", `hangman: LLM hint failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function startGame(ctx: NodeContext, theme: string | null): Promise<void> {
  const state = getState(ctx);
  state.status = "playing";
  state.tried = [];
  state.wrong = [];
  state.lives = MAX_LIVES;
  state.theme = theme;
  state.word = null;
  state.started_at = Date.now();
  state.ended_at = null;
  publishState(ctx, state);
  narrate(ctx, `🎯 Hangman — picking a word${theme ? ` about *${theme}*` : ""}…`);

  const word = await pickWord(ctx, theme);
  if (!word) {
    state.status = "idle";
    state.started_at = null;
    publishState(ctx, state);
    narrate(ctx, "Couldn't pick a word — is the LLM provider up? Type `hangman` again to retry.");
    return;
  }
  state.word = word;
  publishState(ctx, state);
  narrate(ctx, `Word ready: \`${renderMasked(word, [])}\` (${word.length} letters, ${state.lives} lives). Guess a letter or the whole word — any chat surface works.`);
}

function endGame(ctx: NodeContext, state: GameState, win: boolean): void {
  state.status = win ? "won" : "lost";
  state.ended_at = Date.now();
  publishState(ctx, state);
  if (win) {
    narrate(ctx, `🎉 Won! The word was *${state.word}*. Type \`hangman\` to go again.`);
  } else {
    narrate(ctx, `💀 Out of lives — the word was *${state.word}*. ${renderStage(MAX_LIVES)}\nType \`hangman\` for a fresh game.`);
  }
}

async function handleLetterGuess(ctx: NodeContext, state: GameState, letter: string, who: string | null): Promise<void> {
  if (state.tried.includes(letter)) {
    narrate(ctx, `Already tried *${letter}*. Letters tried: ${state.tried.join(" ")}`);
    return;
  }
  state.tried.push(letter);
  state.last_guesser = who;
  const inWord = state.word!.toUpperCase().includes(letter);
  if (!inWord) {
    state.wrong.push(letter);
    state.lives -= 1;
  }

  if (isSolved(state.word!, state.tried)) {
    endGame(ctx, state, true);
    return;
  }
  if (state.lives <= 0) {
    endGame(ctx, state, false);
    return;
  }

  publishState(ctx, state);
  const masked = renderMasked(state.word!, state.tried);
  const reaction = inWord
    ? `✅ *${letter}* — nice! \`${masked}\` · ${state.lives} lives left.`
    : `❌ *${letter}* — not in the word. \`${masked}\` · ${state.lives} lives left.`;
  narrate(ctx, reaction);
}

async function handleWordGuess(ctx: NodeContext, state: GameState, guess: string, who: string | null): Promise<void> {
  state.last_guesser = who;
  if (guess.toUpperCase() === state.word!.toUpperCase()) {
    // Mark every letter tried so the mask reveals fully on the final state.
    for (const c of state.word!.toUpperCase().split("")) {
      if (/[A-Z]/.test(c) && !state.tried.includes(c)) state.tried.push(c);
    }
    endGame(ctx, state, true);
    return;
  }
  state.lives -= 1;
  if (state.lives <= 0) {
    endGame(ctx, state, false);
    return;
  }
  publishState(ctx, state);
  narrate(ctx, `❌ Not *${guess.toLowerCase()}* — wrong full-word guess (−1 life). ${state.lives} lives left.`);
}

/**
 * Parse a control payload either as strict JSON (`{action, theme?}`) or as
 * a loose natural string the brain LLM might emit when it isn't perfectly
 * structured ("start cuisine", "hint", "quit"). Falls back to message
 * metadata as a last resort.
 */
export function parseControl(content: string | undefined, metaFallback?: ControlPayload): ControlPayload {
  const raw = (content ?? "").trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ControlPayload;
      if (parsed && typeof parsed === "object" && parsed.action) return parsed;
    } catch { /* not JSON */ }
    const m = raw.match(/^(start|hint|quit|stop|abandon|status|guess|play)\b\s*(.*)$/i);
    if (m) {
      const verb = m[1].toLowerCase();
      const action: ControlAction =
        verb === "stop" || verb === "abandon" ? "quit" :
        verb === "play" ? "guess" :
        (verb as ControlAction);
      const rest = m[2]?.trim();
      const out: ControlPayload = { action };
      if (action === "start" && rest) out.theme = rest;
      if (action === "guess" && rest) out.value = rest;
      return out;
    }
  }
  return metaFallback ?? {};
}

function senderOf(msg: Parameters<NodeHandler>[0]["messages"][number]): string | null {
  const meta = msg.metadata as { sender?: string; platform?: string } | undefined;
  if (!meta) return null;
  if (meta.sender && meta.platform) return `${meta.sender} (${meta.platform})`;
  return meta.sender ?? null;
}

export const handler: NodeHandler = async (ctx) => {
  const state = getState(ctx);

  for (const msg of ctx.messages) {
    if (msg.topic === "game.hangman.command") {
      const payload = msg.payload as TextPayload;
      const ctrl = parseControl(payload.content, msg.metadata as ControlPayload | undefined);

      if (ctrl.action === "start") {
        await startGame(ctx, ctrl.theme?.trim() || null);
      } else if (ctrl.action === "hint") {
        if (state.status !== "playing") {
          narrate(ctx, "No active game — type `hangman` to start one.");
        } else {
          const hint = await pickHint(ctx, state);
          if (hint) narrate(ctx, `💡 ${hint}`);
          else narrate(ctx, "Couldn't conjure a hint (LLM hiccup). Try again.");
        }
      } else if (ctrl.action === "quit") {
        if (state.status === "playing") {
          narrate(ctx, `Game abandoned. The word was *${state.word}*.`);
        }
        ctx.state.game = emptyState();
        publishState(ctx, ctx.state.game as GameState);
      } else if (ctrl.action === "status") {
        publishState(ctx, state);
      } else if (ctrl.action === "guess") {
        // Brain (or any other gateway) forwards letter / word guesses
        // through here. classifyGuess() rejects anything that isn't a
        // single letter or a word matching the answer length — so the
        // brain doesn't have to think about the guess type, it just
        // pipes the user's input verbatim.
        if (state.status !== "playing" || !state.word) {
          narrate(ctx, "No active game — start one first.");
        } else {
          const raw = (ctrl.value ?? "").trim();
          const cls = classifyGuess(raw, state.word.length);
          if (!cls) {
            narrate(ctx, `\"${raw}\" isn't a valid guess — pick a single letter or a ${state.word.length}-letter word.`);
          } else if (cls.kind === "letter") {
            await handleLetterGuess(ctx, state, cls.value, senderOf(msg));
          } else {
            await handleWordGuess(ctx, state, cls.value, senderOf(msg));
          }
        }
      }
      continue;
    }
    // Hangman no longer listens to chat.input directly — every input
    // (lifecycle commands AND letter/word guesses) comes in through
    // game.hangman.command, with the brain node acting as sole NLU
    // gateway. Removing the chat.input branch avoids the double-fire
    // we used to get (brain answering "you typed A" while hangman
    // simultaneously processed A as a guess). Leftover chat.input
    // events for nodes that still subscribe to it just fall through.
  }
};

export default handler;
