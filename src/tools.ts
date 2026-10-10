/**
 * Eight coarse tools, each shaped around a job rather than an endpoint.
 *
 * The fan-out lives here, not in the model: one `get_my_work` call costs 2 HTTP
 * requests, where walking space -> folder -> list -> task from the model side costs
 * thirty. That difference is the entire reason this server exists.
 */

import { realpath, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, relative, isAbsolute, resolve } from "node:path";
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

/** get_task's include_images: formats a model can view, and caps that keep a reply inside context. */
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGES = 8;
/** Base64 adds a third, and the Claude API rejects images over 5 MB. */
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;

/** get_task's include_text_files: ClickUp labels some of these application/octet-stream, so match on extension too. */
const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "htm", "log"]);
const MAX_TEXT_BYTES = 100 * 1024;
const MAX_TEXT_TOTAL = 300 * 1024;

function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "? B";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

const DEFAULT_MAX_UPLOAD_MB = 50;
const REFUSED_NAME = /^(\.env.*|.*\.pem|.*\.key|id_.*)$/i;

/** A `.env` value is not shell-expanded, so a leading `~` would otherwise be read as a relative folder. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

/**
 * Resolve a caller-supplied path to a real file the upload is allowed to read.
 * Throws a clear message for anything outside CLICKUP_UPLOAD_DIR (default ~/Downloads),
 * sensitive names, non-files, or files over CLICKUP_MAX_UPLOAD_MB — before any read or request.
 */
async function resolveUploadable(filePath: string): Promise<string> {
  const configured = process.env.CLICKUP_UPLOAD_DIR;
  const dir = await realpath(configured ? resolve(expandHome(configured)) : resolve(homedir(), "Downloads"));
  const real = await realpath(resolve(filePath));
  const rel = relative(dir, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`file is outside the allowed upload directory (${dir})`);
  }
  if (REFUSED_NAME.test(basename(filePath)) || REFUSED_NAME.test(basename(real))) {
    throw new Error("refusing to upload a file with a sensitive name (.env*, *.pem, *.key, id_*)");
  }
  const info = await stat(real);
  if (!info.isFile()) throw new Error("not a regular file");
  const maxMb = Number(process.env.CLICKUP_MAX_UPLOAD_MB);
  const cap = (Number.isFinite(maxMb) && maxMb > 0 ? maxMb : DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024;
  if (info.size > cap) {
    throw new Error(`file is ${(info.size / 1048576).toFixed(1)} MB, over the ${cap / 1048576} MB cap`);
  }
  return real;
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
        "Full detail for one task: markdown description (inline images kept as links), custom field values, " +
        "subtasks, attachments, and optionally its comments and the attachments' contents (images, text files). " +
        "Use it after search_tasks or get_my_work has narrowed things down to a single task.",
      inputSchema: z.object({
        task_id: z.string(),
        include_comments: z.boolean().optional().describe("Costs one extra request. Default false."),
        include_images: z
          .boolean()
          .optional()
          .describe(
            `Return image attachments (png/jpeg/gif/webp) as images, up to ${MAX_IMAGES}. ` +
              "No API request cost, but each image uses a lot of context. Default false.",
          ),
        include_text_files: z
          .boolean()
          .optional()
          .describe(
            `Inline the contents of text attachments (md, txt, csv, json, yaml, xml, html, log), ` +
              `${formatBytes(MAX_TEXT_BYTES)} per file and ${formatBytes(MAX_TEXT_TOTAL)} in total. ` +
              "No API request cost. Default false.",
          ),
        attachment_names: z
          .array(z.string())
          .optional()
          .describe(
            "Only fetch these attachments (title or id, as listed by a previous get_task) for include_images " +
              "and include_text_files — use it to reach files a cap skipped.",
          ),
      }),
    },
    async ({ task_id, include_comments, include_images, include_text_files, attachment_names }) => {
      const raw = await clickup.request<Record<string, unknown>>(`/task/${task_id}`, {
        query: { include_subtasks: true, include_markdown_description: true },
      });
      const task = compactTask(raw);
      const description = String(raw.markdown_description || raw.description || raw.text_content || "_empty_");

      const parts = [`# ${task.name}`, renderTaskList([task]), "", `## description\n${description}`];

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

      const attachments = (Array.isArray(raw.attachments) ? raw.attachments : [])
        .map((a) => (typeof a === "object" && a ? (a as Record<string, unknown>) : null))
        .filter((a): a is Record<string, unknown> => a !== null && a.deleted !== true);
      if (attachments.length) {
        const lines = attachments.map((a) => {
          // The attachment id is "<uuid>.<ext>"; the same uuid appears in an inline image's URL.
          const inline = description.includes(String(a.id ?? "").split(".")[0] || "\0") ? " (inline above)" : "";
          return `- ${String(a.title ?? "?")} — ${String(a.mimetype ?? "?")}, ${formatBytes(Number(a.size))}${inline} ${String(a.url ?? "")}`;
        });
        parts.push(`## attachments\n${lines.join("\n")}`);
      }

      const wanted = attachment_names ? new Set(attachment_names) : null;
      const selected = wanted
        ? attachments.filter((a) => wanted.has(String(a.title ?? "")) || wanted.has(String(a.id ?? "")))
        : attachments;
      if (wanted && (include_images || include_text_files)) {
        const missing = [...wanted].filter(
          (n) => !attachments.some((a) => String(a.title ?? "") === n || String(a.id ?? "") === n),
        );
        if (missing.length) parts.push(`_No attachment named: ${missing.join(", ")}_`);
      }
      const capHint = attachment_names ? "" : " — pass attachment_names to fetch it";

      if (include_text_files) {
        const notes: string[] = [];
        let used = 0;
        for (const a of selected) {
          const ext = String(a.extension ?? "").toLowerCase();
          if (!String(a.mimetype ?? "").startsWith("text/") && !TEXT_EXTENSIONS.has(ext)) continue;
          const title = String(a.title ?? "?");
          // Exported prototypes are often hundreds of KB of minified markup — mostly noise for a model.
          if (!wanted && (ext === "html" || ext === "htm" || a.mimetype === "text/html")) {
            notes.push(`- skipped ${title}: HTML is only read when named in attachment_names`);
            continue;
          }
          if (used >= MAX_TEXT_TOTAL) {
            notes.push(`- skipped ${title}: the ${formatBytes(MAX_TEXT_TOTAL)} total text cap is used up${capHint}`);
            continue;
          }
          try {
            const bytes = await clickup.download(String(a.url ?? ""));
            const cap = Math.min(MAX_TEXT_BYTES, MAX_TEXT_TOTAL - used);
            used += Math.min(bytes.length, cap);
            const cut = bytes.length > cap ? `\n\n_Truncated: showing the first ${formatBytes(cap)} of ${formatBytes(bytes.length)}._` : "";
            parts.push(`## file: ${title}\n\`\`\`\`${ext}\n${bytes.subarray(0, cap).toString("utf8")}\n\`\`\`\`${cut}`);
          } catch (error) {
            notes.push(`- FAILED ${title}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (notes.length) parts.push(`## text files not shown\n${notes.join("\n")}`);
      }

      const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
      if (include_images) {
        const notes: string[] = [];
        for (const a of selected) {
          const mime = String(a.mimetype ?? "");
          if (!mime.startsWith("image/")) continue;
          const title = String(a.title ?? "?");
          if (!IMAGE_MIMES.has(mime)) {
            notes.push(`- skipped ${title}: ${mime} cannot be shown as an image`);
          } else if (images.length >= MAX_IMAGES) {
            notes.push(`- skipped ${title}: over the ${MAX_IMAGES}-image cap${capHint}`);
          } else if (Number(a.size) > MAX_IMAGE_BYTES) {
            notes.push(`- skipped ${title}: ${formatBytes(Number(a.size))} is over the ${formatBytes(MAX_IMAGE_BYTES)} cap`);
          } else {
            try {
              const bytes = await clickup.download(String(a.url ?? ""));
              images.push({ type: "image", data: bytes.toString("base64"), mimeType: mime });
              notes.push(`- image ${images.length}: ${title} (${String(a.id ?? "?")})`);
            } catch (error) {
              notes.push(`- FAILED ${title}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        parts.push(`## images (in the order attached below)\n${notes.join("\n") || "_none_"}`);
      }

      return { content: [{ type: "text" as const, text: parts.join("\n") }, ...images] };
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

  server.registerTool(
    "upload_attachment",
    {
      title: "Attach files to tasks",
      description:
        "Upload local files as attachments on one or many tasks. This PUBLISHES the file to ClickUp, so confirm " +
        "with the user before calling. Only files under CLICKUP_UPLOAD_DIR (default ~/Downloads) are allowed; " +
        ".env*, *.pem, *.key and id_* are refused, as is anything over the size cap. Each file is reported individually.",
      inputSchema: z.object({
        attachments: z
          .array(
            z.object({
              task_id: z.string(),
              file_path: z.string().describe("Absolute path to a local file"),
              filename: z.string().optional().describe("Name shown in ClickUp. Defaults to the file's own name."),
            }),
          )
          .min(1),
      }),
    },
    async ({ attachments }) => {
      const before = clickup.calls;
      const results: string[] = [];

      for (const spec of attachments) {
        try {
          const file = await resolveUploadable(spec.file_path);
          const form = new FormData();
          form.append("attachment", new Blob([await readFile(file)]), spec.filename ?? basename(file));
          const made = await clickup.request<Record<string, unknown>>(`/task/${spec.task_id}/attachment`, {
            method: "POST",
            form,
          });
          results.push(
            `- attached ${String(made.title ?? "?")} to ${spec.task_id} (attachment ${String(made.id ?? "?")}) ${String(made.url ?? "")}`,
          );
        } catch (error) {
          const reason = error instanceof ClickUpError ? error.body : error instanceof Error ? error.message : String(error);
          results.push(`- FAILED ${spec.task_id}: ${reason}`);
        }
      }

      return text(`${results.join("\n")}\n\n_${clickup.calls - before} HTTP request(s)._`);
    },
  );
}
