import type { Package } from "./pricing";

/* Property types and the default package for each (DECISIONS.md item J). The list is the documented default;
   the default packages are the ones in the approved demo. Both are unconfirmed until the company answers J. */

export const PROPERTY_TYPES = [
  "Industrial",
  "Cold chain warehouse",
  "Medical office",
  "Construction site",
  "Class A office",
  "Data center",
  "Multifamily",
  "Hospitality",
  "Retail",
  "Self storage",
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const isPropertyType = (value: string): value is PropertyType =>
  (PROPERTY_TYPES as readonly string[]).includes(value);

export const DEFAULT_PACKAGES: Record<PropertyType, Package> = {
  Industrial: { posts: 2, armed: false, coverage: "24_7", supervisor: false, addons: ["patrol"], termMonths: 36 },
  "Cold chain warehouse": {
    posts: 2,
    armed: false,
    coverage: "24_7",
    supervisor: true,
    addons: ["video"],
    termMonths: 36,
  },
  "Medical office": {
    posts: 1,
    armed: false,
    coverage: "business_hours",
    supervisor: false,
    addons: ["patrol"],
    termMonths: 24,
  },
  "Construction site": {
    posts: 1,
    armed: false,
    coverage: "nights",
    supervisor: false,
    addons: ["video"],
    termMonths: 12,
  },
  "Class A office": { posts: 2, armed: false, coverage: "24_7", supervisor: true, addons: ["portal"], termMonths: 36 },
  "Data center": { posts: 3, armed: true, coverage: "24_7", supervisor: true, addons: ["video"], termMonths: 36 },
  Multifamily: { posts: 1, armed: false, coverage: "nights", supervisor: false, addons: ["patrol"], termMonths: 12 },
  Hospitality: { posts: 2, armed: false, coverage: "nights", supervisor: false, addons: [], termMonths: 24 },
  Retail: { posts: 1, armed: false, coverage: "business_hours", supervisor: false, addons: ["patrol"], termMonths: 12 },
  "Self storage": {
    posts: 0,
    armed: false,
    coverage: "nights",
    supervisor: false,
    addons: ["patrol", "video"],
    termMonths: 12,
  },
};

export const defaultPackageFor = (propertyType: string): Package =>
  isPropertyType(propertyType) ? DEFAULT_PACKAGES[propertyType] : DEFAULT_PACKAGES.Industrial;

/** DECISIONS.md item K default. */
export const LOST_REASONS = [
  "Price",
  "Stayed with incumbent",
  "No budget",
  "No response",
  "Timing",
  "Not a fit",
  "Other",
] as const;
export type LostReason = (typeof LOST_REASONS)[number];
