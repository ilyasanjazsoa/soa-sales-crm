import { AddSourceRequest, ClientReferenceInput, ClientReferencePatch, IdParam } from "@soa/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionOf } from "../auth/plugin";
import type { ResearchService } from "../services/research";

const session = { config: { access: "session" } } as const;
const manager = { config: { access: "manager" } } as const;
const BriefQuery = z.object({ version: z.coerce.number().int().positive().optional() });

export function registerResearchRoutes(app: FastifyInstance, deps: { research: ResearchService }): void {
  const { research } = deps;
  const id = (params: unknown) => IdParam.parse(params).id;

  app.get("/api/accounts/:id/sources", session, async (request) =>
    research.sources(sessionOf(request).scope, id(request.params)),
  );
  app.post("/api/accounts/:id/sources", session, async (request, reply) => {
    await research.addSource(sessionOf(request).scope, id(request.params), AddSourceRequest.parse(request.body));
    return reply.code(201).send({ ok: true });
  });
  app.post("/api/accounts/:id/research/fetch", session, async (request, reply) => {
    await research.requestFetch(sessionOf(request).scope, id(request.params));
    return reply.code(202).send({ status: "queued" });
  });
  app.post("/api/accounts/:id/brief", session, async (request, reply) => {
    await research.requestBrief(sessionOf(request).scope, id(request.params));
    return reply.code(202).send({ status: "queued" });
  });
  app.get("/api/accounts/:id/brief", session, async (request) =>
    research.brief(sessionOf(request).scope, id(request.params), BriefQuery.parse(request.query).version),
  );

  app.get("/api/admin/references", manager, async (request) => ({
    items: await research.references(sessionOf(request).scope),
  }));
  app.post("/api/admin/references", manager, async (request, reply) =>
    reply
      .code(201)
      .send(
        await research.createReference(sessionOf(request).scope, ClientReferenceInput.parse(request.body), request.ip),
      ),
  );
  app.patch("/api/admin/references/:id", manager, async (request) =>
    research.updateReference(
      sessionOf(request).scope,
      id(request.params),
      ClientReferencePatch.parse(request.body),
      request.ip,
    ),
  );
}
