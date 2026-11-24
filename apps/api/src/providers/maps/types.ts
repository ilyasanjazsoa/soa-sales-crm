import type { LatLng } from "@soa/shared";

/* Geocoding and drive time (ARCHITECTURE.md §9.1, DECISIONS.md item D: Google Maps Platform) and a fake. */
export interface MapsProvider {
  /** Null when the address can't be found. */
  geocode: (address: string) => Promise<LatLng | null>;
  driveMinutes: (from: LatLng, to: LatLng, departAt: Date) => Promise<number>;
}
