import { formatCentsExact as formatMoney } from "@soa/shared";
import PDFDocument from "pdfkit";

/* PDF documents (ARCHITECTURE.md §10). Rendered in code with pdfkit, so the worker needs no browser. The layout is
   the proposal template's sections: cover note, scope of service, price table, start plan, terms summary and the
   rep's contact details. The service agreement is a placeholder marked DRAFT until the company supplies its own
   (DECISIONS.md item C). */

export interface ProposalPdfData {
  companyName: string;
  companyAddress: string | null;
  accountName: string;
  accountAddress: string | null;
  contactName: string | null;
  version: number;
  date: string;
  coverNote: string | null;
  lines: string[];
  monthlyCents: number;
  annualCents: number;
  termMonths: number;
  termDiscount: number;
  manualDiscount: number;
  validUntil: string | null;
  rep: { name: string; title: string; email: string; phone: string | null };
}

export interface AgreementPdfData {
  companyName: string;
  companyAddress: string | null;
  companySigner: string | null;
  accountName: string;
  accountAddress: string | null;
  signerName: string;
  signerEmail: string;
  lines: string[];
  monthlyCents: number;
  annualCents: number;
  termMonths: number;
  startDate: string;
}

/** pdfkit's standard fonts use WinAnsi: replace anything outside it so the text stays readable and extractable. */
const ALLOWED_EXTRA = new Set([0x2013, 0x2014, 0x2022]); // en dash, em dash, bullet
const safe = (text: string) =>
  Array.from(
    text
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/\u2026/g, "..."),
    (char) => {
      const code = char.codePointAt(0) ?? 0;
      const ok =
        code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff);
      return ok || ALLOWED_EXTRA.has(code) ? char : "?";
    },
  ).join("");

function render(build: (doc: PDFKit.PDFDocument) => void, title: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margin: 56,
      info: { Title: safe(title), Producer: "SOA Sales CRM" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on("error", reject);
    build(doc);
    doc.end();
  });
}

const heading = (doc: PDFKit.PDFDocument, text: string) => {
  doc.moveDown(1).font("Helvetica-Bold").fontSize(13).fillColor("#111111").text(safe(text)).moveDown(0.3);
  doc.font("Helvetica").fontSize(10.5).fillColor("#222222");
};

export function renderProposalPdf(data: ProposalPdfData): Promise<Buffer> {
  return render((doc) => {
    doc.font("Helvetica-Bold").fontSize(20).fillColor("#065f46").text(safe(data.companyName));
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#555555")
      .text(safe(data.companyAddress ?? ""));
    doc.moveDown(1.5).font("Helvetica-Bold").fontSize(16).fillColor("#111111");
    doc.text(safe(`Security services proposal for ${data.accountName}`));
    doc.font("Helvetica").fontSize(10).fillColor("#555555");
    doc.text(
      safe(
        `Version ${String(data.version)} - ${data.date}${data.accountAddress === null ? "" : ` - ${data.accountAddress}`}`,
      ),
    );
    if (data.contactName !== null) doc.text(safe(`Prepared for ${data.contactName}`));

    heading(doc, "Cover note");
    doc.text(
      safe(
        data.coverNote ??
          `Thank you for the time you have given us. This proposal sets out the security coverage we recommend for ${data.accountName}, what it costs, and how we would start.`,
      ),
    );

    heading(doc, "Scope of service");
    for (const line of data.lines) doc.text(safe(`•  ${line}`), { indent: 8 });

    heading(doc, "Price");
    const row = (label: string, value: string, bold = false) => {
      const y = doc.y;
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").text(safe(label), 56, y, { width: 300 });
      doc.text(safe(value), 356, y, { width: 200, align: "right" });
    };
    row("Monthly price", formatMoney(data.monthlyCents), true);
    row("Annual price", formatMoney(data.annualCents), true);
    row("Term", `${String(data.termMonths)} months`);
    if (data.termDiscount > 0) row("Term discount included", `${String(Math.round(data.termDiscount * 1000) / 10)}%`);
    if (data.manualDiscount > 0)
      row("Additional discount included", `${String(Math.round(data.manualDiscount * 1000) / 10)}%`);
    doc.font("Helvetica").moveDown(0.5);
    doc.x = 56;

    heading(doc, "Start plan");
    for (const step of [
      "Week 1: site walk with your team, post orders agreed, officers selected and briefed.",
      "Week 2: officers on site; daily reports and the client portal live.",
      "Day 30: review with your property manager; adjust posts and patrol routes as needed.",
    ]) {
      doc.text(safe(`•  ${step}`), { indent: 8 });
    }

    heading(doc, "Terms summary");
    doc.text(
      safe(
        `Prices are in US dollars, billed monthly, for a ${String(data.termMonths)}-month term. ${data.validUntil === null ? "" : `This proposal is valid until ${data.validUntil}. `}The full terms are in the service agreement sent for signature.`,
      ),
    );

    heading(doc, "Your contact");
    doc.text(safe(data.rep.name));
    doc.text(safe(`${data.rep.title}, ${data.companyName}`));
    doc.text(safe(data.rep.email));
    if (data.rep.phone !== null) doc.text(safe(data.rep.phone));
  }, `Proposal for ${data.accountName}`);
}

export function renderAgreementPdf(data: AgreementPdfData): Promise<Buffer> {
  return render((doc) => {
    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor("#b91c1c")
      .text("DRAFT - placeholder agreement. Replace with the company's service agreement before use.");
    doc.moveDown(1).font("Helvetica-Bold").fontSize(18).fillColor("#111111").text("Security Services Agreement");
    doc.font("Helvetica").fontSize(10.5).fillColor("#222222").moveDown(0.5);
    doc.text(
      safe(`Between ${data.companyName}${data.companyAddress === null ? "" : `, ${data.companyAddress}`} ("Provider")`),
    );
    doc.text(
      safe(`and ${data.accountName}${data.accountAddress === null ? "" : `, ${data.accountAddress}`} ("Client").`),
    );
    heading(doc, "Services");
    for (const line of data.lines) doc.text(safe(`•  ${line}`), { indent: 8 });
    heading(doc, "Price and term");
    doc.text(safe(`Monthly price: ${formatMoney(data.monthlyCents)}. Annual price: ${formatMoney(data.annualCents)}.`));
    doc.text(safe(`Term: ${String(data.termMonths)} months starting ${data.startDate}.`));
    heading(doc, "Signatures");
    doc.text(safe(`Client: ${data.signerName} (${data.signerEmail})`));
    doc.moveDown(2).text("Signature: ______________________________   Date: ____________");
    doc.moveDown(1.5).text(safe(`Provider: ${data.companySigner ?? data.companyName}`));
    doc.moveDown(2).text("Signature: ______________________________   Date: ____________");
  }, `Agreement for ${data.accountName}`);
}
