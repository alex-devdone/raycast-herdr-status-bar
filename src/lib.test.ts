import assert from "assert";
import {
  parseClaudeUsage,
  scanCodexTokenCount,
  scanLastTimestamp,
  byPriority,
  dateBucket,
  nextFrame,
  formatTokens,
  formatDuration,
  type Agent,
  type AgentState,
} from "./lib";

// --- dateBucket: Finder-style calendar-day sections ---
{
  const now = new Date("2026-07-24T15:00:00").getTime();
  const at = (s: string) => new Date(s).getTime();
  assert.equal(dateBucket(now, now), "last1h");
  assert.equal(dateBucket(at("2026-07-24T14:00:00"), now), "last1h"); // 1h edge
  assert.equal(dateBucket(at("2026-07-24T13:59:00"), now), "last5h"); // just over 1h
  assert.equal(dateBucket(at("2026-07-24T10:00:00"), now), "last5h"); // 5h edge
  assert.equal(dateBucket(at("2026-07-24T09:59:00"), now), "today"); // just over 5h, same day
  assert.equal(dateBucket(at("2026-07-24T00:30:00"), now), "today");
  assert.equal(dateBucket(at("2026-07-23T23:59:00"), now), "yesterday");
  assert.equal(dateBucket(at("2026-07-23T00:00:00"), now), "yesterday");
  assert.equal(dateBucket(at("2026-07-21T12:00:00"), now), "prev7");
  assert.equal(dateBucket(at("2026-07-17T00:00:00"), now), "prev7"); // 7-day edge
  assert.equal(dateBucket(at("2026-07-14T12:00:00"), now), "prev30");
  assert.equal(dateBucket(at("2026-06-24T00:00:00"), now), "prev30"); // 30-day edge
  assert.equal(dateBucket(at("2026-06-14T12:00:00"), now), "other");
  assert.equal(dateBucket(undefined, now), "other"); // no local activity time
}

// --- byPriority: herdr's attention queue, newest state change first ---
{
  const a = (state: AgentState, seq: number): Agent => ({
    type: "claude",
    name: `${state}-${seq}`,
    cwd: "",
    state,
    seq,
  });
  const sorted = [
    a("idle", 9),
    a("working", 1),
    a("unknown", 9),
    a("done", 1),
    a("blocked", 1),
    a("working", 7),
  ]
    .sort(byPriority)
    .map((x) => x.name);
  assert.deepEqual(
    sorted,
    ["blocked-1", "done-1", "working-7", "working-1", "idle-9", "unknown-9"],
    "blocked > done > working > idle > unknown, newer seq first within a bucket",
  );
}

// --- parseClaudeUsage: sums complete lines, ignores a trailing partial line ---
{
  const line = (u: object) => JSON.stringify({ message: { usage: u } });
  const complete =
    line({
      input_tokens: 100,
      output_tokens: 10,
      cache_creation_input_tokens: 5,
    }) +
    "\n" +
    line({
      input_tokens: 200,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 9999,
    }) +
    "\n";
  const partial = '{"message":{"usage":{"input_tokens":999'; // no newline, must be ignored
  const r = parseClaudeUsage(complete + partial);
  assert.equal(r.in, 300, "input summed");
  assert.equal(r.out, 30, "output summed");
  assert.equal(r.cacheCreate, 5, "cache_creation summed (cache_read excluded)");
  assert.equal(
    r.consumed,
    Buffer.byteLength(complete),
    "consumed stops at last newline",
  );

  // a non-usage line (user turn) contributes nothing and doesn't throw
  const withUser = '{"message":{"role":"user"}}\n' + complete;
  assert.equal(parseClaudeUsage(withUser).in, 300, "non-usage lines skipped");

  // no complete line at all
  assert.deepEqual(parseClaudeUsage("no newline here"), {
    in: 0,
    out: 0,
    cacheCreate: 0,
    consumed: 0,
    activeMs: 0,
    lastTs: 0,
  });
}

// --- active time: inter-message deltas, idle gaps excluded ---
{
  const at = (s: string, extra = {}) =>
    JSON.stringify({ timestamp: s, ...extra }) + "\n";
  const text =
    at("2026-07-24T10:00:00.000Z") +
    at("2026-07-24T10:01:00.000Z") + // +60s, counted
    at("2026-07-24T10:03:00.000Z") + // +120s, counted
    at("2026-07-24T20:00:00.000Z") + // +10h idle gap, NOT counted
    at("2026-07-24T20:00:30.000Z"); // +30s, counted
  const r = parseClaudeUsage(text);
  assert.equal(r.activeMs, (60 + 120 + 30) * 1000, "idle gap excluded");
  assert.equal(
    r.lastTs,
    Date.parse("2026-07-24T20:00:30.000Z"),
    "lastTs carries forward",
  );

  // resuming from a prior chunk: the gap to prevTs is bridged when short enough
  const next = parseClaudeUsage(at("2026-07-24T20:01:00.000Z"), r.lastTs);
  assert.equal(next.activeMs, 30_000, "delta measured from prevTs");

  // ...and dropped when the session sat idle across the chunk boundary
  const later = parseClaudeUsage(at("2026-07-25T09:00:00.000Z"), r.lastTs);
  assert.equal(later.activeMs, 0, "long gap across chunks not counted");

  // a first-ever line has no predecessor to measure against
  assert.equal(parseClaudeUsage(at("2026-07-24T10:00:00.000Z")).activeMs, 0);
}

// --- scanCodexTokenCount: latest cumulative total, backwards scan, clipped head tolerated ---
{
  const ev = (input: number, output: number) =>
    JSON.stringify({
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: input, output_tokens: output },
        },
      },
    });
  const text =
    'tokens":217728}}}' + // clipped first line from a 64KB tail window
    "\n" +
    ev(100, 10) +
    "\n" +
    ev(266940, 3918) + // newest — this is the one we want
    "\n" +
    '{"payload":{"type":"agent_message"}}';
  const r = scanCodexTokenCount(text);
  assert.deepEqual(
    r,
    { input: 266940, output: 3918 },
    "picks latest token_count",
  );
  assert.equal(
    scanCodexTokenCount("no token counts here"),
    undefined,
    "none found → undefined",
  );
}

// --- scanLastTimestamp: newest timestamp wins, clipped head tolerated ---
{
  const text =
    'ts":"2026-01-01T00:00:00Z"}' + // clipped first line
    "\n" +
    '{"timestamp":"2026-07-24T09:00:00.000Z"}' +
    "\n" +
    '{"timestamp":"2026-07-24T09:30:00.000Z"}' +
    "\n" +
    '{"payload":{"type":"agent_message"}}'; // no timestamp — keep scanning back
  assert.equal(
    scanLastTimestamp(text),
    Date.parse("2026-07-24T09:30:00.000Z"),
    "newest parseable timestamp",
  );
  assert.equal(scanLastTimestamp("nothing here"), 0, "none found → 0");
}

// --- nextFrame: one flip per tick, immune to the double render per launch ---
{
  const F = ["yellow.png", "orange.png"];
  let stored: string | undefined;
  const seen: string[] = [];
  let now = 1_000_000;
  for (let tick = 0; tick < 4; tick++) {
    const first = nextFrame(F, stored, now);
    stored = first.stored;
    const second = nextFrame(F, stored, now + 15); // Raycast's repeat render
    stored = second.stored;
    assert.equal(second.frame, first.frame, "repeat render must not flip");
    seen.push(first.frame);
    now += 10_000; // next background tick
  }
  assert.deepEqual(
    seen,
    ["yellow.png", "orange.png", "yellow.png", "orange.png"],
    "alternates once per 10s tick",
  );

  // missing or unrecognised stored value starts at the first frame
  assert.equal(nextFrame(F, undefined, 0).frame, "yellow.png");
  assert.equal(nextFrame(F, "gone.png:999", 9999).frame, "yellow.png");
}

// --- formatters ---
{
  assert.equal(formatTokens(1_234_567), "1.2M");
  assert.equal(formatTokens(12_500), "12.5K");
  assert.equal(formatTokens(950), "950");
  assert.equal(formatDuration(30_000), "<1m");
  assert.equal(formatDuration(45 * 60_000), "45m");
  assert.equal(formatDuration((2 * 60 + 14) * 60_000), "2h 14m");
  assert.equal(formatDuration(3 * 60 * 60_000), "3h");
}

console.log("lib.test.ts: all assertions passed");
