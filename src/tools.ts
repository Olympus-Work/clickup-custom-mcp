/**
 * Seven coarse tools, each shaped around a job rather than an endpoint.
 *
 * The fan-out lives here, not in the model: one `get_my_work` call costs 2 HTTP
 * requests, where walking space -> folder -> list -> task from the model side costs
 * thirty. That difference is the entire reason this server exists.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { ClickUpClient, ClickUpError, STRUCTURE_TTL_MS } from "./clickup.js";
import { compactTask, renderByDueBucket, renderTaskList } from "./format.js";

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/** Accepts `YYYY-MM-DD` or raw unix millis; ClickUp only takes the latter. */
function toClickUpTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const ms = new Date(`${value}T00:00:00`).getTime();
  if (!Number.isFinite(ms)) throw new Error(`Unparseable date: ${value}`);
  return ms;
}

const taskFilters = {
  list_ids: z.array(z.string()).optional().describe("Restrict to these list ids"),
  space_ids: z.array(z.string()).optional().describe("Restrict to these space ids"),
  assignees: z.array(z.string()).optional().describe("Numeric ClickUp user ids"),
  statuses: z.array(z.string()).optional().describe("Status names, e.g. ['in progress']"),
  tags: z.array(z.string()).optional(),
  include_closed: z.boolean().optional().describe("Default false"),
  subtasks: z.boolean().optional().describe("Include subtasks, default true"),
  due_date_lt: z.string().optional().describe("Due before this date (YYYY-MM-DD)"),
  due_date_gt: z.string().optional().describe("Due after this date (YYYY-MM-DD)"),
  date_updated_gt: z.string().optional().describe("Updated after this date (YYYY-MM-DD)"),
  order_by: z.enum(["id", "created", "updated", "due_date"]).optional(),
};

export function registerTools(server: McpServer, clickup: ClickUpClient): void {
  server.registerTool(
    "get_workspace_map",
    {
      title: "Workspace map",
      description:
        "The workspace's spaces, folders, lists (with their status names) and members, plus your own numeric user id. " +
        "Call this first when you need an id for any other tool. Cached for 15 minutes, so repeat calls are free.",
      inputSchema: z.object({
        include_custom_fields: z
          .boolean()
          .optional()
          .describe("Also fetch custom field definitions — costs one extra request per list. Default false."),
      }),
    },
    async ({ include_custom_fields }) => {
      const before = clickup.calls;
      const [me, teamId] = await Promise.all([clickup.me(), clickup.getTeamId()]);

      const map = await clickup.cached(
        `map:${teamId}:${include_custom_fields ? "fields" : "plain"}`,
        STRUCTURE_TTL_MS,
        async () => {
          const spaces = await clickup.request<{ spaces: Array<{ id: string; name: string }> }>(
            `/team/${teamId}/space`,
            { query: { archived: false } },
          );

          const sections = await Promise.all(
            spaces.spaces.map(async (space) => {
              const [folders, loose] = await Promise.all([
                clickup.request<{
                  folders: Array<{ id: string; name: string; lists: Array<Record<string, unknown>> }>;
                }>(`/space/${space.id}/folder`, { query: { archived: false } }),
                clickup.request<{ lists: Array<Record<string, unknown>> }>(`/space/${space.id}/list`, {
                  query: { archived: false },
                }),
              ]);

              const describeList = async (list: Record<string, unknown>, indent: string) => {
                const statuses = Array.isArray(list.statuses)
                  ? list.statuses
                      .map((s) => (typeof s === "object" && s ? String((s as Record<string, unknown>).status) : ""))
                      .filter(Boolean)
                  : [];
                let out = `${indent}- list **${String(list.name)}** (${String(list.id)})`;
                if (statuses.length) out += ` — statuses: ${statuses.join(", ")}`;
                if (include_custom_fields) {
                  const fields = await clickup.request<{
                    fields: Array<{ id: string; name: string; type: string }>;
                  }>(`/list/${String(list.id)}/field`);
                  for (const field of fields.fields) {
                    out += `\n${indent}  - field ${field.name} (${field.type}, ${field.id})`;
                  }
                }
                return out;
              };

              const lines = [`# space **${space.name}** (${space.id})`];
              for (const list of loose.lists) lines.push(await describeList(list, ""));
              for (const folder of folders.folders) {
                lines.push(`- folder **${folder.name}** (${folder.id})`);
                for (const list of folder.lists) lines.push(await describeList(list, "  "));
              }
              return lines.join("\n");
            }),
          );
          return sections.join("\n\n");
        },
      );

      const members = await clickup.cached(`members:${teamId}`, STRUCTURE_TTL_MS, async () => {
        const data = await clickup.request<{
          teams: Array<{ id: string; members: Array<{ user: { id: number; username: string } }> }>;
        }>("/team");
        const team = data.teams.find((t) => t.id === teamId);
        return (team?.members ?? []).map((m) => `${m.user.username} (${m.user.id})`);
      });

      return text(
        [
          `You are **${me.username}** (user id ${me.id}) in workspace ${teamId}.`,
          "",
          map,
          "",
          `## members\n${members.join(", ")}`,
          "",
          `_${clickup.calls - before} HTTP request(s) used._`,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "get_my_work",
    {
      title: "My open work",
      description:
        "Every open task assigned to you across the whole workspace, grouped by overdue / today / this week / later. " +
        "This is the one to call for a standup, a 'what's on my plate' question, or a backlog sweep.",
      inputSchema: z.object({
        include_closed: z.boolean().optional().describe("Include finished tasks too. Default false."),
      }),
    },
    async ({ include_closed }) => {
      const before = clickup.calls;
      const me = await clickup.me();
      // ClickUp's assignees[] filter takes numeric ids only — a literal "me" returns
      // an empty list rather than an error, which is why the id is resolved first.
      const page = await clickup.searchTasks({
        "assignees": [me.id],
        include_closed: include_closed ?? false,
        subtasks: true,
        order_by: "due_date",
      });

      const tasks = page.items.map(compactTask);
      const notes = [`_${tasks.length} task(s), ${clickup.calls - before} HTTP request(s)._`];
      if (page.truncated) {
        notes.unshift(`**Truncated** — stopped after ${page.pages} pages (${tasks.length} tasks). Narrow the filters to see the rest.`);
      }
      return text(`${renderByDueBucket(tasks)}\n\n${notes.join("\n")}`);
    },
  );

  server.registerTool(
    "search_tasks",
    {
      title: "Search tasks",
      description:
        "Filtered task query across the entire workspace in one request — the tool to build any report or analytics on. " +
        "Every filter is optional and they combine. Paginates automatically and says so if it hits the cap.",
      inputSchema: z.object({
        ...taskFilters,
        max_pages: z.number().int().min(1).max(20).optional().describe("100 tasks per page, default 10"),
      }),
    },
    async (args) => {
      const before = clickup.calls;
      const page = await clickup.searchTasks(
        {
          "list_ids": args.list_ids,
          "space_ids": args.space_ids,
          "assignees": args.assignees,
          "statuses": args.statuses,
          "tags": args.tags,
          include_closed: args.include_closed ?? false,
          subtasks: args.subtasks ?? true,
          due_date_lt: toClickUpTimestamp(args.due_date_lt),
          due_date_gt: toClickUpTimestamp(args.due_date_gt),
          date_updated_gt: toClickUpTimestamp(args.date_updated_gt),
          order_by: args.order_by,
        },
        args.max_pages ?? 10,
      );

      const tasks = page.items.map(compactTask);
      const notes = [`_${tasks.length} task(s), ${clickup.calls - before} HTTP request(s)._`];
      if (page.truncated) {
        notes.unshift(`**Truncated** — stopped after ${page.pages} pages. There are more matches than shown.`);
      }
      return text(`${renderTaskList(tasks)}\n\n${notes.join("\n")}`);
    },
  );

  server.registerTool(
    "get_task",
    {
      title: "Task detail",
      description:
        "Full detail for one task: description, custom field values, subtasks, and optionally its comments. " +
        "Use it after search_tasks or get_my_work has narrowed things down to a single task.",
      inputSchema: z.object({
        task_id: z.string(),
        include_comments: z.boolean().optional().describe("Costs one extra request. Default false."),
      }),
    },
    async ({ task_id, include_comments }) => {
      const raw = await clickup.request<Record<string, unknown>>(`/task/${task_id}`, {
        query: { include_subtasks: true },
      });
      const task = compactTask(raw);

      const parts = [
        `# ${task.name}`,
        renderTaskList([task]),
        "",
        `## description\n${String(raw.description ?? raw.text_content ?? "_empty_")}`,
      ];

      const customFields = Array.isArray(raw.custom_fields) ? raw.custom_fields : [];
      const filled = customFields
        .map((f) => (typeof f === "object" && f ? (f as Record<string, unknown>) : null))
        .filter((f): f is Record<string, unknown> => f !== null && f.value !== undefined && f.value !== null);
      if (filled.length) {
        parts.push(
          `## custom fields\n${filled.map((f) => `- ${String(f.name)}: ${JSON.stringify(f.value)}`).join("\n")}`,
        );
      }

      const subtasks = Array.isArray(raw.subtasks) ? raw.subtasks : [];
      if (subtasks.length) {
        parts.push(
          `## subtasks\n${renderTaskList(subtasks.map((s) => compactTask(s as Record<string, unknown>)))}`,
        );
      }

      if (include_comments) {
        const data = await clickup.request<{
          comments: Array<{ user?: { username?: string }; comment_text?: string; date?: string }>;
        }>(`/task/${task_id}/comment`);
        const rendered = data.comments
          .map((c) => `- **${c.user?.username ?? "?"}**: ${(c.comment_text ?? "").trim()}`)
          .join("\n");
        parts.push(`## comments\n${rendered || "_none_"}`);
      }

      return text(parts.join("\n"));
    },
  );

  server.registerTool(
    "create_task",
    {
      title: "Create tasks",
      description:
        "Create one or many tasks in one go — pass the whole array when breaking a discussion into a backlog, " +
        "rather than calling this repeatedly. Each task is reported individually; one failure does not abort the rest.",
      inputSchema: z.object({
        tasks: z
          .array(
            z.object({
              list_id: z.string().describe("From get_workspace_map"),
              name: z.string(),
              description: z.string().optional(),
              status: z.string().optional().describe("Must be one of that list's statuses"),
              assignees: z.array(z.number()).optional().describe("Numeric user ids"),
              due_date: z.string().optional().describe("YYYY-MM-DD"),
              priority: z.number().int().min(1).max(4).optional().describe("1 urgent .. 4 low"),
              tags: z.array(z.string()).optional(),
              parent: z.string().optional().describe("Parent task id — makes this a subtask"),
            }),
          )
          .min(1),
      }),
    },
    async ({ tasks }) => {
      const before = clickup.calls;
      const results: string[] = [];

      for (const spec of tasks) {
        try {
          const created = await clickup.request<Record<string, unknown>>(`/list/${spec.list_id}/task`, {
            method: "POST",
            body: {
              name: spec.name,
              description: spec.description,
              status: spec.status,
              assignees: spec.assignees,
              due_date: toClickUpTimestamp(spec.due_date),
              due_date_time: false,
              priority: spec.priority,
              tags: spec.tags,
              parent: spec.parent,
            },
          });
          results.push(`- created **${spec.name}** → ${String(created.id)} ${String(created.url ?? "")}`);
        } catch (error) {
          const reason = error instanceof ClickUpError ? error.body : String(error);
          results.push(`- FAILED **${spec.name}**: ${reason}`);
        }
      }

      return text(`${results.join("\n")}\n\n_${clickup.calls - before} HTTP request(s)._`);
    },
  );

  server.registerTool(
    "update_task",
    {
      title: "Update tasks",
      description:
        "Update one or many existing tasks — status changes, re-assignment, due dates, renames. " +
        "Pass the whole array for a bulk change. Each update is reported individually.",
      inputSchema: z.object({
        updates: z
          .array(
            z.object({
              task_id: z.string(),
              name: z.string().optional(),
              description: z.string().optional(),
              status: z.string().optional(),
              due_date: z.string().optional().describe("YYYY-MM-DD"),
              priority: z.number().int().min(1).max(4).optional(),
              add_assignees: z.array(z.number()).optional(),
              remove_assignees: z.array(z.number()).optional(),
              archived: z.boolean().optional(),
            }),
          )
          .min(1),
      }),
    },
    async ({ updates }) => {
      const before = clickup.calls;
      const results: string[] = [];

      for (const update of updates) {
        try {
          const body: Record<string, unknown> = {
            name: update.name,
            description: update.description,
            status: update.status,
            priority: update.priority,
            archived: update.archived,
          };
          const due = toClickUpTimestamp(update.due_date);
          if (due !== undefined) {
            body.due_date = due;
            body.due_date_time = false;
          }
          if (update.add_assignees || update.remove_assignees) {
            body.assignees = { add: update.add_assignees ?? [], rem: update.remove_assignees ?? [] };
          }

          const updated = await clickup.request<Record<string, unknown>>(`/task/${update.task_id}`, {
            method: "PUT",
            body,
          });
          results.push(`- updated **${String(updated.name)}** (${update.task_id})`);
        } catch (error) {
          const reason = error instanceof ClickUpError ? error.body : String(error);
          results.push(`- FAILED ${update.task_id}: ${reason}`);
        }
      }

      return text(`${results.join("\n")}\n\n_${clickup.calls - before} HTTP request(s)._`);
    },
  );

  server.registerTool(
    "comment_task",
    {
      title: "Comment on tasks",
      description:
        "Post a comment to one or many tasks — the audit trail for a status change, a dropped ticket, or a design " +
        "divergence that the task's description should not be rewritten to carry. Each comment is reported individually.",
      inputSchema: z.object({
        comments: z
          .array(
            z.object({
              task_id: z.string(),
              text: z.string().describe("Comment body; ClickUp renders it as plain text"),
              notify_all: z
                .boolean()
                .optional()
                .describe("Ping every watcher of the task. Default false — a bot note should not page people."),
            }),
          )
          .min(1),
      }),
    },
    async ({ comments }) => {
      const before = clickup.calls;
      const results: string[] = [];

      for (const spec of comments) {
        try {
          const created = await clickup.request<Record<string, unknown>>(`/task/${spec.task_id}/comment`, {
            method: "POST",
            body: {
              comment_text: spec.text,
              notify_all: spec.notify_all ?? false,
            },
          });
          results.push(`- commented on ${spec.task_id} (comment ${String(created.id ?? "?")})`);
        } catch (error) {
          const reason = error instanceof ClickUpError ? error.body : String(error);
          results.push(`- FAILED ${spec.task_id}: ${reason}`);
        }
      }

      return text(`${results.join("\n")}\n\n_${clickup.calls - before} HTTP request(s)._`);
    },
  );
}
