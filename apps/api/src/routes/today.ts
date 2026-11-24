import { AskRequest } from "@soa/shared";
import type { FastifyInstance } from "fastify";
import { sessionOf } from "../auth/plugin";
import type { TodayService } from "../services/today";

const session = { config: { access: "session" } } as const;

export function registerTodayRoutes(app: FastifyInstance, deps: { today: TodayService }): void {
  app.get("/api/today", session, async (request) => deps.today.today(sessionOf(request).scope));
  app.post("/api/ask", session, async (request) =>
    deps.today.ask(sessionOf(request).scope, AskRequest.parse(request.body).question),
  );
}
