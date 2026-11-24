import { CreateUserRequest, IdParam, UpdateMeRequest, UpdateUserRequest, type AdminUserList } from "@soa/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionOf } from "../auth/plugin";
import type { AuditService } from "../services/audit";
import type { AuthService } from "../services/auth";
import type { UsersService } from "../services/users";

const AuditQuery = z.object({
  entity: z.string().max(40).optional(),
  user: z.uuid().optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function registerUserRoutes(
  app: FastifyInstance,
  deps: { users: UsersService; audit: AuditService; auth: AuthService },
): void {
  const { users, audit, auth } = deps;

  app.get("/api/me", async (request) => {
    const session = sessionOf(request);
    return users.me(session.scope, auth.csrfFor(session.idHash));
  });

  app.patch("/api/me", async (request) => {
    const session = sessionOf(request);
    return { user: await users.updateProfile(session.scope, UpdateMeRequest.parse(request.body), request.ip) };
  });

  app.get("/api/admin/users", { config: { access: "admin" } }, async (request): Promise<AdminUserList> => {
    return { items: await users.list(sessionOf(request).scope) };
  });

  app.post("/api/admin/users", { config: { access: "admin" } }, async (request, reply) => {
    const created = await users.create(sessionOf(request).scope, CreateUserRequest.parse(request.body), request.ip);
    return reply.code(201).send(created);
  });

  app.patch("/api/admin/users/:id", { config: { access: "admin" } }, async (request) => {
    const { id } = IdParam.parse(request.params);
    return users.update(sessionOf(request).scope, id, UpdateUserRequest.parse(request.body), request.ip);
  });

  app.get("/api/admin/audit", { config: { access: "admin" } }, async (request) => {
    return audit.list(sessionOf(request).scope, AuditQuery.parse(request.query));
  });
}
