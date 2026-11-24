import { estimatedDriveMinutes, type Drive, type LatLng } from "@soa/shared";
import type { Clock } from "../../clock";
import type { MapsProvider } from "./types";

/* Drive times and geocodes cached in memory for 24 hours (§9.1), keyed by rounded coordinates and the departure hour.
   When the maps API fails, drive time falls back to the straight-line estimate and is marked estimated. */

const DAY_MS = 24 * 60 * 60 * 1000;
const round = (value: number) => value.toFixed(3);

export function createDriveTimes(maps: MapsProvider, clock: Clock) {
  const drives = new Map<string, { minutes: number; at: number }>();
  const places = new Map<string, { location: LatLng | null; at: number }>();
  const fresh = (at: number) => clock().getTime() - at < DAY_MS;
  return {
    async drive(from: LatLng, to: LatLng, departAt: Date): Promise<Drive> {
      const hour = Math.floor(departAt.getTime() / 3_600_000);
      const key = `${round(from.lat)},${round(from.lng)}>${round(to.lat)},${round(to.lng)}@${String(hour)}`;
      const cached = drives.get(key);
      if (cached !== undefined && fresh(cached.at)) return { minutes: cached.minutes, estimated: false };
      try {
        const minutes = await maps.driveMinutes(from, to, departAt);
        drives.set(key, { minutes, at: clock().getTime() });
        return { minutes, estimated: false };
      } catch {
        return { minutes: estimatedDriveMinutes(from, to), estimated: true };
      }
    },
    /** Undefined when geocoding failed (try again later); null when the address doesn't exist. */
    async geocode(address: string): Promise<LatLng | null | undefined> {
      const key = address.trim().toLowerCase();
      const cached = places.get(key);
      if (cached !== undefined && fresh(cached.at)) return cached.location;
      try {
        const location = await maps.geocode(address);
        places.set(key, { location, at: clock().getTime() });
        return location;
      } catch {
        return undefined;
      }
    },
  };
}
export type DriveTimes = ReturnType<typeof createDriveTimes>;
