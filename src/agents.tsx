import {
  MenuBarExtra,
  Icon,
  Color,
  Cache,
  Clipboard,
  showHUD,
} from "@raycast/api";
import {
  listAgents,
  getStats,
  focusAgent,
  dateBucket,
  nextFrame,
  formatTokens,
  formatDuration,
  type Agent,
  type AgentState,
  type DateBucket,
  type Stats,
  type ClaudeOffsets,
} from "./lib";

const cache = new Cache();
const OFFSETS_KEY = "claude-offsets-v2"; // v1 entries lack activeMs/lastTs

const ALERT_KEY = "alert-frame";

// Blocked: the logo's backdrop alternates yellow/orange on each 10s tick.
// Swapping the icon (fixed size) rather than a title glyph is what keeps the
// menu bar from reflowing, and riding the existing tick means no `isLoading`
// and no resident process — the command still unloads after every render.
const ALERT = ["herdr-menu-alert.png", "herdr-menu-alert-orange.png"];

interface Row {
  agent: Agent;
  stats?: Stats;
}

// Finder-style sections; agents inside keep listAgents()' priority order.
const BUCKET_ORDER: DateBucket[] = [
  "last1h",
  "last5h",
  "today",
  "yesterday",
  "prev7",
  "prev30",
  "other",
];
const BUCKET_LABEL: Record<DateBucket, string> = {
  last1h: "Last Hour",
  last5h: "Last 5 Hours",
  today: "Today",
  yesterday: "Yesterday",
  prev7: "Previous 7 Days",
  prev30: "Previous 30 Days",
  other: "Other",
};

function stateIcon(state: AgentState) {
  const tint =
    state === "blocked"
      ? Color.Red
      : state === "working"
        ? Color.Green
        : state === "done"
          ? Color.Blue
          : Color.SecondaryText;
  return { source: Icon.CircleFilled, tintColor: tint };
}

function rowSubtitle(row: Row): string {
  const { agent, stats } = row;
  if (!stats) return `${agent.type} · no local stats`;
  const parts = [agent.type];
  if (stats.tokens > 0) parts.push(`${formatTokens(stats.tokens)} tok`);
  if (stats.durationMs > 0) parts.push(formatDuration(stats.durationMs));
  return parts.join(" · ");
}

function load(): { rows: Row[]; hasHerdr: boolean } {
  const offsets: ClaudeOffsets = (() => {
    try {
      return JSON.parse(cache.get(OFFSETS_KEY) ?? "{}");
    } catch {
      return {};
    }
  })();

  const agents = listAgents();
  const rows: Row[] = agents.map((agent) => ({
    agent,
    stats: getStats(agent, offsets),
  }));

  // prune offsets to only currently-live claude transcripts, then persist
  const live = new Set(
    rows.map((r) => r.agent).filter((a) => a.type === "claude"),
  );
  const pruned: ClaudeOffsets = {};
  for (const key of Object.keys(offsets)) {
    if ([...live].some((a) => key.endsWith(`/${a.sessionId}.jsonl`)))
      pruned[key] = offsets[key];
  }
  cache.set(OFFSETS_KEY, JSON.stringify(pruned));

  return { rows, hasHerdr: agents.length > 0 };
}

export default function Command() {
  let rows: Row[] = [];
  let hasHerdr = false;
  try {
    ({ rows, hasHerdr } = load());
  } catch {
    // background launches must never throw
  }

  const working = rows.filter((r) => r.agent.state === "working").length;
  const blocked = rows.filter((r) => r.agent.state === "blocked").length;
  const totalTokens = rows.reduce((n, r) => n + (r.stats?.tokens ?? 0), 0);

  // Blocked needs no count — the coloured logo says it. Working still does,
  // since "how many are running" is the whole point of the menu bar entry.
  const title = working > 0 ? `${working}▸` : undefined;

  let icon = "herdr-menu.png";
  if (blocked > 0) {
    const blink = nextFrame(ALERT, cache.get(ALERT_KEY), Date.now());
    cache.set(ALERT_KEY, blink.stored);
    icon = blink.frame;
  }

  const now = Date.now();

  return (
    <MenuBarExtra
      // same logo with the backdrop rect repainted — a tintColor would flatten
      // the ram into a single-colour silhouette, since it's not a template image
      icon={{ source: icon }}
      title={title}
      tooltip="AI Agents (herdr)"
    >
      {!hasHerdr && <MenuBarExtra.Item title="No herdr sessions found" />}

      {BUCKET_ORDER.map((bucket) => {
        const group = rows.filter(
          (r) => dateBucket(r.stats?.lastActiveMs, now) === bucket,
        );
        if (group.length === 0) return null;
        return (
          <MenuBarExtra.Section key={bucket} title={BUCKET_LABEL[bucket]}>
            {group.map((row, i) => (
              <MenuBarExtra.Item
                key={`${bucket}-${i}`}
                icon={stateIcon(row.agent.state)}
                title={row.agent.name}
                subtitle={rowSubtitle(row)}
                tooltip={row.agent.cwd}
                onAction={async () => {
                  if (focusAgent(row.agent)) return; // herdr jumps to the pane — that IS the feedback
                  await Clipboard.copy(row.agent.cwd);
                  await showHUD(`Copied ${row.agent.cwd}`);
                }}
              />
            ))}
          </MenuBarExtra.Section>
        );
      })}

      {rows.length > 0 && (
        <MenuBarExtra.Section>
          <MenuBarExtra.Item
            icon={Icon.BarChart}
            title={`${rows.length} agents · ${working} working · ${blocked} blocked`}
            subtitle={
              totalTokens > 0 ? `Σ ${formatTokens(totalTokens)} tok` : undefined
            }
          />
        </MenuBarExtra.Section>
      )}
    </MenuBarExtra>
  );
}
