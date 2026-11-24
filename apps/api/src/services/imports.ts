import { randomUUID } from "node:crypto";
import type { Database, Executor } from "@soa/db";
import {
  applyColumnMap,
  dedupeKey,
  ColumnMap,
  suggestColumnMap,
  validateImportRow,
  type ImportPreviewResponse,
  type ImportStatus,
  type ImportUploadResponse,
} from "@soa/shared";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { Clock } from "../clock";
import { badRequest, conflict, notFound, unprocessable } from "../errors";
import { JOBS, type JobQueue } from "../jobs/queue";
import type { ObjectStore } from "../providers/storage";
import { accountsRepo } from "../repos/accounts";
import { auditRepo } from "../repos/audit";
import {
  activitiesRepo,
  contactsRepo,
  importsRepo,
  signalsRepo,
  sourcesRepo,
  suppressionsRepo,
  type ImportRow,
} from "../repos/children";
import { systemScope, userScope, type Scope, type UserScope } from "../repos/scope";
import { usersRepo } from "../repos/users";
import { contentHash } from "./accounts";
import { livePricing, recomputeFit } from "./mappers";

/* CSV import (docs/API.md "Imports and export"). Upload → preview with a column map → run as a job.
   CSV text is untrusted: it is stored as data and never interpreted (CLAUDE.md rule 4). */

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 20_000;

const SavedSettings = z.object({ columnMap: ColumnMap, assignToMe: z.boolean() });
const RowError = z.object({ row: z.number(), name: z.string().nullable(), reason: z.string() });

export interface ParsedCsv {
  headers: string[];
  /** Data records with the spreadsheet line each one starts on (the header is line 1). */
  rows: { line: number; record: string[] }[];
}

export function parseCsv(file: Buffer): ParsedCsv {
  let parsed: { record: string[]; info: { lines: number } }[];
  try {
    const output: unknown = parse(file, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
      max_record_size: 64 * 1024,
      info: true,
    });
    parsed = output as { record: string[]; info: { lines: number } }[];
  } catch {
    throw badRequest("The file could not be read as CSV.");
  }
  const [header, ...data] = parsed;
  if (header === undefined || data.length === 0) {
    throw badRequest("The file needs a header row and at least one data row.");
  }
  if (data.length > MAX_IMPORT_ROWS) throw badRequest(`Import at most ${String(MAX_IMPORT_ROWS)} rows at a time.`);
  // info.lines is the line a record ends on; a record spanning lines starts earlier, so count back its newlines.
  return {
    headers: header.record,
    rows: data.map(({ record, info }) => ({
      line: info.lines - record.reduce((sum, field) => sum + (field.match(/\n/g)?.length ?? 0), 0),
      record,
    })),
  };
}

export interface Judged {
  /** The spreadsheet line the record starts on (the header is line 1). */
  row: number;
  record: string[];
  name: string | null;
  /** created: made by an earlier run of this same import (when resuming). */
  verdict: "new" | "duplicate" | "invalid" | "created";
  reason?: string;
}

/** Classifies every data row: invalid, duplicate (in the CRM or earlier in the file), new, or already created. */
export async function judgeRows(
  db: Executor,
  csv: ParsedCsv,
  map: ColumnMap,
  createdByThisImport: ReadonlySet<string> = new Set(),
): Promise<Judged[]> {
  const validated = csv.rows.map(({ line, record }) => {
    const values = applyColumnMap(record, map);
    return { row: line, record, values, result: validateImportRow(values) };
  });
  const names = [
    ...new Set(validated.flatMap((entry) => (entry.result.ok ? [entry.result.row.account.name.toLowerCase()] : []))),
  ];
  const existing = await accountsRepo(db).existingKeys(systemScope("import duplicate check"), names);
  const seen = new Set<string>();
  return validated.map(({ row, record, values, result }): Judged => {
    const typedName = (values.account_name ?? "").trim();
    if (!result.ok) {
      return { row, record, name: typedName === "" ? null : typedName, verdict: "invalid", reason: result.reason };
    }
    const name = result.row.account.name;
    const key = dedupeKey(name, result.row.account.city);
    if (createdByThisImport.has(key) && !seen.has(key)) {
      seen.add(key);
      return { row, record, name, verdict: "created" };
    }
    if (existing.has(key) || seen.has(key)) {
      return {
        row,
        record,
        name,
        verdict: "duplicate",
        reason: existing.has(key)
          ? "Already in the CRM (same name and city)"
          : "Repeats an earlier row (same name and city)",
      };
    }
    seen.add(key);
    return { row, record, name, verdict: "new" };
  });
}

function toStatus(row: ImportRow): ImportStatus {
  const errors = z.array(RowError).safeParse(row.errors);
  return {
    id: row.id,
    filename: row.filename,
    status: row.status as ImportStatus["status"],
    rowsTotal: row.rowsTotal,
    rowsCreated: row.rowsCreated,
    rowsSkipped: row.rowsSkipped,
    errors: errors.success ? errors.data : [],
    createdAt: row.createdAt.toISOString(),
  };
}

export function createImportsService(deps: { db: Database; store: ObjectStore; queue: JobQueue }) {
  const { db, store, queue } = deps;
  return {
    async upload(scope: UserScope, filename: string, file: Buffer): Promise<ImportUploadResponse> {
      if (file.length > MAX_IMPORT_BYTES) throw badRequest("The file is larger than 10 MB.");
      const csv = parseCsv(file);
      const id = randomUUID();
      const objectKey = `imports/${id}.csv`;
      await store.put(objectKey, file, "text/csv");
      const safeName = filename.replace(/[^\w. -]/g, "_").slice(0, 200) || "import.csv";
      await importsRepo(db).insert(scope, {
        id,
        userId: scope.userId,
        filename: safeName,
        objectKey,
        rowsTotal: csv.rows.length,
      });
      return {
        id,
        filename: safeName,
        headers: csv.headers,
        sampleRows: csv.rows.slice(0, 20).map((row) => row.record),
        rowsTotal: csv.rows.length,
        suggestedMap: suggestColumnMap(csv.headers),
      };
    },

    async preview(
      scope: UserScope,
      id: string,
      columnMap: ColumnMap,
      assignToMe: boolean,
    ): Promise<ImportPreviewResponse> {
      const current = await importsRepo(db).get(scope, id);
      if (current === undefined) throw notFound();
      if (current.status !== "uploaded" && current.status !== "previewed") {
        throw conflict("already_started", "This import has already run.");
      }
      if (!Object.values(columnMap).includes("account_name")) {
        throw unprocessable("no_name_column", "Choose which column holds the account name.");
      }
      const judged = await judgeRows(db, parseCsv(await store.get(current.objectKey)), columnMap);
      await importsRepo(db).update(scope, id, {
        status: "previewed",
        columnMap: { columnMap, assignToMe },
        rowsTotal: judged.length,
      });
      const skipped = judged.filter((entry) => entry.verdict !== "new");
      return {
        newCount: judged.length - skipped.length,
        duplicateCount: judged.filter((entry) => entry.verdict === "duplicate").length,
        invalidCount: judged.filter((entry) => entry.verdict === "invalid").length,
        skipped: skipped.map((entry) => ({ row: entry.row, name: entry.name, reason: entry.reason ?? "" })),
      };
    },

    async run(scope: UserScope, id: string, ip: string | null): Promise<ImportStatus> {
      const current = await importsRepo(db).get(scope, id);
      if (current === undefined) throw notFound();
      // One atomic step from previewed (or failed, to resume) to running: two clicks can't start two jobs.
      const started = await db.transaction(async (tx) => {
        const row = await importsRepo(tx).transition(scope, id, ["previewed", "failed"], "running");
        if (row !== undefined)
          await auditRepo(tx).write(scope, { action: "import.start", entityType: "import", entityId: id, ip });
        return row;
      });
      if (started === undefined) {
        throw conflict(
          "not_runnable",
          current.status === "running" ? "This import is already running." : "Preview the import before running it.",
        );
      }
      try {
        await queue.send(JOBS.importRun, { importId: id });
      } catch (error) {
        await importsRepo(db).transition(scope, id, ["running"], current.status === "failed" ? "failed" : "previewed");
        throw error;
      }
      return toStatus(started);
    },

    async status(scope: UserScope, id: string): Promise<ImportStatus> {
      const current = await importsRepo(db).get(scope, id);
      if (current === undefined) throw notFound();
      return toStatus(current);
    },
  };
}

export type ImportsService = ReturnType<typeof createImportsService>;

/** The import.run job (worker). Each row is its own transaction; a failed import can be run again and resumes. */
export async function runImport(
  deps: { db: Database; store: ObjectStore; clock: Clock },
  importId: string,
): Promise<void> {
  const { db, store, clock } = deps;
  const system = systemScope("import.run");
  const job = await importsRepo(db).get(system, importId);
  if (job?.status !== "running") return;
  const settings = SavedSettings.safeParse(job.columnMap);
  const importer = await usersRepo(db).findById(system, job.userId);
  if (!settings.success || importer === undefined) {
    await importsRepo(db).update(system, importId, {
      status: "failed",
      errors: [{ row: 0, name: null, reason: "Import settings are missing." }],
    });
    return;
  }
  const scope: Scope = userScope(importer.id, importer.role);
  const owner = settings.data.assignToMe ? importer.id : null;

  try {
    const csv = parseCsv(await store.get(job.objectKey));
    // Resuming after a failure: accounts this import already created count as created, not as duplicates.
    const earlier = await accountsRepo(db).keysFromSource(system, importId);
    const judged = await judgeRows(db, csv, settings.data.columnMap, earlier);
    const pricing = await livePricing(db, scope, clock());
    const errors: z.infer<typeof RowError>[] = [];
    let created = judged.filter((entry) => entry.verdict === "created").length;

    for (const entry of judged) {
      if (entry.verdict === "created") continue;
      if (entry.verdict !== "new") {
        errors.push({ row: entry.row, name: entry.name, reason: entry.reason ?? "" });
        continue;
      }
      const result = validateImportRow(applyColumnMap(entry.record, settings.data.columnMap));
      if (!result.ok) continue; // judged as new, so this cannot happen
      const { account: fields, contact, signal } = result.row;
      const inserted = await db.transaction(async (tx) => {
        const account = await accountsRepo(tx).insert(scope, {
          ...fields,
          source: "csv",
          sourceRef: importId,
          ownerUserId: owner,
          createdBy: importer.id,
        });
        if (account === undefined) return false; // someone created it since the preview
        if (contact !== null) {
          const status =
            contact.email === null
              ? undefined
              : (await suppressionsRepo(tx).reasons(scope, [contact.email])).get(contact.email);
          await contactsRepo(tx).insert(scope, {
            accountId: account.id,
            ...contact,
            isPrimary: true,
            emailStatus: status === undefined ? "ok" : status === "bounce" ? "bounced" : "unsubscribed",
          });
        }
        if (signal !== null) {
          const source = await sourcesRepo(tx).insert(scope, {
            accountId: account.id,
            kind: "upload",
            title: `Imported from ${job.filename}`,
            contentText: signal,
            contentHash: contentHash(signal),
            addedBy: importer.id,
          });
          // Text from a CSV is untrusted: stored as an unconfirmed signal until a rep confirms it.
          await signalsRepo(tx).insert(scope, {
            accountId: account.id,
            text: signal,
            kind: "other",
            sourceId: source.id,
            confirmed: false,
            createdBy: importer.id,
          });
        }
        await activitiesRepo(tx).insert(scope, {
          accountId: account.id,
          type: "note",
          subject: `Imported from ${job.filename}`,
          meta: { importId },
        });
        await recomputeFit(tx, scope, account.id, clock(), pricing);
        return true;
      });
      if (inserted) created += 1;
      else errors.push({ row: entry.row, name: entry.name, reason: "Already in the CRM (same name and city)" });
    }

    await db.transaction(async (tx) => {
      await importsRepo(tx).update(system, importId, {
        status: "done",
        rowsTotal: judged.length,
        rowsCreated: created,
        rowsSkipped: errors.length,
        errors,
      });
      await auditRepo(tx).write(scope, {
        action: "import.run",
        entityType: "import",
        entityId: importId,
        meta: { created, skipped: errors.length },
      });
    });
    // The file holds contact details; once imported it is not kept.
    await store.delete(job.objectKey).catch(() => undefined);
  } catch (error) {
    await importsRepo(db).update(system, importId, {
      status: "failed",
      errors: [
        {
          row: 0,
          name: null,
          reason:
            error instanceof Error && error.name === "HttpError"
              ? error.message
              : "The import failed. Run it again to resume.",
        },
      ],
    });
    throw error;
  }
}
