import { z } from "zod";
import { BriefSectionKeySchema } from "./ai";
import { Package } from "./pricing";
import { PROPERTY_TYPES } from "./properties";

/* Research sources, the research brief and client references (docs/API.md "Research", ARCHITECTURE.md §7). */

const timestamp = z.iso.datetime({ offset: true });

export const SourceKind = z.enum(["website", "search", "upload", "rep_note", "provider"]);

export const ResearchSource = z.object({
  id: z.uuid(),
  kind: SourceKind,
  url: z.string().nullable(),
  title: z.string().nullable(),
  contentText: z.string(),
  fetchedAt: timestamp,
  addedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
});
export type ResearchSource = z.infer<typeof ResearchSource>;
export const JobState = z.object({ pending: z.boolean(), lastError: z.string().nullable() });
export const SourceList = z.object({ items: z.array(ResearchSource), fetch: JobState });
export type SourceListResponse = z.infer<typeof SourceList>;

export const AddSourceRequest = z
  .object({ text: z.string().trim().min(3).max(20_000), title: z.string().trim().max(200).optional() })
  .strict();

export const BriefSection = z.object({
  key: BriefSectionKeySchema,
  heading: z.string(),
  text: z.string(),
  sourceIds: z.array(z.string()),
});
export type BriefSection = z.infer<typeof BriefSection>;

export const ResearchBrief = z.object({
  id: z.uuid(),
  version: z.number().int(),
  sections: z.array(BriefSection),
  recommendedPackage: Package,
  createdAt: timestamp,
  createdBy: z.object({ id: z.uuid(), name: z.string() }),
});
export type ResearchBrief = z.infer<typeof ResearchBrief>;

export const BriefResponse = z.object({
  brief: ResearchBrief.nullable(),
  versions: z.array(z.object({ version: z.number().int(), createdAt: timestamp })),
  /** True while a brief is being generated for this account. */
  pending: z.boolean(),
  lastError: z.string().nullable(),
});
export type BriefResponse = z.infer<typeof BriefResponse>;

export const JobAccepted = z.object({ status: z.literal("queued") });

// ───────── client references ─────────
export const ClientReference = z.object({
  id: z.uuid(),
  labelNamed: z.string(),
  labelAnonymized: z.string(),
  propertyTypes: z.array(z.string()),
  stats: z.record(z.string(), z.number()),
  namedPermission: z.boolean(),
  active: z.boolean(),
  updatedAt: timestamp,
});
export type ClientReference = z.infer<typeof ClientReference>;
export const ClientReferenceList = z.object({ items: z.array(ClientReference) });

const referenceFields = {
  labelNamed: z.string().trim().min(2).max(200),
  labelAnonymized: z.string().trim().min(5).max(200),
  propertyTypes: z.array(z.enum(PROPERTY_TYPES)).min(1).max(10),
  stats: z.record(z.string().regex(/^[a-zA-Z]\w{0,40}$/), z.number()),
  namedPermission: z.boolean(),
  active: z.boolean(),
};

export const ClientReferenceInput = z
  .object({
    ...referenceFields,
    stats: referenceFields.stats.default({}),
    namedPermission: referenceFields.namedPermission.default(false),
    active: referenceFields.active.default(true),
  })
  .strict();
export type ClientReferenceInput = z.infer<typeof ClientReferenceInput>;
/** No defaults: a field left out stays as it is. */
export const ClientReferencePatch = z.object(referenceFields).partial().strict();
export type ClientReferencePatch = z.infer<typeof ClientReferencePatch>;
