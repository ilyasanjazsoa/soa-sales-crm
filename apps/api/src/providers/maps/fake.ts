import { createHash } from "node:crypto";
import { estimatedDriveMinutes } from "@soa/shared";
import type { MapsProvider } from "./types";

/* FAKE_PROVIDERS maps: deterministic coordinates around Dallas from the address text, and straight-line drive times
   plus a little traffic. `fail` makes every call fail, to exercise the estimated fallback. */
export function createFakeMapsProvider(options: { fail?: boolean } = {}): MapsProvider & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    geocode(address) {
      state.calls += 1;
      if (options.fail === true) return Promise.reject(new Error("maps unavailable"));
      const hash = createHash("sha256").update(address.trim().toLowerCase()).digest();
      return Promise.resolve({ lat: 32.6 + ((hash[0] ?? 0) / 255) * 0.5, lng: -97.2 + ((hash[1] ?? 0) / 255) * 0.6 });
    },
    driveMinutes(from, to) {
      state.calls += 1;
      if (options.fail === true) return Promise.reject(new Error("maps unavailable"));
      return Promise.resolve(Math.max(5, estimatedDriveMinutes(from, to) - 3));
    },
  };
}
