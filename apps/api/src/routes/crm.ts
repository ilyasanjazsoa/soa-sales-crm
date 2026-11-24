import {
  AccountPatch,
  AccountsQuery,
  AssignRequest,
  ContactInput,
  ContactPatch,
  CreateAccountRequest,
  CreateDealRequest,
  DealPatch,
  DealsQuery,
  IdParam,
  ImportPreviewRequest,
  ListQuery,
  LoseRequest,
  NoteInput,
  SignalInput,
  SignalPatch,
  StageMoveRequest,
  TaskInput,
  TaskPatch,
  TasksQuery,
} from "@soa/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionOf } from "../auth/plugin";
import { badRequest } from "../errors";
import type { AccountsService } from "../services/accounts";
import type { DealsService } from "../services/deals";
import type { ExportService } from "../services/export";
import { MAX_IMPORT_BYTES, type ImportsService } from "../services/imports";
import type { TasksService } from "../services/tasks";

/* Accounts, contacts, signals, timeline, deals, tasks, imports and export (docs/API.md). Routes parse and
   delegate; services decide; repos enforce visibility. */

const session = { config: { access: "session" } } as const;
const manager = { config: { access: "manager" } } as const;
const DeleteQuery = z.object({ purge: z.enum(["true", "false"]).optional() });
const ForecastQuery = z.object({ owner: z.union([z.literal("me"), z.literal("all"), z.uuid()]).optional() });

export function registerCrmRoutes(
  app: FastifyInstance,
  deps: {
    accounts: AccountsService;
    deals: DealsService;
    tasks: TasksService;
    imports: ImportsService;
    exports: ExportService;
  },
): void {
  const { accounts, deals, tasks, imports, exports } = deps;
  const id = (params: unknown) => IdParam.parse(params).id;

  // ───────── accounts ─────────
  app.get("/api/accounts", session, async (request) =>
    accounts.search(sessionOf(request).scope, AccountsQuery.parse(request.query)),
  );
  app.post("/api/accounts", session, async (request, reply) =>
    reply
      .code(201)
      .send(await accounts.create(sessionOf(request).scope, CreateAccountRequest.parse(request.body), request.ip)),
  );
  app.get("/api/accounts/:id", session, async (request) => accounts.get(sessionOf(request).scope, id(request.params)));
  app.patch("/api/accounts/:id", session, async (request) =>
    accounts.update(sessionOf(request).scope, id(request.params), AccountPatch.parse(request.body)),
  );
  app.post("/api/accounts/:id/claim", session, async (request) =>
    accounts.claim(sessionOf(request).scope, id(request.params), request.ip),
  );
  app.post("/api/accounts/:id/assign", manager, async (request) =>
    accounts.assign(
      sessionOf(request).scope,
      id(request.params),
      AssignRequest.parse(request.body).ownerUserId,
      request.ip,
    ),
  );
  app.delete("/api/accounts/:id", session, async (request, reply) => {
    const purge = DeleteQuery.parse(request.query).purge === "true";
    await accounts.remove(sessionOf(request).scope, id(request.params), purge, request.ip);
    return reply.code(204).send();
  });

  // ───────── contacts ─────────
  app.post("/api/accounts/:id/contacts", session, async (request, reply) =>
    reply
      .code(201)
      .send(await accounts.addContact(sessionOf(request).scope, id(request.params), ContactInput.parse(request.body))),
  );
  app.patch("/api/contacts/:id", session, async (request) =>
    accounts.updateContact(sessionOf(request).scope, id(request.params), ContactPatch.parse(request.body)),
  );
  app.delete("/api/contacts/:id", session, async (request, reply) => {
    await accounts.deleteContact(sessionOf(request).scope, id(request.params));
    return reply.code(204).send();
  });
  app.post("/api/contacts/:id/erase", manager, async (request) =>
    accounts.eraseContact(sessionOf(request).scope, id(request.params), request.ip),
  );

  // ───────── signals ─────────
  app.get("/api/accounts/:id/signals", session, async (request) => ({
    items: await accounts.listSignals(sessionOf(request).scope, id(request.params)),
  }));
  app.post("/api/accounts/:id/signals", session, async (request, reply) =>
    reply
      .code(201)
      .send(await accounts.addSignal(sessionOf(request).scope, id(request.params), SignalInput.parse(request.body))),
  );
  app.patch("/api/signals/:id", session, async (request) =>
    accounts.updateSignal(sessionOf(request).scope, id(request.params), SignalPatch.parse(request.body)),
  );
  app.delete("/api/signals/:id", session, async (request, reply) => {
    await accounts.deleteSignal(sessionOf(request).scope, id(request.params));
    return reply.code(204).send();
  });

  // ───────── timeline ─────────
  app.get("/api/accounts/:id/timeline", session, async (request) => {
    const query = ListQuery.parse(request.query);
    return accounts.timeline(sessionOf(request).scope, id(request.params), query.cursor, query.limit);
  });
  app.post("/api/accounts/:id/notes", session, async (request, reply) => {
    await accounts.addNote(sessionOf(request).scope, id(request.params), NoteInput.parse(request.body).text);
    return reply.code(201).send({ ok: true });
  });

  // ───────── deals ─────────
  app.get("/api/deals", session, async (request) =>
    deals.list(sessionOf(request).scope, DealsQuery.parse(request.query)),
  );
  app.post("/api/accounts/:id/deals", session, async (request, reply) =>
    reply
      .code(201)
      .send(
        await deals.create(
          sessionOf(request).scope,
          id(request.params),
          CreateDealRequest.parse(request.body ?? {}),
          request.ip,
        ),
      ),
  );
  app.patch("/api/deals/:id", session, async (request) =>
    deals.update(sessionOf(request).scope, id(request.params), DealPatch.parse(request.body)),
  );
  app.post("/api/deals/:id/stage", session, async (request) =>
    deals.moveStage(
      sessionOf(request).scope,
      id(request.params),
      StageMoveRequest.parse(request.body).stage,
      request.ip,
    ),
  );
  app.post("/api/deals/:id/lose", session, async (request) => {
    const body = LoseRequest.parse(request.body);
    return deals.lose(sessionOf(request).scope, id(request.params), body.reason, body.note, request.ip);
  });
  app.post("/api/deals/:id/reopen", manager, async (request) =>
    deals.reopen(sessionOf(request).scope, id(request.params), request.ip),
  );
  app.get("/api/forecast", session, async (request) =>
    deals.forecast(sessionOf(request).scope, ForecastQuery.parse(request.query).owner),
  );

  // ───────── tasks ─────────
  app.get("/api/tasks", session, async (request) => {
    const query = TasksQuery.parse(request.query);
    return {
      items: await tasks.list(sessionOf(request).scope, {
        open: query.open === undefined ? undefined : query.open === "true",
        accountId: query.accountId,
      }),
    };
  });
  app.post("/api/tasks", session, async (request, reply) =>
    reply.code(201).send(await tasks.create(sessionOf(request).scope, TaskInput.parse(request.body))),
  );
  app.patch("/api/tasks/:id", session, async (request) =>
    tasks.update(sessionOf(request).scope, id(request.params), TaskPatch.parse(request.body)),
  );

  // ───────── imports and export ─────────
  app.post("/api/imports", session, async (request, reply) => {
    const file = await request.file({ limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } });
    if (file === undefined) throw badRequest("Attach a CSV file.");
    if (!/\.csv$/i.test(file.filename)) throw badRequest("Only .csv files can be imported.");
    const buffer = await file.toBuffer();
    if (file.file.truncated) throw badRequest("The file is larger than 10 MB.");
    return reply.code(201).send(await imports.upload(sessionOf(request).scope, file.filename, buffer));
  });
  app.post("/api/imports/:id/preview", session, async (request) => {
    const body = ImportPreviewRequest.parse(request.body);
    return imports.preview(sessionOf(request).scope, id(request.params), body.columnMap, body.assignToMe);
  });
  app.post("/api/imports/:id/run", session, async (request, reply) =>
    reply.code(202).send(await imports.run(sessionOf(request).scope, id(request.params), request.ip)),
  );
  app.get("/api/imports/:id", session, async (request) => imports.status(sessionOf(request).scope, id(request.params)));

  app.get("/api/export/accounts.csv", manager, async (request, reply) =>
    reply
      .type("text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="accounts.csv"')
      .send(await exports.accounts(sessionOf(request).scope, request.ip)),
  );
  app.get("/api/export/deals.csv", manager, async (request, reply) =>
    reply
      .type("text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="deals.csv"')
      .send(await exports.deals(sessionOf(request).scope, request.ip)),
  );
}
