import { BookMeetingRequest, IdParam, MeetingPatch, MeetingQuery, SlotRequest } from "@soa/shared";
import type { FastifyInstance } from "fastify";
import { sessionOf } from "../auth/plugin";
import type { MeetingsService } from "../services/meetings";

const session = { config: { access: "session" } } as const;

export function registerMeetingRoutes(app: FastifyInstance, deps: { meetings: MeetingsService }): void {
  const { meetings } = deps;
  const id = (params: unknown) => IdParam.parse(params).id;

  app.post("/api/accounts/:id/slots", session, async (request) => ({
    slots: await meetings.slots(sessionOf(request).scope, id(request.params), SlotRequest.parse(request.body)),
  }));
  app.post("/api/meetings", session, async (request, reply) =>
    reply
      .code(201)
      .send(await meetings.book(sessionOf(request).scope, BookMeetingRequest.parse(request.body), request.ip)),
  );
  app.get("/api/meetings", session, async (request) =>
    meetings.list(sessionOf(request).scope, MeetingQuery.parse(request.query)),
  );
  app.patch("/api/meetings/:id", session, async (request) =>
    meetings.patch(sessionOf(request).scope, id(request.params), MeetingPatch.parse(request.body), request.ip),
  );
  app.get("/api/meetings/:id/prep", session, async (request) =>
    meetings.prep(sessionOf(request).scope, id(request.params)),
  );
  app.post("/api/meetings/:id/prep", session, async (request, reply) => {
    await meetings.regeneratePrep(sessionOf(request).scope, id(request.params));
    return reply.code(202).send({ status: "queued" });
  });
}
