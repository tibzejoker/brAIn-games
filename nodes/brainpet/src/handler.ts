import * as path from "node:path";
import * as fs from "node:fs";
import type {
  NodeContext,
  NodeHandler,
  NodeOnSpawn,
  TextPayload,
} from "@brain/sdk";
import { z } from "zod";

// ── Tuning ──────────────────────────────────────────────────────────────
/** Per-minute decay (units / min). Positive = drains over time. */
const DECAY: Record<StatName, number> = {
  hunger: 0.6,       // 167 min from 100 → 0 (~2h45)
  happiness: 0.3,    // 333 min (~5h30)
  energy: 0.4,       // 250 min — but reverses to +1 while sleeping
  cleanliness: 0.15, // 667 min (~11h)
};
const NARRATION_THRESHOLDS = [50, 25, 10, 1] as const;
/** How fast personality dimensions drift per minute (EMA-style). Lower =
 *  stickier. A bigger boost comes from `nudgePersonality` below — this is
 *  the slow background trend. */
const PERSONALITY_INERTIA = 0.012;
/** Stages by age in minutes. */
const STAGES = [
  { name: "egg",    until: 5    },
  { name: "baby",   until: 30   },
  { name: "child",  until: 120  },
  { name: "teen",   until: 720  },
  { name: "adult",  until: 7200 },
  { name: "senior", until: Infinity },
] as const;
type Stage = (typeof STAGES)[number]["name"];

// ── Types ───────────────────────────────────────────────────────────────

export type StatName = "hunger" | "happiness" | "energy" | "cleanliness";

export interface Personality {
  cheerful: number;   // 0..100 — pulled up by sustained happiness
  clean: number;      // pulled up by sustained cleanliness
  energetic: number;  // pulled up by energy
  social: number;     // pulled up by interaction frequency
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  speaker?: string;
  ts: number;
}

/** A transient visual flourish the LLM can spawn alongside its reply.
 *  Coordinates are 0..1 over the creature stage; the UI maps that to
 *  pixels. `toX/toY` omitted means the emoji is static (good for hats,
 *  attached tools). `attached` keeps it pinned to the creature for the
 *  full duration even if the pet shifts on screen. */
export interface EmojiAnim {
  emoji: string;
  fromX: number;
  fromY: number;
  toX?: number;
  toY?: number;
  scaleFrom?: number;
  scaleTo?: number;
  durationMs?: number;
  count?: number;
  attached?: boolean;
  /** Server-stamped at queue time so the UI can age out old animations
   *  even when the same state ships twice (e.g. on UI mount). */
  ts: number;
}

/** Capped to the last N turns so the prompt stays bounded — see TRIM(). */
export const MAX_HISTORY_TURNS = 12;

export interface PetState {
  name: string;
  species: string;            // freeform — e.g. "fluffball", "blob", "chick"
  born_at: number;            // ms epoch
  last_tick: number;          // ms epoch
  alive: boolean;
  starving_since: number | null;
  hunger: number;
  happiness: number;
  energy: number;
  cleanliness: number;
  /** Physical health / HP. Doesn't decay on its own — neglect and
   *  violent interactions chip away at it; sleep + cleanliness heal
   *  slowly. Hitting 0 is unconditional death (wounds). */
  health: number;
  bond: number;               // 0..100 monotonically grows with interactions
  sleeping: boolean;
  personality: Personality;
  interactions: number;
  last_animation: string;     // hint for the UI: idle / eating / playing / sleeping / sad / dancing / dying / dead
  last_thought: string | null;
  /** Recent dialogue with the human(s) — fed back into the LLM each
   *  turn so the pet remembers the last few exchanges. */
  history: ChatTurn[];
  /** Last batch of LLM-spawned emoji animations. The UI consumes these
   *  to render flying / popping / attached emojis. Reset on every reply. */
  last_emojis?: EmojiAnim[];
}

export interface CemeteryEntry {
  name: string;
  species: string;
  born_at: number;
  died_at: number;
  cause: string;
  personality: Personality;
  final_stats: Pick<PetState, "hunger" | "happiness" | "energy" | "cleanliness" | "health" | "bond">;
  age_minutes: number;
  epitaph: string;
  /** The last few dialogue turns the pet had before passing. Same shape
   *  as PetState.history — capped to ~10 turns so the JSON file stays
   *  small even after many lifetimes. */
  history?: ChatTurn[];
}

export interface ControlPayload {
  action?: string;
  text?: string;       // for `talk`
  food?: string;       // for `feed`
  name?: string;       // for `rename` / `birth`
  species?: string;    // for `birth`
}

// ── Module state (singleton — one node = one pet) ───────────────────────

let nodeId: string | null = null;
let dataPath: string | null = null;
let cemeteryPath: string | null = null;
let cemetery: CemeteryEntry[] = [];
let runtimeSubsAdded = false;

// ── Pure helpers (exported for tests) ───────────────────────────────────

export function ageMinutes(state: PetState): number {
  return Math.max(0, (Date.now() - state.born_at) / 60000);
}

export function stageOf(state: PetState): Stage {
  const m = ageMinutes(state);
  for (const s of STAGES) if (m < s.until) return s.name;
  return "senior";
}

/** Mutates state to apply elapsed-time decay since last_tick. Returns the
 *  thresholds each stat just crossed downwards (e.g. {hunger:25}). */
export function applyDecay(state: PetState, now: number, decayMul = 1): Record<StatName, number | null> {
  const elapsedMin = Math.max(0, (now - state.last_tick) / 60000);
  const crossed: Record<StatName, number | null> = { hunger: null, happiness: null, energy: null, cleanliness: null };
  if (elapsedMin <= 0) { state.last_tick = now; return crossed; }
  for (const k of ["hunger", "happiness", "energy", "cleanliness"] as const) {
    const before = state[k];
    let delta = -DECAY[k] * elapsedMin * decayMul;
    if (k === "energy" && state.sleeping) delta = +1.0 * elapsedMin;  // recover while sleeping
    state[k] = clamp01(before + delta);
    crossed[k] = firstCrossedThreshold(before, state[k]);
  }
  // Health is the ONLY lethal lifebar. Hunger, happiness, cleanliness
  // don't kill on their own — when they get low, they drain HP, and the
  // pet dies if HP reaches 0. Tiered so neglect tightens the screws: a
  // pet stuck at hunger=0 dies in roughly an hour from full HP, but a
  // pet hovering at hunger=20 lingers for many hours, giving the user
  // time to react.
  let healthDelta = 0;
  if (state.hunger <= 30)                       healthDelta -= 0.20 * elapsedMin * decayMul;
  if (state.hunger <= 10)                       healthDelta -= 0.60 * elapsedMin * decayMul;
  if (state.hunger <= 1)                        healthDelta -= 1.00 * elapsedMin * decayMul;
  if (state.happiness <= 10 && !state.sleeping) healthDelta -= 0.15 * elapsedMin * decayMul;
  if (state.cleanliness <= 10)                  healthDelta -= 0.10 * elapsedMin * decayMul;
  // Sleeping in a clean, fed body slowly heals.
  if (state.sleeping && state.cleanliness > 30 && state.hunger > 30) healthDelta += 0.5 * elapsedMin;
  state.health = clamp01(state.health + healthDelta);
  // Personality drifts toward the rolling average of the relevant stat —
  // slow EMA so it takes hours of consistent care to noticeably shift.
  const m = elapsedMin;
  state.personality.cheerful  = ema(state.personality.cheerful,  state.happiness,   PERSONALITY_INERTIA * m);
  state.personality.clean     = ema(state.personality.clean,     state.cleanliness, PERSONALITY_INERTIA * m);
  state.personality.energetic = ema(state.personality.energetic, state.energy,      PERSONALITY_INERTIA * m);
  // social grows from interactions, NOT from a stat — see applyInteraction.
  state.last_tick = now;
  return crossed;
}

export function firstCrossedThreshold(before: number, after: number): number | null {
  if (after >= before) return null;
  for (const t of NARRATION_THRESHOLDS) if (before > t && after <= t) return t;
  return null;
}

function ema(current: number, target: number, alpha: number): number {
  const a = Math.max(0, Math.min(1, alpha));
  return clamp01(current * (1 - a) + target * a);
}

function clamp01(v: number): number { return Math.max(0, Math.min(100, v)); }

/** How many minutes until ANY stat crosses its next narration threshold.
 *  Used to schedule the node's next autonomous wake — instead of a fixed
 *  poll, the pet wakes precisely at the next "interesting" moment. */
export function minutesToNextThreshold(state: PetState, decayMul = 1): number {
  let min = 60; // hard cap — never sleep more than an hour
  for (const k of ["hunger", "happiness", "energy", "cleanliness"] as const) {
    const v = state[k];
    const rate = (k === "energy" && state.sleeping ? -1.0 : DECAY[k]) * decayMul;
    if (rate <= 0) continue;
    for (const t of NARRATION_THRESHOLDS) {
      if (v > t) {
        const m = (v - t) / rate;
        if (m < min) min = m;
      }
    }
  }
  // Floor at 20s so a near-threshold stat still has time to publish state
  // events before bouncing the runner again.
  return Math.max(20 / 60, min);
}

export function defaultPersonality(): Personality {
  return { cheerful: 50, clean: 50, energetic: 50, social: 30 };
}

export function newPet(name: string, species: string): PetState {
  const now = Date.now();
  return {
    name, species,
    born_at: now,
    last_tick: now,
    alive: true,
    starving_since: null,
    hunger: 70,
    happiness: 80,
    energy: 90,
    cleanliness: 90,
    health: 100,
    bond: 5,
    sleeping: false,
    personality: defaultPersonality(),
    interactions: 0,
    last_animation: "idle",
    last_thought: null,
    history: [],
    last_emojis: [],
  };
}

/** Mutates state.history in place: appends a turn, keeps the last
 *  MAX_HISTORY_TURNS so the prompt doesn't grow unbounded over a long
 *  session. Returned so callers can chain. */
export function pushHistory(state: PetState, turn: ChatTurn): ChatTurn[] {
  if (!state.history) state.history = [];
  state.history.push(turn);
  if (state.history.length > MAX_HISTORY_TURNS) {
    state.history.splice(0, state.history.length - MAX_HISTORY_TURNS);
  }
  return state.history;
}

/** Loose-string + JSON command parser. Mirrors the bridge / game pattern. */
export function parseControl(content: string | undefined, metaFallback?: ControlPayload): ControlPayload {
  const raw = (content ?? "").trim();
  if (!raw) return metaFallback ?? {};
  try {
    const parsed = JSON.parse(raw) as ControlPayload;
    if (parsed && typeof parsed === "object" && parsed.action) return parsed;
  } catch { /* not JSON */ }
  // Verb match is case-insensitive but we read the *rest* off the
  // original string so the user's casing on names (`rename Pixel`) and
  // free-text (`feed strawberry pie`) is preserved.
  const m = raw.match(/^(birth|talk|feed|play|cuddle|pet|clean|sleep|wake|rename|kill|revive|status)\b\s*(.*)$/i);
  if (m) {
    const verb = m[1].toLowerCase();
    const rest = m[2]?.trim();
    if (verb === "pet") return { action: "cuddle" };
    if (verb === "rename" && rest) return { action: "rename", name: rest };
    if (verb === "feed") return { action: "feed", food: rest || undefined };
    if (verb === "talk") return { action: "talk", text: rest };
    return { action: verb };
  }
  return metaFallback ?? {};
}

// ── LLM ─────────────────────────────────────────────────────────────────
// All LLM I/O routes through ctx.llm.* — the framework handles model
// resolution (per-node override → global default → fallback chain),
// reasoning-text extraction, <think>-tag stripping, and per-provider
// failover. This handler only declares WHAT it wants.

async function llmPickName(ctx: NodeContext): Promise<string> {
  try {
    const text = await ctx.llm.text({
      system: "Pick ONE short whimsical name for a virtual pet. Reply with the name only — 2 to 9 letters, no quotes, no punctuation, no explanation. Examples: Pip, Whisker, Bobo, Pixel, Maru, Nori.",
      prompt: "Pick a name.",
      maxTokens: 12,
    });
    if (text) {
      const match = text.trim().match(/[A-Za-z][A-Za-z'-]{1,8}/);
      if (match) return match[0].slice(0, 1).toUpperCase() + match[0].slice(1).toLowerCase();
    }
  } catch (err) {
    ctx.log("warn", `brainpet: llmPickName failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Fallback so the pet always has a name.
  const fallback = ["Pip", "Bobo", "Whisker", "Pixel", "Maru", "Nori", "Bao", "Tuk", "Lulu", "Mochi"];
  return fallback[Math.floor(Math.random() * fallback.length)];
}

function personalityBlurb(p: Personality): string {
  const parts: string[] = [];
  if (p.cheerful > 65) parts.push("very cheerful"); else if (p.cheerful < 35) parts.push("a bit gloomy");
  if (p.energetic > 65) parts.push("energetic"); else if (p.energetic < 35) parts.push("sleepy");
  if (p.clean > 65) parts.push("dainty"); else if (p.clean < 35) parts.push("scruffy");
  if (p.social > 65) parts.push("very social"); else if (p.social < 35) parts.push("shy");
  return parts.join(", ") || "still figuring itself out";
}

const REPLY_SYSTEM = (state: PetState) => [
  `You are ${state.name}, a small virtual pet (${state.species}, ${stageOf(state)} stage, age ${Math.round(ageMinutes(state))}m, bond ${Math.round(state.bond)}).`,
  `Personality: ${personalityBlurb(state.personality)}.`,
  `Stats: hunger=${Math.round(state.hunger)} happiness=${Math.round(state.happiness)} energy=${Math.round(state.energy)} clean=${Math.round(state.cleanliness)} health=${Math.round(state.health)}.`,
  state.sleeping ? "Currently SLEEPING." : "",
  "",
  "RULES (mandatory):",
  "1. Always call the `adjust_stats` tool exactly once. You MUST NOT reply in plain text — every interaction goes through that tool.",
  "2. Inside the tool call, `reply` is your in-character spoken reaction (1–2 short sentences, same language as the user).",
  "3. The numeric deltas describe how this very interaction changes your state. Be HONEST about magnitude — there are no soft caps. A loving hug bumps happiness by +10, a slap by -15, a beating by -40. Never leave all deltas at 0 on an emotional message.",
  "4. DEATH MODEL — `health` is the ONLY lifebar. The pet dies when health ≤ 0, never from any other stat directly. Hunger / cleanliness / happiness at low levels slowly drain health over time (so neglect kills, just gradually). If an action is unambiguously fatal in the moment (point-blank gun, fire, decapitation, drowning), drop `health` by enough to crush it to 0 in this single call — that ends the pet immediately. For cruelty that is severe but not instantly fatal, just deal big health damage (-30 to -70) and let nature finish the job.",
  "5. `animation` is the body-pose hint. Choose `dying` ONLY when this very interaction is the killing blow — that flag ends the pet immediately even if health doesn't hit 0. Otherwise pick the closest fit (sad, cuddling, eating, washing, sleeping, playing, dancing, idle).",
  "6. `emojis` (optional) is your stage-direction layer. Use 0–3 emojis per reply to make the moment feel alive: a heart drifting up from a hug, sparkles popping around a clean bath, an angry ❗ over the pet's head after being hit, a 🎩 attached above the head, a 💥 expanding from impact. Be tasteful — don't spam. Coordinates are 0..1 over the pet stage; the creature sits roughly centred near (0.5, 0.55).",
].join("\n");

const ADJUST_STATS_DESCRIPTION = "Apply stat changes to the pet AND deliver the pet's in-character reply, in one call. ALWAYS call this exactly once per user message. You have FULL authority over the magnitudes — a casual greeting moves stats by a few points, a violent or fatal action can drop health by tens or even crush it all the way to zero. There are no soft caps. `health` is the ONLY lethal lifebar; other stats just make the pet weaker / sadder / hungrier (which then drains health over time).";

const adjustStatsSchema = z.object({
    reply: z.string().describe("Pet's in-character spoken reply, 1–2 short sentences, in the user's language. Even in the moment of death, a tiny final whimper is welcome."),
    happiness: z.number().min(-100).max(100).describe("Δ happiness. Light tap on the head: -3. Real insult: -15. Beating: -40. Torture / cruelty: -80 or lower. Lavish praise / great joy: +20 to +60. Not lethal on its own."),
    hunger: z.number().min(-100).max(100).describe("Δ hunger — positive when fed, negative when food is denied or food is vomited up. Hunger at 0 will gradually drain health over the next hour or so; this is NOT instant death."),
    energy: z.number().min(-100).max(100).describe("Δ energy — light play: -5; exhausting day: -25; near-death exhaustion: -80. Not lethal on its own."),
    cleanliness: z.number().min(-100).max(100).describe("Δ cleanliness — bath: +60; thrown in mud: -40. Not lethal on its own."),
    health: z.number().min(-100).max(100).describe("Δ health (physical HP) — the ONLY stat that can kill the pet. Slap: -5. Punch: -15. Beating: -40. Stabbing / gunshot / fall: -70 to -100. Medicine / careful tending: +10 to +30. Hitting 0 ends the pet's life immediately."),
    bond: z.number().min(-50).max(50).describe("Δ bond with the speaker. Small praise: +2. Hug / heartfelt confession: +10. Betrayal / abuse: -10 to -30."),
    animation: z.enum(["idle", "eating", "playing", "dancing", "cuddling", "washing", "sleeping", "sad", "dying"]).describe("Body-pose hint. Pick `dying` ONLY when this interaction is the killing blow — that flag ends the pet's life immediately even if health doesn't hit 0."),
    emojis: z.array(z.object({
      emoji: z.string().describe("The emoji character, e.g. '❤️', '✨', '💥', '🎩', '🥺', '❗'."),
      fromX: z.number().min(0).max(1).describe("Start X position. 0 = left edge of the pet stage, 1 = right edge. The pet sits roughly at x≈0.5."),
      fromY: z.number().min(0).max(1).describe("Start Y position. 0 = top of stage, 1 = bottom. The pet's body is around y≈0.55, head ≈0.4."),
      toX: z.number().min(0).max(1).optional().describe("End X. Omit for a static emoji (no movement) — useful for hats / attached tools."),
      toY: z.number().min(0).max(1).optional().describe("End Y. Omit for static."),
      scaleFrom: z.number().min(0.1).max(5).optional().describe("Starting scale, default 1. Use 0.1 + scaleTo 1.5 for a pop/explosion effect."),
      scaleTo: z.number().min(0.1).max(5).optional().describe("Ending scale, default same as scaleFrom."),
      durationMs: z.number().min(100).max(5000).optional().describe("How long the animation runs (default 800ms)."),
      count: z.number().min(1).max(10).optional().describe("How many copies to spawn (default 1); they get slight position jitter and a small stagger."),
      attached: z.boolean().optional().describe("If true, the emoji stays anchored at fromX/fromY for the full duration (good for hats, weapons, status icons hovering near the pet)."),
    })).max(8).optional().describe("0–3 emojis that visually narrate the interaction (hearts, sparkles, explosions, hats, tools…). Optional — skip on neutral exchanges."),
});

async function llmTalk(ctx: NodeContext, state: PetState, userText: string, speaker: string): Promise<{ reply: string; effects: Record<string, number | string>; emojis: EmojiAnim[] } | null> {
  try {
    // Build a multi-turn conversation: recent dialogue history + the
    // brand-new user line. Each old user turn is prefixed with the
    // speaker name so the LLM keeps multiple humans straight when the
    // pet is chatted from different chat surfaces.
    const recent = (state.history ?? []).slice(-MAX_HISTORY_TURNS);
    const messages: { role: "user" | "assistant"; content: string }[] = [];
    for (const turn of recent) {
      if (turn.role === "user") {
        const tag = turn.speaker && turn.speaker !== "you" ? `${turn.speaker} says: ` : "";
        messages.push({ role: "user", content: `${tag}${turn.content}` });
      } else {
        messages.push({ role: "assistant", content: turn.content });
      }
    }
    const tag = speaker && speaker !== "you" ? `${speaker} says: ` : "";
    messages.push({ role: "user", content: `${tag}${userText}` });

    // ctx.llm.tool() handles model resolution, failover across the chain,
    // toolChoice:'required', retry-with-stricter-prompt on missing tool
    // call, and schema validation. We just hand it the zod schema + the
    // conversation and get the validated args back.
    const input = await ctx.llm.tool({
      tool: {
        name: "adjust_stats",
        description: ADJUST_STATS_DESCRIPTION,
        inputSchema: adjustStatsSchema,
      },
      prompt: messages,
      system: REPLY_SYSTEM(state),
      maxTokens: 2048,
      retries: 1,
    });
    return inputToReplyEffects(input);
  } catch (err) {
    ctx.log("warn", `brainpet: llmTalk failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Marshall the tool-call args into the shape applyEffects + narrate consume. */
function inputToReplyEffects(input: Record<string, unknown>): { reply: string; effects: Record<string, number | string>; emojis: EmojiAnim[] } {
  const reply = typeof input.reply === "string" ? input.reply.trim() : "";
  const effects: Record<string, number | string> = {};
  for (const k of ["happiness", "hunger", "energy", "cleanliness", "health", "bond"] as const) {
    const v = input[k];
    if (typeof v === "number") effects[k] = v;
  }
  if (typeof input.animation === "string") effects.animation = input.animation;
  const emojis = sanitizeEmojis(input.emojis);
  return { reply, effects, emojis };
}

/** Coerces the raw `emojis` array from the LLM tool call into safe
 *  EmojiAnim objects: clamped coords, sane defaults, capped count, etc.
 *  Returns an empty array if nothing usable came through. */
function sanitizeEmojis(raw: unknown): EmojiAnim[] {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  const out: EmojiAnim[] = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const emoji = typeof o.emoji === "string" ? o.emoji.trim() : "";
    if (!emoji) continue;
    const clamp = (v: unknown, lo: number, hi: number, dflt: number) =>
      typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
    const optClamp = (v: unknown, lo: number, hi: number) =>
      typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined;
    out.push({
      emoji: emoji.slice(0, 6),
      fromX: clamp(o.fromX, 0, 1, 0.5),
      fromY: clamp(o.fromY, 0, 1, 0.5),
      toX: optClamp(o.toX, 0, 1),
      toY: optClamp(o.toY, 0, 1),
      scaleFrom: optClamp(o.scaleFrom, 0.1, 5),
      scaleTo: optClamp(o.scaleTo, 0.1, 5),
      durationMs: clamp(o.durationMs, 100, 5000, 800),
      count: Math.round(clamp(o.count, 1, 10, 1)),
      attached: o.attached === true,
      ts: now,
    });
  }
  return out;
}

/** Split the LLM's combined reply into the user-facing text and the
 *  stat-delta JSON it emits in `<effects>...</effects>`. We tolerate
 *  LLM-ish JSON quirks: `+15` (leading-plus integers aren't strict
 *  JSON but models love them), single-quoted keys, trailing commas. */
function tolerantJsonParse(s: string): Record<string, number | string> {
  const normalised = s
    .replace(/:\s*\+(\d)/g, ": $1")               // `+15` → `15`
    .replace(/,\s*([}\]])/g, "$1")                // trailing commas
    .replace(/([{,]\s*)'([^']+)'(\s*:)/g, '$1"$2"$3'); // single-quoted keys
  return JSON.parse(normalised) as Record<string, number | string>;
}

/** Best-effort JSON repair for a JSON-ish blob that was cut mid-write
 *  (model hit max_tokens before `}`). Drops the trailing partial key/value,
 *  closes braces, parses again. Returns {} on hopeless input. */
function repairTruncatedJson(s: string): Record<string, number | string> {
  let body = s.trim();
  // Try direct parse first.
  try { return tolerantJsonParse(body); } catch { /* continue */ }
  // Strip trailing partial key/value: walk back to the last comma or `{`.
  const stripIdx = Math.max(body.lastIndexOf(","), body.lastIndexOf("{"));
  if (stripIdx > 0) body = body.slice(0, stripIdx);
  // Balance braces.
  const open = (body.match(/\{/g) ?? []).length;
  const close = (body.match(/\}/g) ?? []).length;
  body = body + "}".repeat(Math.max(0, open - close));
  try { return tolerantJsonParse(body); } catch { return {}; }
}

export function parseReplyAndEffects(raw: string): { reply: string; effects: Record<string, number | string> } {
  // Properly closed tag — easy path.
  const closed = raw.match(/<effects>\s*([\s\S]*?)\s*<\/effects>/i);
  if (closed) {
    let reply = raw.slice(0, closed.index!).trim();
    let effects: Record<string, number | string> = {};
    try { effects = tolerantJsonParse(closed[1]); } catch { effects = {}; }
    return { reply: reply.replace(/\s+$/, ""), effects };
  }
  // Open `<effects>` but no closing — model got cut off. Slice it out of
  // the reply anyway and try to repair the partial JSON.
  const openOnly = raw.match(/<effects>([\s\S]*)$/i);
  if (openOnly) {
    const reply = raw.slice(0, openOnly.index!).trim();
    const effects = repairTruncatedJson(openOnly[1]);
    return { reply: reply.replace(/\s+$/, ""), effects };
  }
  // No tags at all — accept a trailing bare JSON object if it looks like
  // effects, otherwise return the full prose with empty effects.
  const trailingJson = raw.match(/(\{[^{}]*\})\s*$/);
  if (trailingJson) {
    try {
      const candidate = tolerantJsonParse(trailingJson[1]);
      if (Object.keys(candidate).some((k) => ["hunger","happiness","energy","cleanliness","bond","animation"].includes(k))) {
        return { reply: raw.slice(0, trailingJson.index!).trim().replace(/\s+$/, ""), effects: candidate };
      }
    } catch { /* skip */ }
  }
  return { reply: raw.replace(/\s+$/, ""), effects: {} };
}

async function llmEpitaph(ctx: NodeContext, state: PetState, cause: string): Promise<string> {
  try {
    const text = await ctx.llm.text({
      system: "Write a SHORT tomb epitaph (one sentence, max 14 words) for the pet that just passed. Tender, kind, no clichés. Plain prose only — no quotes.",
      prompt: `Pet name: ${state.name}. Species: ${state.species}. Lived ${Math.round(ageMinutes(state))} minutes. Cause: ${cause}. Personality: ${personalityBlurb(state.personality)}.`,
      maxTokens: 48,
    });
    if (text) return text.trim().replace(/^["']|["']$/g, "");
  } catch { /* ignore */ }
  return `Here lies ${state.name}. Gone too soon.`;
}

// ── Persistence ─────────────────────────────────────────────────────────

function setPaths(dataDir: string): void {
  const rootData = path.dirname(path.dirname(dataDir));
  dataPath = path.join(rootData, "games", "brainpet", "state.json");
  cemeteryPath = path.join(rootData, "games", "brainpet", "cemetery.json");
}

function readState(): PetState | null {
  try {
    if (dataPath && fs.existsSync(dataPath)) return JSON.parse(fs.readFileSync(dataPath, "utf8")) as PetState;
  } catch { /* corrupted → ignore */ }
  return null;
}

function writeState(state: PetState | null): void {
  if (!dataPath) return;
  try {
    fs.mkdirSync(path.dirname(dataPath), { recursive: true });
    if (state) fs.writeFileSync(dataPath, JSON.stringify(state, null, 2));
    else if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath);
  } catch (err) { /* best-effort */ void err; }
}

function readCemetery(): CemeteryEntry[] {
  try {
    if (cemeteryPath && fs.existsSync(cemeteryPath)) return JSON.parse(fs.readFileSync(cemeteryPath, "utf8")) as CemeteryEntry[];
  } catch { /* skip */ }
  return [];
}

function writeCemetery(entries: CemeteryEntry[]): void {
  if (!cemeteryPath) return;
  try {
    fs.mkdirSync(path.dirname(cemeteryPath), { recursive: true });
    fs.writeFileSync(cemeteryPath, JSON.stringify(entries, null, 2));
  } catch { /* skip */ }
}

// ── Bus surface ─────────────────────────────────────────────────────────

function publishState(ctx: NodeContext, state: PetState | null): void {
  ctx.publish("brainpet.state", {
    type: "text",
    criticality: 1,
    payload: { content: JSON.stringify({ pet: state, stage: state ? stageOf(state) : null, age_minutes: state ? ageMinutes(state) : 0 }) },
  });
}

function publishCemetery(ctx: NodeContext): void {
  ctx.publish("brainpet.cemetery", {
    type: "text",
    criticality: 1,
    payload: { content: JSON.stringify(cemetery) },
  });
}

function narrate(ctx: NodeContext, text: string, animation?: string): void {
  ctx.publish("chat.response", {
    type: "text",
    criticality: 3,
    payload: { content: text },
    metadata: { from_game: "brainpet", animation: animation ?? "idle" },
  });
}

// ── Stat / lifecycle helpers ────────────────────────────────────────────

const THRESHOLD_LINES: Record<StatName, Record<number, string>> = {
  hunger:      { 50: "Hmm… getting peckish.", 25: "I'm hungry 🥺", 10: "Really hungry now!", 1: "Starving! Please feed me!!" },
  happiness:   { 50: "Could use a smile.",    25: "Feeling a bit low.", 10: "I'm so sad…",         1: "Please play with me 😢" },
  energy:      { 50: "A little tired.",       25: "Yawning…",          10: "I need to nap soon.",  1: "Exhausted 😴" },
  cleanliness: { 50: "Bit grubby.",           25: "I'm dirty.",        10: "I really need a wash!",1: "Yuck, I'm filthy!" },
};

function applyEffects(state: PetState, effects: Record<string, number | string>): string | null {
  let animation: string | null = null;
  for (const [k, v] of Object.entries(effects)) {
    if (k === "animation" && typeof v === "string") { animation = v; continue; }
    if (typeof v !== "number") continue;
    if (k === "hunger" || k === "happiness" || k === "energy" || k === "cleanliness" || k === "health") {
      state[k] = clamp01(state[k] + v);
    } else if (k === "bond") {
      state.bond = clamp01(state.bond + v);
    }
  }
  return animation;
}

function markInteraction(state: PetState): void {
  state.interactions += 1;
  // Each conversational moment notches social up — visible movement
  // without runaway: clamped + slow enough to take ~50 interactions
  // to climb from 30 (default) to 100.
  state.personality.social = clamp01(state.personality.social + 1.5);
}

/** Bump personality dimensions when an interaction had a *big* emotional
 *  effect — separate from the slow EMA in applyDecay so the user sees
 *  the trait pills nudge after a strong moment. Magnitudes are tuned to
 *  stay subtle: a +20 happiness LLM swing only moves cheerful by ~+2. */
export function nudgePersonality(state: PetState, effects: Record<string, number | string>): void {
  const hp = num(effects.happiness);
  const cl = num(effects.cleanliness);
  const en = num(effects.energy);
  const bd = num(effects.bond);
  if (hp !== 0)    state.personality.cheerful  = clamp01(state.personality.cheerful  + hp * 0.10);
  if (cl !== 0)    state.personality.clean     = clamp01(state.personality.clean     + cl * 0.10);
  if (en !== 0)    state.personality.energetic = clamp01(state.personality.energetic + en * 0.05);
  if (Math.abs(bd) > 2) state.personality.social = clamp01(state.personality.social + bd * 0.5);
}
function num(v: unknown): number { return typeof v === "number" ? v : 0; }

/** Pure stat-state probe used by tick() to set the dying animation flag
 *  and stamp `starving_since` so the UI can show how long the pet has
 *  been at zero. Crucially: NO death is decided here — only `health`
 *  reaching 0 kills the pet, via tick()'s explicit check. */
function checkStarvation(state: PetState, now: number): { critical: boolean } {
  if (state.hunger <= 0) {
    if (state.starving_since === null) state.starving_since = now;
    return { critical: true };
  }
  state.starving_since = null;
  return { critical: false };
}

/** Pick the most likely narrative cause when the pet dies of HP=0 from
 *  passive decay (no LLM tool delta in this tick). */
function inferDeathCause(state: PetState): string {
  if (state.hunger    <= 5)  return "starvation";
  if (state.cleanliness <= 5) return "infection from neglect";
  if (state.happiness <= 5)  return "a broken heart";
  return "wounds left untreated";
}

async function bury(ctx: NodeContext, state: PetState, cause: string): Promise<void> {
  // Push the dead state to the UI BEFORE clearing — so the canvas can
  // render the slate-grey, X-eyed pet for at least one frame. Without
  // this, the UI keeps showing the last live frame and just tips it on
  // its side from the "dead" animation cue, never going grey.
  state.alive = false;
  state.last_animation = "dead";
  state.last_emojis = [];
  publishState(ctx, state);
  const epitaph = await llmEpitaph(ctx, state, cause);
  const entry: CemeteryEntry = {
    name: state.name, species: state.species,
    born_at: state.born_at, died_at: Date.now(),
    cause,
    personality: { ...state.personality },
    final_stats: { hunger: state.hunger, happiness: state.happiness, energy: state.energy, cleanliness: state.cleanliness, health: state.health, bond: state.bond },
    age_minutes: Math.round(ageMinutes(state)),
    epitaph,
    history: (state.history ?? []).slice(-10),
  };
  cemetery = [...cemetery, entry];
  writeCemetery(cemetery);
  publishCemetery(ctx);
  narrate(ctx, `⚰️ ${state.name} has passed away (${cause}). _${epitaph}_`, "dead");
}

async function startNewPet(ctx: NodeContext, opts?: { name?: string; species?: string }): Promise<PetState> {
  const name = opts?.name?.trim() || await llmPickName(ctx);
  const species = opts?.species?.trim() || "fluffball";
  const state = newPet(name, species);
  writeState(state);
  publishState(ctx, state);
  narrate(ctx, `🥚 A ${species} hatched and decided its name is *${name}*. Say hi!`, "idle");
  return state;
}

// ── Tick / wake handling ────────────────────────────────────────────────

async function tick(ctx: NodeContext, state: PetState): Promise<PetState | null> {
  // Already dead (e.g. the LLM-driven lethal branch ran earlier in this
  // iteration) — don't run decay or re-bury; the previous step already
  // published the dead state and wrote the cemetery.
  if (!state.alive) return null;
  const now = Date.now();
  const decayMul = (ctx.node.config_overrides?.decay_speed as number | undefined) ?? 1;
  const crossed = applyDecay(state, now, decayMul);

  for (const k of ["hunger", "happiness", "energy", "cleanliness"] as const) {
    const t = crossed[k];
    if (t !== null) {
      const line = THRESHOLD_LINES[k]?.[t];
      if (line) narrate(ctx, `*${state.name}*: ${line}`);
    }
  }

  // Health is the singular lifebar — drained by hunger / neglect via
  // applyDecay above. Anything else just chips at quality of life.
  if (state.health <= 0) {
    state.alive = false;
    writeState(null);
    await bury(ctx, state, inferDeathCause(state));
    return null;
  }

  const starving = checkStarvation(state, now);
  if (starving.critical) {
    state.last_animation = "dying";
    narrate(ctx, `💀 *${state.name}* is starving and weakening — please feed!`, "dying");
  } else {
    state.last_animation = state.sleeping ? "sleeping" : "idle";
  }
  writeState(state);
  publishState(ctx, state);
  return state;
}

// ── Handler ─────────────────────────────────────────────────────────────

export const onSpawn: NodeOnSpawn = async (info) => {
  nodeId = info.id;
};

export const handler: NodeHandler = async (ctx) => {
  nodeId ??= ctx.node.id;
  if (!dataPath) setPaths(ctx.dataDir);
  if (cemetery.length === 0) cemetery = readCemetery();

  if (!runtimeSubsAdded) {
    runtimeSubsAdded = true;
    const existing = new Set(ctx.node.subscriptions.map((s) => s.topic));
    if (!existing.has("brainpet.command")) ctx.subscribe("brainpet.command", { description: "runtime-added control plane" });
  }

  let state = readState();

  // Auto-birth on first wake if there's no living pet AND no message asked
  // for one explicitly. The very first `birth` / chat will kick this off.

  for (const msg of ctx.messages) {
    if (msg.topic === "brainpet.command") {
      const ctrl = parseControl((msg.payload as TextPayload).content, msg.metadata as ControlPayload | undefined);
      state = await runCommand(ctx, state, ctrl);
      continue;
    }

    if (msg.topic !== "chat.input") continue;
    if ((msg.metadata as { from_game?: string } | undefined)?.from_game === "brainpet") continue;
    const raw = (msg.payload as TextPayload).content?.trim();
    if (!raw) continue;

    // Quick care verbs work everywhere (any chat surface).
    const verb = raw.toLowerCase().match(/^(feed|play|cuddle|pet|clean|sleep|wake|status|kill|revive)\b(?:\s+(.+))?$/);
    if (verb) {
      state = await runCommand(ctx, state, parseControl(verb[0], undefined));
      continue;
    }

    // Otherwise: addressed if the pet's name appears in the message.
    if (state?.alive && state.name && new RegExp(`\\b${escapeRegex(state.name)}\\b`, "i").test(raw)) {
      const speaker = (msg.metadata as { sender?: string } | undefined)?.sender ?? "Someone";
      state = await handleTalk(ctx, state, raw, speaker);
      continue;
    }
  }

  // Idle tick — apply decay even when no message arrived. Schedule the next
  // wake at the next "interesting" moment (stat threshold cross).
  if (state) state = await tick(ctx, state);

  const sleepMin = state ? minutesToNextThreshold(state, (ctx.node.config_overrides?.decay_speed as number | undefined) ?? 1) : 60;
  ctx.sleep([
    { type: "timer", value: `${Math.round(sleepMin * 60)}s` },
    { type: "any" },
  ]);
};

async function handleTalk(ctx: NodeContext, state: PetState, text: string, speaker: string): Promise<PetState> {
  markInteraction(state);
  // Push the user turn BEFORE calling the LLM so it sees the new line in
  // the conversation it's being asked to reply to (handled inside
  // llmTalk, which appends the live message to the history excerpt).
  pushHistory(state, { role: "user", content: text, speaker, ts: Date.now() });

  const result = await llmTalk(ctx, state, text, speaker);
  let reply = result?.reply ?? "";
  const effects = result?.effects ?? {};
  const emojis = result?.emojis ?? [];
  if (!reply) {
    // LLM bailed or gave us only the effects tag — never leave the user
    // wondering whether their message landed. Pick a mood-appropriate
    // fallback that still feels in-character.
    reply = state.sleeping
      ? "Zzz… 💭"
      : state.hunger < 25 ? "*tummy rumbles*"
      : state.happiness < 25 ? "*looks up* 🥺"
      : "*tilts head*";
  }
  pushHistory(state, { role: "assistant", content: reply, ts: Date.now() });
  const animation = applyEffects(state, effects);
  nudgePersonality(state, effects);
  state.bond = clamp01(state.bond + 0.5);
  state.last_animation = animation ?? state.last_animation;
  state.last_emojis = emojis;
  narrate(ctx, `*${state.name}*: ${reply}`, animation ?? "idle");

  // Instant-death is rare and strictly LLM-driven. Two signals:
  //   1. animation === "dying" — the model explicitly flagged the killing blow.
  //   2. The LLM's `health` delta was negative AND drove HP to ≤ 0 this turn.
  // Driving hunger / happiness / cleanliness to 0 is NOT instant death —
  // those just feed gradual HP drain in applyDecay() over the next ticks.
  if (state.alive) {
    const droveHealthToZero =
      state.health <= 0 && typeof effects.health === "number" && (effects.health as number) < 0;
    const lethal = animation === "dying" || droveHealthToZero;
    if (lethal) {
      const cause = animation === "dying" ? "lethal interaction" : "fatal wounds";
      state.alive = false;
      writeState(null);
      await bury(ctx, state, cause);
      return state;
    }
  }

  writeState(state);
  publishState(ctx, state);
  return state;
}

async function runCommand(ctx: NodeContext, state: PetState | null, ctrl: ControlPayload): Promise<PetState | null> {
  if (ctrl.action === "birth") return startNewPet(ctx, { name: ctrl.name, species: ctrl.species });
  if (ctrl.action === "revive") {
    // Buries the current pet (if any) without LLM epitaph, starts fresh.
    if (state?.alive) await bury(ctx, state, "revived by owner");
    return startNewPet(ctx);
  }
  if (ctrl.action === "kill") {
    if (!state?.alive) { narrate(ctx, "There's no living pet to kill."); return state; }
    state.alive = false;
    writeState(null);
    await bury(ctx, state, "killed by owner");
    return null;
  }
  if (ctrl.action === "status") {
    publishState(ctx, state);
    publishCemetery(ctx);
    return state;
  }

  if (!state?.alive) {
    // First-time interaction with no pet → birth one automatically.
    state = await startNewPet(ctx);
  }

  if (ctrl.action === "rename" && ctrl.name) {
    const old = state.name;
    state.name = ctrl.name.slice(0, 24);
    narrate(ctx, `*${old}* is now called *${state.name}*.`);
  } else if (ctrl.action === "feed") {
    applyEffects(state, { hunger: 25, cleanliness: -2, bond: 0.5, animation: "eating" });
    markInteraction(state);
    narrate(ctx, `🍴 *${state.name}* nibbles${ctrl.food ? ` on the ${ctrl.food}` : ""}.`, "eating");
  } else if (ctrl.action === "play") {
    applyEffects(state, { happiness: 18, energy: -10, bond: 1, animation: "playing" });
    markInteraction(state);
    narrate(ctx, `🎾 *${state.name}* plays — happy and a little tired.`, "playing");
  } else if (ctrl.action === "cuddle" || ctrl.action === "pet") {
    applyEffects(state, { happiness: 8, bond: 2, animation: "cuddling" });
    markInteraction(state);
    narrate(ctx, `💞 *${state.name}* snuggles in.`, "cuddling");
  } else if (ctrl.action === "clean") {
    applyEffects(state, { cleanliness: 60, happiness: 4, bond: 0.5, animation: "washing" });
    markInteraction(state);
    narrate(ctx, `🛁 *${state.name}* is squeaky clean.`, "washing");
  } else if (ctrl.action === "sleep") {
    if (state.sleeping) { narrate(ctx, `*${state.name}* is already asleep.`); }
    else { state.sleeping = true; applyEffects(state, { animation: "sleeping" }); narrate(ctx, `😴 *${state.name}* curls up to sleep.`, "sleeping"); }
  } else if (ctrl.action === "wake") {
    if (!state.sleeping) { narrate(ctx, `*${state.name}* is already awake.`); }
    else { state.sleeping = false; applyEffects(state, { animation: "idle" }); narrate(ctx, `*${state.name}* stretches awake.`, "idle"); }
  } else if (ctrl.action === "talk" && ctrl.text) {
    state = await handleTalk(ctx, state, ctrl.text, "you");
    return state;
  }
  writeState(state);
  publishState(ctx, state);
  return state;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default handler;
