import { z } from "zod";
import type { MapsProvider } from "./types";

/* Google Maps Platform: the Geocoding API and the Distance Matrix API (driving, with traffic for the departure time). */

const Geocode = z.object({
  status: z.string(),
  results: z.array(z.object({ geometry: z.object({ location: z.object({ lat: z.number(), lng: z.number() }) }) })),
});
const Matrix = z.object({
  status: z.string(),
  rows: z.array(
    z.object({
      elements: z.array(
        z.object({
          status: z.string(),
          duration: z.object({ value: z.number() }).optional(),
          duration_in_traffic: z.object({ value: z.number() }).optional(),
        }),
      ),
    }),
  ),
});

export function createGoogleMapsProvider(options: { apiKey: string; fetch?: typeof fetch }): MapsProvider {
  const http = options.fetch ?? fetch;
  const get = async (url: URL) => {
    url.searchParams.set("key", options.apiKey);
    const response = await http(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Google Maps error ${String(response.status)}`);
    return await response.json();
  };
  return {
    async geocode(address) {
      const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
      url.searchParams.set("address", address);
      const data = Geocode.parse(await get(url));
      if (data.status === "ZERO_RESULTS") return null;
      if (data.status !== "OK") throw new Error(`Geocoding failed: ${data.status}`);
      const location = data.results[0]?.geometry.location;
      return location === undefined ? null : { lat: location.lat, lng: location.lng };
    },
    async driveMinutes(from, to, departAt) {
      const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
      url.searchParams.set("origins", `${String(from.lat)},${String(from.lng)}`);
      url.searchParams.set("destinations", `${String(to.lat)},${String(to.lng)}`);
      url.searchParams.set("mode", "driving");
      url.searchParams.set(
        "departure_time",
        String(Math.max(Math.floor(departAt.getTime() / 1000), Math.floor(Date.now() / 1000))),
      );
      const data = Matrix.parse(await get(url));
      const element = data.rows[0]?.elements[0];
      const seconds = element?.duration_in_traffic?.value ?? element?.duration?.value;
      if (data.status !== "OK" || element?.status !== "OK" || seconds === undefined) {
        throw new Error(`Distance Matrix failed: ${data.status}/${element?.status ?? "none"}`);
      }
      return Math.round(seconds / 60);
    },
  };
}
