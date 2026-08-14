/**
 * Raw ClickUp task JSON runs 2-4KB each. Returning 100 of them verbatim costs more
 * context than the answer is worth, so every tool projects down to the fields a
 * person actually reads and renders markdown instead of JSON.
 */

export interface CompactTask {
  id: string;
  custom_id: string | null;
  name: string;
  status: string;
  assignees: string[];
  /** Local-time YYYY-MM-DD, or null when the task has no due date. */
  due: string | null;
  priority: string | null;
  list: string | null;
  tags: string[];
  estimate_hours: number | null;
  url: string;
}

/** ClickUp sends timestamps as unix-millisecond strings. */
function toLocalDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = Number(value);
  if (!Number.isFinite(ms)) return null;
  // 'sv-SE' formats as YYYY-MM-DD, and doing it via toLocaleDateString keeps the
  // date in the machine's timezone — toISOString would shift Bangkok dates back a day.
  return new Date(ms).toLocaleDateString("sv-SE");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function compactTask(raw: Record<string, unknown>): CompactTask {
  const status = asRecord(raw.status);
  const priority = asRecord(raw.priority);
  const list = asRecord(raw.list);
  const assignees = Array.isArray(raw.assignees) ? raw.assignees : [];
  const tags = Array.isArray(raw.tags) ? raw.tags : [];
  const estimateMs = Number(raw.time_estimate);

  return {
    id: String(raw.id ?? ""),
    custom_id: raw.custom_id ? String(raw.custom_id) : null,
    name: String(raw.name ?? ""),
    status: status ? String(status.status ?? "") : "",
    assignees: assignees
      .map((a) => asRecord(a))
      .map((a) => (a ? String(a.username ?? a.email ?? "") : ""))
      .filter(Boolean),
    due: toLocalDate(raw.due_date),
    priority: priority ? String(priority.priority ?? "") : null,
    list: list ? String(list.name ?? "") : null,
    tags: tags
      .map((t) => asRecord(t))
      .map((t) => (t ? String(t.name ?? "") : ""))
      .filter(Boolean),
    estimate_hours: Number.isFinite(estimateMs) ? Math.round((estimateMs / 3_600_000) * 10) / 10 : null,
    url: String(raw.url ?? ""),
  };
}

function line(task: CompactTask): string {
  const bits: string[] = [`- **${task.name}**`];
  bits.push(`[${task.status}]`);
  if (task.due) bits.push(`due ${task.due}`);
  if (task.priority) bits.push(`p:${task.priority}`);
  if (task.list) bits.push(`in ${task.list}`);
  if (task.assignees.length) bits.push(`@${task.assignees.join(" @")}`);
  if (task.tags.length) bits.push(`#${task.tags.join(" #")}`);
  if (task.estimate_hours) bits.push(`~${task.estimate_hours}h`);
  bits.push(`(${task.custom_id ?? task.id})`);
  return bits.join(" ");
}

export function renderTaskList(tasks: CompactTask[]): string {
  if (!tasks.length) return "_no tasks matched_";
  return tasks.map(line).join("\n");
}

export type DueBucket = "overdue" | "today" | "this week" | "later" | "no due date";

export function bucketOf(due: string | null, today: string): DueBucket {
  if (!due) return "no due date";
  if (due < today) return "overdue";
  if (due === today) return "today";
  const weekEnd = new Date(`${today}T00:00:00`);
  weekEnd.setDate(weekEnd.getDate() + 7);
  return due <= weekEnd.toLocaleDateString("sv-SE") ? "this week" : "later";
}

const BUCKET_ORDER: DueBucket[] = ["overdue", "today", "this week", "later", "no due date"];

/** Groups by urgency so a standup answer reads top-down without further sorting. */
export function renderByDueBucket(tasks: CompactTask[]): string {
  const today = new Date().toLocaleDateString("sv-SE");
  const groups = new Map<DueBucket, CompactTask[]>();
  for (const task of tasks) {
    const bucket = bucketOf(task.due, today);
    const group = groups.get(bucket);
    if (group) group.push(task);
    else groups.set(bucket, [task]);
  }

  const sections: string[] = [];
  for (const bucket of BUCKET_ORDER) {
    const group = groups.get(bucket);
    if (!group?.length) continue;
    group.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
    sections.push(`## ${bucket} (${group.length})\n${renderTaskList(group)}`);
  }
  return sections.length ? sections.join("\n\n") : "_no open tasks_";
}
