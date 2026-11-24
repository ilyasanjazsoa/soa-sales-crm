import type { Database } from "@soa/db";
import type { Task } from "@soa/shared";
import type { Clock } from "../clock";
import { forbidden, notFound } from "../errors";
import { accountsRepo } from "../repos/accounts";
import { activitiesRepo, tasksRepo } from "../repos/children";
import type { UserScope } from "../repos/scope";
import { toTask } from "./mappers";

export function createTasksService({ db, clock }: { db: Database; clock: Clock }) {
  return {
    async list(
      scope: UserScope,
      filter: { open?: boolean | undefined; accountId?: string | undefined },
    ): Promise<Task[]> {
      return (await tasksRepo(db).list(scope, filter)).map(toTask);
    },

    async create(
      scope: UserScope,
      body: { title: string; accountId?: string | undefined; dueAt?: string | null | undefined },
    ): Promise<Task> {
      return db.transaction(async (tx) => {
        let accountName: string | null = null;
        if (body.accountId !== undefined) {
          const accounts = accountsRepo(tx);
          const account = await accounts.getEditable(scope, body.accountId);
          if (account === undefined) {
            if ((await accounts.get(scope, body.accountId)) !== undefined) throw forbidden("Claim this account first.");
            throw notFound();
          }
          accountName = account.name;
        }
        const task = await tasksRepo(tx).insert(scope, {
          ownerUserId: scope.userId,
          accountId: body.accountId ?? null,
          title: body.title,
          dueAt: body.dueAt === undefined || body.dueAt === null ? null : new Date(body.dueAt),
        });
        return toTask({ task, accountName });
      });
    },

    async update(
      scope: UserScope,
      id: string,
      patch: { title?: string; dueAt?: string | null; done?: boolean },
    ): Promise<Task> {
      return db.transaction(async (tx) => {
        const repo = tasksRepo(tx);
        const current = await repo.get(scope, id);
        if (current === undefined) throw notFound();
        const values: Record<string, unknown> = {};
        if (patch.title !== undefined) values.title = patch.title;
        if (patch.dueAt !== undefined) values.dueAt = patch.dueAt === null ? null : new Date(patch.dueAt);
        if (patch.done !== undefined) values.doneAt = patch.done ? clock() : null;
        const updated = await repo.update(scope, id, values);
        if (updated === undefined) throw notFound();
        if (patch.done === true && current.doneAt === null && current.accountId !== null) {
          await activitiesRepo(tx).insert(scope, {
            accountId: current.accountId,
            dealId: current.dealId,
            type: "task_done",
            subject: current.title,
          });
        }
        const [row] = (await repo.list(scope, {})).filter((entry) => entry.task.id === id);
        return toTask(row ?? { task: updated, accountName: null });
      });
    },
  };
}

export type TasksService = ReturnType<typeof createTasksService>;
