/* The rep's calendar (ARCHITECTURE.md §9). One real adapter (Microsoft Graph, DECISIONS.md decision 10) and a fake.
   Calls carry the user id as well as the token so the fake can keep one calendar per rep. */

export interface CalendarAccount {
  accessToken: string;
  userId: string;
  /** The rep's IANA time zone: all-day events are their local days. */
  timeZone?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  location: string | null;
  cancelled: boolean;
}

export interface NewCalendarEvent {
  title: string;
  start: Date;
  end: Date;
  location: string | null;
  body: string;
  /** Invited by the calendar system (the invite is sent by Microsoft 365, not by the CRM). */
  attendees: { email: string; name: string }[];
}

export interface CalendarProvider {
  listEvents: (account: CalendarAccount, from: Date, to: Date) => Promise<CalendarEvent[]>;
  /** Null when the event no longer exists. */
  getEvent: (account: CalendarAccount, id: string) => Promise<CalendarEvent | null>;
  createEvent: (account: CalendarAccount, event: NewCalendarEvent) => Promise<{ id: string }>;
  updateEvent: (account: CalendarAccount, id: string, times: { start: Date; end: Date }) => Promise<void>;
  cancelEvent: (account: CalendarAccount, id: string, comment: string) => Promise<void>;
}
