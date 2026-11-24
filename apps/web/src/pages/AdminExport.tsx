import { Download } from "lucide-react";
import { Panel } from "../ui";

/* Admin → Export (§15, audited): accounts and deals as CSV, for the accounts the manager can see. */
export function AdminExportPage() {
  const link =
    "inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:border-zinc-500";
  return (
    <Panel title="Export" icon={Download}>
      <p className="mb-3 text-sm text-zinc-400">
        Download a CSV file. Each export is recorded in the audit log. Keep the files somewhere safe: they contain
        contact details.
      </p>
      <div className="flex flex-wrap gap-3">
        <a className={link} href="/api/export/accounts.csv" download>
          <Download size={14} aria-hidden="true" />
          Accounts and contacts
        </a>
        <a className={link} href="/api/export/deals.csv" download>
          <Download size={14} aria-hidden="true" />
          Deals
        </a>
      </div>
    </Panel>
  );
}
