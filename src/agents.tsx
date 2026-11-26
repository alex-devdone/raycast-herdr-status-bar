import { useState } from "react";
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
  formatModel,
  formatTokens,
  formatDuration,
  type Agent,
  type AgentState,
  type DateBucket,
  type Stats,
  type ClaudeOffsets,
} from "./lib";

const cache = new Cache();
const OFFSETS_KEY = "claude-offsets-v3"; // v2 entries lack model

const ALERT_KEY = "alert-frame";

// One value per dimension; unset = show all. Cache, not state: each 10s tick is
// a fresh process, and the choice must outlive it.
const FILTER_KEY = "filter";
interface Filter {
  agent?: string;
  model?: string;
}
function readFilter(): Filter {
  try {
    return JSON.parse(cache.get(FILTER_KEY) ?? "{}");
  } catch {
    return {};
  }
}

// no local transcript (remote agents, codex) → no model to show
const modelOf = (r: Row) =>
  r.stats?.model ? formatModel(r.stats.model) : "unknown";

/** value → row count, most common first */
function tally(values: string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}

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
  const parts = [stats.model ? formatModel(stats.model) : agent.type];
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
  const rows: Row[] = agents.map((agent) => {
    try {
      return { agent, stats: getStats(agent, offsets) };
    } catch {
      return { agent }; // one unreadable transcript must not blank all 29 rows
    }
  });

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
  const [filter, setFilterState] = useState(readFilter);
  // Raycast closes the menu on every click; the saved filter shows next open.
  const setFilter = (f: Filter) => {
    cache.set(FILTER_KEY, JSON.stringify(f));
    setFilterState(f);
  };
  let rows: Row[] = [];
  let hasHerdr = false;
  try {
    ({ rows, hasHerdr } = load());
  } catch {
    // background launches must never throw
  }

  // the title and the blocked blink stay on ALL agents: a filter must not hide an alert
  const shown = rows.filter(
    (r) =>
      (!filter.agent || r.agent.type === filter.agent) &&
      (!filter.model || modelOf(r) === filter.model),
  );
  const filtered = !!(filter.agent || filter.model);

  const working = rows.filter((r) => r.agent.state === "working").length;
  const blocked = rows.filter((r) => r.agent.state === "blocked").length;
  const totalTokens = shown.reduce((n, r) => n + (r.stats?.tokens ?? 0), 0);

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

      {rows.length > 0 && (
        <MenuBarExtra.Section>
          <MenuBarExtra.Submenu
            icon={Icon.Filter}
            title={
              filtered
                ? `Filter: ${[filter.agent, filter.model].filter(Boolean).join(" · ")}`
                : "Filter"
            }
          >
            <MenuBarExtra.Section title="Agent">
              {tally(rows.map((r) => r.agent.type)).map(([v, n]) => (
                <MenuBarExtra.Item
                  key={`a-${v}`}
                  icon={filter.agent === v ? Icon.Checkmark : Icon.Circle}
                  title={v}
                  subtitle={String(n)}
                  onAction={() =>
                    setFilter({
                      ...filter,
                      agent: filter.agent === v ? undefined : v,
                    })
                  }
                />
              ))}
            </MenuBarExtra.Section>
            <MenuBarExtra.Section title="Model">
              {tally(rows.map(modelOf)).map(([v, n]) => (
                <MenuBarExtra.Item
                  key={`m-${v}`}
                  icon={filter.model === v ? Icon.Checkmark : Icon.Circle}
                  title={v}
                  subtitle={String(n)}
                  onAction={() =>
                    setFilter({
                      ...filter,
                      model: filter.model === v ? undefined : v,
                    })
                  }
                />
              ))}
            </MenuBarExtra.Section>
          </MenuBarExtra.Submenu>
          {filtered && (
            <MenuBarExtra.Item
              icon={Icon.XMarkCircle}
              title="Clear Filters"
              onAction={() => setFilter({})}
            />
          )}
        </MenuBarExtra.Section>
      )}

      {BUCKET_ORDER.map((bucket) => {
        const group = shown.filter(
          (r) =>
            dateBucket(
              r.stats?.lastActiveMs ?? (r.agent.seq || undefined),
              now,
            ) === bucket,
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
            title={`${filtered ? `${shown.length} of ${rows.length}` : rows.length} agents · ${working} working · ${blocked} blocked`}
            subtitle={
              totalTokens > 0 ? `Σ ${formatTokens(totalTokens)} tok` : undefined
            }
          />
        </MenuBarExtra.Section>
      )}
    </MenuBarExtra>
  );
}
