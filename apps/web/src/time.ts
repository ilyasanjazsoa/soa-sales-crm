/* Dates and times shown in the rep's own time zone (their profile), so the screen matches the slot reasons and the
   calendar, whatever the browser's zone is. */

export const dayLabel = (iso: string, timeZone: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone });

export const timeLabel = (iso: string, timeZone: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone });

/** YYYY-MM-DD of an instant in the zone. */
export const dayKey = (date: Date | string, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(date),
  );
