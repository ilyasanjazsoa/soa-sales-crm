import { z } from "zod";
import { MailAuthError } from "../mail/types";
import type { CalendarEvent, CalendarProvider } from "./types";

/* Microsoft Graph calendar. Times are requested and sent in UTC. Free events don't block time. */

const GRAPH = "https://graph.microsoft.com/v1.0";
const GraphTime = z.object({ dateTime: z.string(), timeZone: z.string().optional() });
const GraphEvent = z.object({
  id: z.string(),
  subject: z.string().nullable().optional(),
  start: GraphTime,
  end: GraphTime,
  location: z.object({ displayName: z.string().nullable().optional() }).nullable().optional(),
  isCancelled: z.boolean().optional(),
  showAs: z.string().optional(),
});
const EventPage = z.object({ value: z.array(GraphEvent), "@odata.nextLink": z.string().optional() });

const utc = (value: string) => new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
const toEvent = (event: z.infer<typeof GraphEvent>): CalendarEvent => ({
  id: event.id,
  title: event.subject ?? "",
  start: utc(event.start.dateTime),
  end: utc(event.end.dateTime),
  location: event.location?.displayName === "" ? null : (event.location?.displayName ?? null),
  cancelled: event.isCancelled === true,
});
const graphTime = (date: Date) => ({ dateTime: date.toISOString().replace("Z", ""), timeZone: "UTC" });

export function createGraphCalendarProvider(options: { fetch?: typeof fetch } = {}): CalendarProvider {
  const http = options.fetch ?? fetch;
  const call = async (accessToken: string, url: string, init: RequestInit = {}) => {
    const response = await http(url.startsWith("https://") ? url : `${GRAPH}${url}`, {
      ...init,
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        prefer: 'outlook.timezone="UTC"',
      },
    });
    if (response.status === 401) throw new MailAuthError();
    return response;
  };
  const ok = (response: Response) => {
    if (!response.ok) throw new Error(`Microsoft Graph calendar error ${String(response.status)}`);
    return response;
  };

  return {
    async listEvents(account, from, to) {
      const select = "id,subject,start,end,location,isCancelled,showAs";
      let url = `/me/calendarView?startDateTime=${encodeURIComponent(from.toISOString())}&endDateTime=${encodeURIComponent(to.toISOString())}&$select=${select}&$top=200`;
      const events: CalendarEvent[] = [];
      for (let page = 0; page < 10; page += 1) {
        const data = EventPage.parse(await ok(await call(account.accessToken, url)).json());
        for (const event of data.value) if (event.showAs !== "free") events.push(toEvent(event));
        if (data["@odata.nextLink"] === undefined) break;
        url = data["@odata.nextLink"];
      }
      return events;
    },

    async getEvent(account, id) {
      const response = await call(account.accessToken, `/me/events/${encodeURIComponent(id)}`);
      if (response.status === 404) return null;
      return toEvent(GraphEvent.parse(await ok(response).json()));
    },

    async createEvent(account, event) {
      const response = await call(account.accessToken, "/me/events", {
        method: "POST",
        body: JSON.stringify({
          subject: event.title,
          body: { contentType: "Text", content: event.body },
          start: graphTime(event.start),
          end: graphTime(event.end),
          ...(event.location === null ? {} : { location: { displayName: event.location } }),
          attendees: event.attendees.map((attendee) => ({
            emailAddress: { address: attendee.email, name: attendee.name },
            type: "required",
          })),
        }),
      });
      return { id: z.object({ id: z.string() }).parse(await ok(response).json()).id };
    },

    async updateEvent(account, id, times) {
      ok(
        await call(account.accessToken, `/me/events/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ start: graphTime(times.start), end: graphTime(times.end) }),
        }),
      );
    },

    async cancelEvent(account, id, comment) {
      const response = await call(account.accessToken, `/me/events/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        body: JSON.stringify({ comment }),
      });
      if (response.status !== 404) ok(response);
    },
  };
}
