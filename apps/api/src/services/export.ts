import type { Database } from "@soa/db";
import { STAGE_LABELS } from "@soa/shared";
import { accountsRepo } from "../repos/accounts";
import { auditRepo } from "../repos/audit";
import { dealsRepo } from "../repos/deals";
import type { UserScope } from "../repos/scope";

/* CSV export (managers, audited). Cells that a spreadsheet would treat as a formula are prefixed with a quote. */

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const csv = (rows: (string | number | null | undefined)[][]) =>
  `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;

export function createExportService({ db }: { db: Database }) {
  return {
    async accounts(scope: UserScope, ip: string | null): Promise<string> {
      const rows = await accountsRepo(db).listForExport(scope);
      await auditRepo(db).write(scope, { action: "export.accounts", meta: { rows: rows.length }, ip });
      return csv([
        [
          "Account",
          "Property type",
          "Address",
          "City",
          "State",
          "Postal code",
          "Owner company",
          "Current provider",
          "Contract end",
          "Fit score",
          "Owner",
        ],
        ...rows.map(({ account, ownerName }) => [
          account.name,
          account.propertyType,
          account.addressLine,
          account.city,
          account.state,
          account.postalCode,
          account.ownerCompany,
          account.currentProvider,
          account.contractEndDate,
          account.fitScore,
          ownerName ?? "Unassigned",
        ]),
      ]);
    },

    async deals(scope: UserScope, ip: string | null): Promise<string> {
      const rows = await dealsRepo(db).listForExport(scope);
      await auditRepo(db).write(scope, { action: "export.deals", meta: { rows: rows.length }, ip });
      return csv([
        ["Deal", "Account", "Owner", "Stage", "Status", "Annual value (USD)", "Expected close", "Lost reason"],
        ...rows.map(({ deal, accountName, ownerName }) => [
          deal.name,
          accountName,
          ownerName,
          STAGE_LABELS[deal.stage],
          deal.status,
          `${String(Math.trunc(deal.annualValueCents / 100))}.${String(deal.annualValueCents % 100).padStart(2, "0")}`,
          deal.expectedClose,
          deal.lostReason,
        ]),
      ]);
    },
  };
}

export type ExportService = ReturnType<typeof createExportService>;
