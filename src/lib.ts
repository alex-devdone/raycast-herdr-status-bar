import { execSync } from "child_process";
import {
  existsSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
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
  paneId?: string; // e.g. "w1:p1" — the target `herdr agent focus` takes
  sock?: string; // socket the agent was found on, needed to focus it
  seq: number; // state_change_seq — recency tie-break inside a priority bucket
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
  // ponytail: seq is per-session, so cross-session ties order arbitrarily —
  // matches herdr exactly within a session, which is what the panel shows.
  return ATTENTION[b.state] - ATTENTION[a.state] || b.seq - a.seq;
}

export interface Stats {
  tokens: number; // headline usage total (see per-type notes below)
  durationMs: number; // session activity span
  lastActiveMs: number; // transcript/rollout mtime — the "date modified" we bucket by
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
  }
>;

// A pause longer than this isn't work, it's the session sitting idle between
// resumes — transcripts routinely span weeks with one 300h+ gap in the middle.
const IDLE_GAP_MS = 5 * 60_000;

const HOME = homedir();
const HERDR = [
  `${HOME}/.local/bin/herdr`,
  "/opt/homebrew/bin/herdr",
  "/usr/local/bin/herdr",
].find(existsSync);

// --- discovery -------------------------------------------------------------

function normalizeState(s: unknown): AgentState {
  return s === "working" || s === "idle" || s === "blocked" || s === "done"
    ? s
    : "unknown";
}

/** All agents across every live herdr session socket, deduped by terminal_id. */
export function listAgents(): Agent[] {
  if (!HERDR) return [];
  const sessionsDir = `${HOME}/.config/herdr/sessions`;
  if (!existsSync(sessionsDir)) return [];
  const socks = readdirSync(sessionsDir)
    .map((d) => `${sessionsDir}/${d}/herdr.sock`)
    .filter(existsSync);

  const seen = new Set<string>();
  const out: Agent[] = [];
  for (const sock of socks) {
    try {
      const stdout = execSync(`${HERDR} agent list`, {
        timeout: 3000,
        encoding: "utf-8",
        env: { ...process.env, HERDR_SOCKET_PATH: sock },
      });
      const agents = JSON.parse(stdout)?.result?.agents ?? [];
      for (const a of agents) {
        if (!a?.agent) continue; // rows without a detected agent type
        const tid: string | undefined = a.terminal_id;
        if (tid && seen.has(tid)) continue;
        if (tid) seen.add(tid);
        const cwd: string = a.cwd ?? "";
        out.push({
          type: a.agent,
          name: a.name || basename(cwd) || a.agent,
          cwd,
          state: normalizeState(a.agent_status),
          sessionId: a.agent_session?.value,
          paneId: a.pane_id,
          sock,
          seq: a.state_change_seq ?? 0,
        });
      }
    } catch {
      // dead / stale socket — skip it
    }
  }
  return out.sort(byPriority);
}

/** Focus an agent's pane in herdr. Returns false when it can't be targeted. */
export function focusAgent(agent: Agent): boolean {
  if (!HERDR || !agent.paneId || !agent.sock) return false;
  try {
    const stdout = execSync(`${HERDR} agent focus ${agent.paneId}`, {
      timeout: 3000,
      encoding: "utf-8",
      env: { ...process.env, HERDR_SOCKET_PATH: agent.sock },
    });
    return !JSON.parse(stdout)?.error; // herdr reports failures in-band, exit 0
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
    prev = prevTs;
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
  };
}

function codexRolloutPath(sessionId: string): string | undefined {
  const root = `${HOME}/.codex/sessions`;
  if (!existsSync(root)) return undefined;
  const suffix = `-${sessionId}.jsonl`;
  const descNum = (dir: string) =>
    readdirSync(dir)
      .filter((n) => existsSync(`${dir}/${n}`))
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
