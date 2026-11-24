import {
  AdminUser,
  AdminUserList,
  Role,
  ROLE_LABELS,
  type CreateUserRequest,
  type UpdateUserRequest,
} from "@soa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus, Users } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { useMe } from "../session";
import { Btn, Empty, ErrorState, Field, inputClass, Loading, Panel, Pill } from "../ui";

const USERS_KEY = ["admin", "users"] as const;

function AddUser() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ email: "", name: "", title: "Account Executive", role: "ae" as Role });
  const create = useMutation({
    mutationFn: (body: CreateUserRequest) => api("/api/admin/users", AdminUser, { method: "POST", body }),
    onSuccess: async () => {
      setForm({ email: "", name: "", title: "Account Executive", role: "ae" });
      await queryClient.invalidateQueries({ queryKey: USERS_KEY });
    },
  });
  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    create.mutate(form);
  };
  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-5 sm:items-end">
      <Field label="Work email">
        <input
          type="email"
          required
          className={inputClass}
          value={form.email}
          onChange={(event) => {
            setForm({ ...form, email: event.target.value });
          }}
        />
      </Field>
      <Field label="Name">
        <input
          required
          className={inputClass}
          value={form.name}
          onChange={(event) => {
            setForm({ ...form, name: event.target.value });
          }}
        />
      </Field>
      <Field label="Title">
        <input
          required
          className={inputClass}
          value={form.title}
          onChange={(event) => {
            setForm({ ...form, title: event.target.value });
          }}
        />
      </Field>
      <Field label="Role">
        <select
          className={inputClass}
          value={form.role}
          onChange={(event) => {
            setForm({ ...form, role: Role.parse(event.target.value) });
          }}
        >
          {Role.options.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </select>
      </Field>
      <Btn type="submit" kind="primary" icon={UserPlus} busy={create.isPending}>
        Add user
      </Btn>
      {create.isError && (
        <div className="sm:col-span-5">
          <ErrorState error={create.error} />
        </div>
      )}
    </form>
  );
}

function UserRow({ user, isSelf }: { user: AdminUser; isSelf: boolean }) {
  const queryClient = useQueryClient();
  const [cap, setCap] = useState(String(user.dailySendCap));
  const update = useMutation({
    mutationFn: (body: UpdateUserRequest) => api(`/api/admin/users/${user.id}`, AdminUser, { method: "PATCH", body }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: USERS_KEY }),
  });
  return (
    <tr className="border-t border-zinc-800 align-top">
      <td className="px-4 py-2">
        <span className="block text-zinc-100">{user.name}</span>
        <span className="block text-xs text-zinc-500">{user.email}</span>
        {update.isError && <span className="mt-1 block text-xs text-red-400">{update.error.message}</span>}
      </td>
      <td className="px-2 py-2">
        <select
          aria-label={`Role for ${user.name}`}
          disabled={isSelf || update.isPending}
          className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
          value={user.role}
          onChange={(event) => {
            update.mutate({ role: Role.parse(event.target.value) });
          }}
        >
          {Role.options.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </select>
      </td>
      <td className="px-2 py-2">
        <input
          aria-label={`Daily email cap for ${user.name}`}
          type="number"
          min={0}
          max={500}
          className="w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
          value={cap}
          onChange={(event) => {
            setCap(event.target.value);
          }}
          onBlur={() => {
            const value = Number(cap);
            if (Number.isInteger(value) && value !== user.dailySendCap) update.mutate({ dailySendCap: value });
          }}
        />
      </td>
      <td className="px-2 py-2 text-xs text-zinc-400">{user.ownedAccounts}</td>
      <td className="px-4 py-2">
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          <input
            type="checkbox"
            disabled={isSelf || update.isPending}
            checked={user.active}
            onChange={(event) => {
              update.mutate({ active: event.target.checked });
            }}
          />
          {user.active ? <Pill tone="green">Active</Pill> : <Pill tone="zinc">Inactive</Pill>}
        </label>
      </td>
    </tr>
  );
}

export function AdminUsersPage() {
  const me = useMe();
  const users = useQuery({ queryKey: USERS_KEY, queryFn: () => api("/api/admin/users", AdminUserList) });
  if (me.data?.user.role !== "admin") {
    return <ErrorState error={new Error("User management is for admins.")} />;
  }
  const selfId = me.data.user.id;
  return (
    <div className="space-y-4">
      <Panel title="Add a user" icon={UserPlus}>
        <p className="mb-3 text-xs text-zinc-500">
          People must be added here before they can sign in. Deactivating someone requires reassigning their accounts
          first.
        </p>
        <AddUser />
      </Panel>
      <Panel title="Users" icon={Users} pad={false}>
        {users.isPending ? (
          <div className="px-4">
            <Loading />
          </div>
        ) : users.isError ? (
          <div className="p-4">
            <ErrorState error={users.error} onRetry={() => void users.refetch()} />
          </div>
        ) : users.data.items.length === 0 ? (
          <div className="p-4">
            <Empty>No users yet. Add the first account executive above.</Empty>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs text-zinc-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-2 py-2 font-medium">Role</th>
                  <th className="px-2 py-2 font-medium">Daily email cap</th>
                  <th className="px-2 py-2 font-medium">Accounts</th>
                  <th className="px-4 py-2 font-medium">Active</th>
                </tr>
              </thead>
              <tbody>
                {users.data.items.map((user) => (
                  <UserRow key={user.id} user={user} isSelf={user.id === selfId} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
