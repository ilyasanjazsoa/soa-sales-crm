/** The current time. Injected so time-dependent behaviour (session timeouts, schedules) is testable. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();
