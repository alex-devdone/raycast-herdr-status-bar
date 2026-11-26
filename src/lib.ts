import { execSync } from "child_process";
import {
  existsSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  readFileSync,
  statSync,
} from "fs";
import { homedir } from "os";
import { basename } from "path";

export type AgentState = "working" | "idle" | "blocked" | "done" | "unknown";

export interface Agent {
  type: string; // "claude" | "codex" | ...
  name: string; // herdr `name` ?? basename(cwd)
  cwd: string;
  state: AgentState;
  sessionId?: string; // agent_session.value
  terminal?: string; // herdr-core address, e.g. "t12" — what `agent.focus` takes
  seq: number; // last status change (ms) — recency tie-break, and the activity time when there's no transcript
}

// herdr's attention queue, verbatim from its tab_attention_priority():
// blocked 4 > done 3 > working 2 > idle 1 > unknown 0.
const ATTENTION: Record<AgentState, number> = {
  blocked: 4,
  done: 3,
  working: 2,
  idle: 1,
  unknown: 0,
};

/** Sort like herdr's agent panel with ui.agent_panel_sort = "priority". */
export function byPriority(a: Agent, b: Agent): number {
  return ATTENTION[b.state] - ATTENTION[a.state] || b.seq - a.seq;
}

export interface Stats {
  tokens: number; // headline usage total (see per-type notes below)
  durationMs: number; // session activity span
  lastActiveMs: number; // transcript/rollout mtime — the "date modified" we bucket by
  model?: string; // latest model the agent replied with, e.g. "claude-opus-5-5"
}

// Finder-style date buckets, keyed off last activity, plus rolling 1h/5h windows on top.
export type DateBucket =
  "last1h" | "last5h" | "today" | "yesterday" | "prev7" | "prev30" | "other";

/** Bucket a last-active timestamp: rolling 1h/5h windows, then Finder-style calendar-day edges. */
export function dateBucket(ts: number | undefined, now: number): DateBucket {
  if (!ts) return "other"; // remote / no local transcript → no known activity time
  if (ts >= now - 3_600_000) return "last1h"; // rolling windows, most-recent wins
  if (ts >= now - 5 * 3_600_000) return "last5h";
  const t0 = new Date(now);
  t0.setHours(0, 0, 0, 0); // start of today, local time
  const startOfToday = t0.getTime();
  const day = 86_400_000;
  if (ts >= startOfToday) return "today";
  if (ts >= startOfToday - day) return "yesterday";
  if (ts >= startOfToday - 7 * day) return "prev7";
  if (ts >= startOfToday - 30 * day) return "prev30";
  return "other";
}

// Raycast owns persistence; this is the shape it stores between 10s ticks.
export type ClaudeOffsets = Record<
  string,
  {
    offset: number;
    in: number;
    out: number;
    cacheCreate: number;
    activeMs: number;
    lastTs: number;
    model?: string;
  }
>;

// A pause longer than this isn't work, it's the session sitting idle between
// resumes — transcripts routinely span weeks with one 300h+ gap in the middle.
const IDLE_GAP_MS = 5 * 60_000;

const HOME = homedir();
// Herdr.app runs every terminal in herdr-core (`hc`); the app itself only
// arranges them. Core answers listing, the app answers focus.
const CORE = [
  `${HOME}/.local/bin/herdr-core`,
  `${HOME}/.local/bin/hc`,
  "/opt/homebrew/bin/herdr-core",
].find(existsSync);
const APP = [
  `${HOME}/.local/bin/herdr-app`,
  "/Applications/Herdr.app/Contents/MacOS/Herdr",
].find(existsSync);

// --- discovery -------------------------------------------------------------

/** herdr-core status → ours. `error` needs a human just like `blocked`. */
export function normalizeState(s: unknown): AgentState {
  if (s === "error" || s === "waiting") return "blocked";
  if (s === "busy") return "working"; // ~/.claude/sessions/<pid>.json says busy/idle
  return s === "working" || s === "idle" || s === "blocked" || s === "done"
    ? s
    : "unknown";
}

// herdr-core names apps by product; the stats dispatch keys off the short name.
const TYPE: Record<string, string> = { "claude-code": "claude" };

function core(args: string): unknown {
  return JSON.parse(
    execSync(`${CORE} ${args}`, { timeout: 3000, encoding: "utf-8" }),
  );
}

/** Claude Code writes ~/.claude/sessions/<pid>.json: live session id + name. */
function claudeSession(pid: unknown): {
  sessionId?: string;
  name?: string;
  status?: string;
  statusUpdatedAt?: number;
} {
  if (typeof pid !== "number") return {};
  try {
    return JSON.parse(
      readFileSync(`${HOME}/.claude/sessions/${pid}.json`, "utf-8"),
    );
  } catch {
    return {}; // remote agent, or not claude
  }
}

/** Every agent terminal herdr-core knows, this machine's and connected ones'. */
export function listAgents(): Agent[] {
  if (!CORE) return [];
  let terminals: { address: string; status?: string }[];
  try {
    terminals = (core("ls --json") as { terminals?: [] }).terminals ?? [];
  } catch {
    return []; // core not running
  }
  const out: Agent[] = [];
  // Other machines' agents come back as "machine/tN": state only, since their
  // transcripts and pids aren't on this disk.
  for (const { address, status } of terminals) {
    // A claude typed into a herdr shell reports no status, so local shells get
    // a look at their foreground process. ponytail: remote shells are skipped —
    // a `get` over ssh per shell is too slow for a 10s tick.
    if (!status && address.includes("/")) continue;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = core(`get ${address} --json`) as any;
      const fg = basename(t.foreground?.argv?.[0] ?? "");
      const type = t.status?.app
        ? (TYPE[t.status.app] ?? t.status.app)
        : fg === "claude" || fg === "codex"
          ? fg
          : undefined;
      if (!type) continue; // a plain shell
      const cwd: string = t.foreground?.cwd ?? t.cwd ?? "";
      const cs = type === "claude" ? claudeSession(t.foreground?.pid) : {};
      out.push({
        type,
        // titles are task names ("Backmerge stage into dev") except a fresh
        // Claude's generic "Claude Code" — then Claude's session name is better.
        name:
          t.name ||
          // a shell-launched agent's title is just the shell's cwd
          (t.status && t.title !== "Claude Code" && t.title) ||
          cs.name ||
          t.title ||
          basename(cwd) ||
          type,
        cwd,
        state: normalizeState(t.status?.state ?? cs.status),
        // ponytail: codex has no pid→session file; its stats stay empty until
        // herdr-core exposes the session id.
        sessionId: cs.sessionId,
        terminal: address,
        seq: t.status_ms ?? cs.statusUpdatedAt ?? 0,
      });
    } catch {
      // terminal ended between ls and get
    }
  }
  return out.sort(byPriority);
}

/** Show an agent in the Herdr window. Returns false when it can't be targeted. */
export function focusAgent(agent: Agent): boolean {
  if (!APP || !agent.terminal) return false;
  try {
    // exits non-zero with {"error"} when the terminal is gone → catch
    execSync(`${APP} do agent.focus --terminal ${agent.terminal}`, {
      timeout: 3000,
    });
    execSync("open -a Herdr"); // the command shows it; this brings the window forward
    return true;
  } catch {
    return false;
  }
}

// --- parsers (pure, unit-tested) -------------------------------------------

/**
 * Sum message.usage and active time over every COMPLETE (newline-terminated)
 * line in `text`. `consumed` is the byte length up to and including the last
 * newline, so a caller can advance a file offset and never split a partial line.
 * `prevTs` carries the previous chunk's last timestamp so active time keeps
 * accumulating correctly across incremental reads.
 */
export function parseClaudeUsage(
  text: string,
  prevTs = 0,
): {
  in: number;
  out: number;
  cacheCreate: number;
  consumed: number;
  activeMs: number;
  lastTs: number;
  model?: string;
} {
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0)
    return {
      in: 0,
      out: 0,
      cacheCreate: 0,
      consumed: 0,
      activeMs: 0,
      lastTs: prevTs,
    };
  const complete = text.slice(0, lastNl + 1);
  let tin = 0,
    tout = 0,
    cc = 0,
    activeMs = 0,
    prev = prevTs,
    model: string | undefined;
  for (const line of complete.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      const u = entry?.message?.usage;
      if (u) {
        tin += u.input_tokens || 0;
        tout += u.output_tokens || 0;
        cc += u.cache_creation_input_tokens || 0;
      }
      const m = entry?.message?.model;
      if (m && m !== "<synthetic>") model = m; // last reply wins — /model switches mid-session
      const t = entry?.timestamp ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isNaN(t)) {
        const delta = t - prev;
        if (prev > 0 && delta > 0 && delta <= IDLE_GAP_MS) activeMs += delta;
        if (t > prev) prev = t;
      }
    } catch {
      // skip a malformed line rather than lose the whole tick
    }
  }
  return {
    in: tin,
    out: tout,
    cacheCreate: cc,
    consumed: Buffer.byteLength(complete),
    activeMs,
    lastTs: prev,
    model,
  };
}

/** Newest `timestamp` in a JSONL tail, scanning backwards. 0 when none parse. */
export function scanLastTimestamp(text: string): number {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const t = JSON.parse(lines[i])?.timestamp;
      const ms = t ? Date.parse(t) : NaN;
      if (!Number.isNaN(ms)) return ms;
    } catch {
      // tail window can clip the first line mid-JSON — ignore
    }
  }
  return 0;
}

/** Latest cumulative token_count in a Codex rollout tail (scanning backwards). */
export function scanCodexTokenCount(
  text: string,
): { input: number; output: number } | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"type":"token_count"')) continue;
    try {
      const info = JSON.parse(lines[i])?.payload?.info?.total_token_usage;
      if (info)
        return {
          input: info.input_tokens || 0,
          output: info.output_tokens || 0,
        };
    } catch {
      // tail window can clip the first line mid-JSON — ignore
    }
  }
  return undefined;
}

// --- per-agent stats -------------------------------------------------------

function claudeTranscriptPath(cwd: string, sessionId: string): string {
  const dashed = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return `${HOME}/.claude/projects/${dashed}/${sessionId}.jsonl`;
}

// tokens = input + output + cache_creation (new tokens; cache_read excluded as it isn't fresh work)
function claudeStats(
  cwd: string,
  sessionId: string,
  cache: ClaudeOffsets,
): Stats | undefined {
  const path = claudeTranscriptPath(cwd, sessionId);
  if (!existsSync(path)) return undefined;
  const st = statSync(path);
  const entry = cache[path];

  if (entry && st.size === entry.offset) {
    // no growth since last tick — zero reads
  } else {
    const start = entry && st.size > entry.offset ? entry.offset : 0;
    const base =
      start > 0 && entry
        ? entry
        : { offset: 0, in: 0, out: 0, cacheCreate: 0, activeMs: 0, lastTs: 0 };
    const len = st.size - start;
    let text = "";
    if (len > 0) {
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, start);
        text = buf.toString("utf-8");
      } finally {
        closeSync(fd);
      }
    }
    const p = parseClaudeUsage(text, base.lastTs);
    cache[path] = {
      offset: start + p.consumed,
      in: base.in + p.in,
      out: base.out + p.out,
      cacheCreate: base.cacheCreate + p.cacheCreate,
      activeMs: base.activeMs + p.activeMs,
      lastTs: p.lastTs,
      model: p.model ?? base.model,
    };
  }

  const c = cache[path];
  return {
    tokens: c.in + c.out + c.cacheCreate,
    durationMs: c.activeMs, // time actually worked, not file age
    // mtime lies: Claude Code appends untimestamped records and rewrites the
    // transcript on load, so a 40h-cold session can look touched a minute ago.
    // The last real message timestamp is the only honest activity signal.
    lastActiveMs: c.lastTs || st.mtimeMs,
    model: c.model,
  };
}

function codexRolloutPath(sessionId: string): string | undefined {
  const root = `${HOME}/.codex/sessions`;
  if (!existsSync(root)) return undefined;
  const suffix = `-${sessionId}.jsonl`;
  // dirs only: codex leaves stray rollout-*.jsonl (and .DS_Store) next to the
  // YYYY/ dirs, and a stray file sorts first — readdirSync on it throws ENOTDIR.
  const descNum = (dir: string) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a));
  for (const y of descNum(root))
    for (const m of descNum(`${root}/${y}`))
      for (const d of descNum(`${root}/${y}/${m}`)) {
        const day = `${root}/${y}/${m}/${d}`;
        const hit = readdirSync(day).find((f) => f.endsWith(suffix));
        if (hit) return `${day}/${hit}`;
      }
  return undefined;
}

function codexStartMs(path: string): number | undefined {
  const m = basename(path).match(
    /rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-/,
  );
  if (!m) return undefined;
  const t = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`).getTime();
  return Number.isNaN(t) ? undefined : t;
}

function codexStats(sessionId: string): Stats | undefined {
  const path = codexRolloutPath(sessionId);
  if (!path) return undefined;
  const st = statSync(path);
  const start = Math.max(0, st.size - 64 * 1024);
  const len = st.size - start;
  let text = "";
  if (len > 0) {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      text = buf.toString("utf-8");
    } finally {
      closeSync(fd);
    }
  }
  const tc = scanCodexTokenCount(text);
  const startMs = codexStartMs(path);
  const lastTs = scanLastTimestamp(text);
  const endMs = lastTs || st.mtimeMs;
  return {
    tokens: tc ? tc.input + tc.output : 0,
    // ponytail: rollouts are one file per session, so span is honest enough —
    // no cross-week resume gap to subtract like Claude transcripts have.
    durationMs: startMs ? Math.max(0, endMs - startMs) : 0,
    lastActiveMs: endMs,
  };
}

/** Dispatch by agent type. `cache` is the Claude offset map (mutated in place). Undefined = no local data. */
export function getStats(
  agent: Agent,
  cache: ClaudeOffsets,
): Stats | undefined {
  if (!agent.sessionId) return undefined;
  if (agent.type === "claude")
    return claudeStats(agent.cwd, agent.sessionId, cache);
  if (agent.type === "codex") return codexStats(agent.sessionId);
  return undefined;
}

// --- blink -----------------------------------------------------------------

/**
 * Next frame of a menu-bar blink, given the previously stored `"<frame>:<ms>"`.
 * Raycast renders a menu-bar command TWICE per launch (~15ms apart), so a plain
 * render counter advances by two every tick, the parity never changes, and the
 * icon looks frozen. Flipping on elapsed time instead makes the repeat render a
 * no-op, so exactly one flip lands per 10s background tick.
 */
export function nextFrame(
  frames: string[],
  stored: string | undefined,
  now: number,
  minGapMs = 5000,
): { frame: string; stored: string } {
  const [glyph, at] = (stored ?? "").split(":");
  const i = frames.indexOf(glyph);
  if (i >= 0 && now - Number(at) < minGapMs)
    return { frame: glyph, stored: stored! };
  const frame = frames[(i + 1) % frames.length];
  return { frame, stored: `${frame}:${now}` };
}

// --- formatting ------------------------------------------------------------

/** "claude-opus-5-5" → "opus 5.5", "claude-haiku-4-5-20251001" → "haiku 4.5". */
export function formatModel(id: string): string {
  return id
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-(\d+)-(\d+)$/, " $1.$2")
    .replace(/-(\d+)$/, " $1");
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatDuration(ms: number): string {
  const min = Math.floor(ms / 60000);
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}
