import { describe, expect, it } from "vitest";
import {
  nextBestActions,
  quarterWindow,
  scheduleWindow,
  weekWindow,
  type NbaDeal,
  type NbaMeeting,
  type NbaTask,
} from "./nba";
import { zonedTime } from "./slots";

const TZ = "America/Chicago";
/** Tuesday 10 March 2026, 10:00 am in Chicago. */
const NOW = zonedTime(2026, 3, 10, 10, 0, TZ);
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

const deal = (overrides: Partial<NbaDeal> = {}): NbaDeal => ({
  id: "d1",
  accountId: "a1",
  accountName: "Harbor Freight Yards",
  stage: "contacted",
  status: "open",
  annualValueCents: 100_000_00,
  lastActivityAt: daysAgo(0),
  contactName: "Dana Whitfield",
  outboundCount: 0,
  lastOutboundAt: null,
  loggedTouches: 0,
  lastLoggedTouchAt: null,
  lastInboundAt: null,
  lastInterestedAt: null,
  interestedContact: null,
  proposal: null,
  contract: null,
  topSignal: null,
  ...overrides,
});
const meeting = (overrides: Partial<NbaMeeting> = {}): NbaMeeting => ({
  id: "m1",
  title: "Site walk: Harbor Freight Yards",
  startsAt: zonedTime(2026, 3, 10, 14, 0, TZ),
  kind: "site_walk",
  accountId: "a1",
  status: "scheduled",
  ...overrides,
});
const task = (overrides: Partial<NbaTask> = {}): NbaTask => ({
  id: "t1",
  title: "Send the insurance certificate",
  dueAt: zonedTime(2026, 3, 10, 17, 0, TZ),
  doneAt: null,
  accountId: "a1",
  ...overrides,
});

const run = (input: { meetings?: NbaMeeting[]; deals?: NbaDeal[]; tasks?: NbaTask[]; now?: Date }) =>
  nextBestActions({
    now: input.now ?? NOW,
    timeZone: TZ,
    meetings: input.meetings ?? [],
    deals: input.deals ?? [],
    tasks: input.tasks ?? [],
  });
const rules = (input: Parameters<typeof run>[0]) => run(input).map((action) => action.rule);

describe("rule 0: a customer meeting today or on the next business day", () => {
  it("triggers later today and tomorrow, with the right words", () => {
    const [today] = run({ meetings: [meeting()] });
    expect(today?.text).toBe("Site walk: Harbor Freight Yards today at 2:00 pm. Your prep brief is ready.");
    expect(today?.button).toEqual({ label: "Open prep brief", href: "/accounts/a1?tab=meetings" });
    const [tomorrow] = run({ meetings: [meeting({ startsAt: zonedTime(2026, 3, 11, 9, 0, TZ) })] });
    expect(tomorrow?.text).toContain("tomorrow at 9:00 am");
    // Friday afternoon: the next business day is Monday.
    const friday = zonedTime(2026, 3, 13, 16, 0, TZ);
    const [monday] = run({ now: friday, meetings: [meeting({ startsAt: zonedTime(2026, 3, 16, 9, 0, TZ) })] });
    expect(monday?.text).toContain("Monday at 9:00 am");
  });

  it("doesn't trigger for an earlier meeting today, one later in the week, an internal one or a cancelled one", () => {
    expect(rules({ meetings: [meeting({ startsAt: zonedTime(2026, 3, 10, 8, 0, TZ) })] })).toEqual([]);
    expect(rules({ meetings: [meeting({ startsAt: zonedTime(2026, 3, 12, 9, 0, TZ) })] })).toEqual([]);
    expect(rules({ meetings: [meeting({ kind: "internal" })] })).toEqual([]);
    expect(rules({ meetings: [meeting({ status: "cancelled" })] })).toEqual([]);
  });
});

describe("rule 1: interested reply with no outbound since", () => {
  it("triggers", () => {
    expect(
      rules({
        deals: [
          deal({ lastInterestedAt: daysAgo(1), lastOutboundAt: daysAgo(3), interestedContact: "Dana Whitfield" }),
        ],
      }),
    ).toEqual(["interested_reply"]);
    expect(run({ deals: [deal({ lastInterestedAt: daysAgo(1), interestedContact: "Dana Whitfield" })] })[0]?.text).toBe(
      "Dana Whitfield replied and sounds interested.",
    );
  });
  it("doesn't trigger once the rep has emailed since", () => {
    expect(
      rules({ deals: [deal({ lastInterestedAt: daysAgo(2), lastOutboundAt: daysAgo(1), outboundCount: 1 })] }),
    ).toEqual([]);
  });
});

describe("rule 1: contract viewed but not signed", () => {
  const contract = (viewCount: number, sentDaysAgo: number) =>
    deal({
      stage: "contract_sent",
      contract: { sentAt: daysAgo(sentDaysAgo), viewCount, signerName: "Dana Whitfield" },
    });
  it("triggers when viewed and sent 2+ days ago", () => {
    const [action] = run({ deals: [contract(3, 2)] });
    expect(action?.text).toBe("Dana Whitfield viewed the contract 3 times but hasn't signed.");
  });
  it("doesn't trigger when unviewed or sent too recently", () => {
    expect(rules({ deals: [contract(0, 5)] })).toEqual([]);
    expect(rules({ deals: [contract(2, 1)] })).toEqual([]);
  });
});

describe("rule 2: proposal opened twice, quiet for 2 days", () => {
  it("triggers", () => {
    const opened = deal({
      stage: "proposal",
      lastActivityAt: daysAgo(2),
      proposal: { sentAt: daysAgo(3), viewCount: 2 },
    });
    expect(rules({ deals: [opened] })).toEqual(["proposal_opened"]);
    expect(run({ deals: [opened] })[0]?.text).toBe("Dana Whitfield has opened the proposal 2 times.");
  });
  it("doesn't trigger with one view or recent activity", () => {
    expect(
      rules({
        deals: [
          deal({ stage: "proposal", lastActivityAt: daysAgo(3), proposal: { sentAt: daysAgo(3), viewCount: 1 } }),
        ],
      }),
    ).toEqual([]);
    expect(
      rules({
        deals: [
          deal({ stage: "proposal", lastActivityAt: daysAgo(1), proposal: { sentAt: daysAgo(3), viewCount: 4 } }),
        ],
      }),
    ).toEqual([]);
  });
});

describe("rule 2: proposal with no reply for 5 days", () => {
  it("triggers", () => {
    const [action] = run({ deals: [deal({ stage: "proposal", proposal: { sentAt: daysAgo(6), viewCount: 0 } })] });
    expect(action?.text).toBe("Proposal sent 6 days ago with no reply.");
  });
  it("doesn't trigger before 5 days or after a reply", () => {
    expect(rules({ deals: [deal({ stage: "proposal", proposal: { sentAt: daysAgo(4), viewCount: 0 } })] })).toEqual([]);
    expect(
      rules({
        deals: [deal({ stage: "proposal", lastInboundAt: daysAgo(2), proposal: { sentAt: daysAgo(6), viewCount: 0 } })],
      }),
    ).toEqual([]);
  });
});

describe("rule 3: contacted, no reply for 4 days, fewer than 3 touches", () => {
  it("triggers", () => {
    const [action] = run({ deals: [deal({ outboundCount: 1, lastOutboundAt: daysAgo(4) })] });
    expect(action?.text).toBe("No reply from Dana Whitfield in 4 days.");
  });
  it("also counts a logged call as the last touch", () => {
    expect(rules({ deals: [deal({ loggedTouches: 1, lastLoggedTouchAt: daysAgo(5) })] })).toEqual([
      "contacted_no_reply",
    ]);
    // A call after an interested reply answers it.
    expect(
      rules({
        deals: [
          deal({ stage: "meeting_set", lastInterestedAt: daysAgo(2), loggedTouches: 1, lastLoggedTouchAt: daysAgo(1) }),
        ],
      }),
    ).toEqual([]);
  });

  it("doesn't trigger after a reply, too soon, or after 3 touches", () => {
    expect(
      rules({ deals: [deal({ outboundCount: 1, lastOutboundAt: daysAgo(5), lastInboundAt: daysAgo(1) })] }),
    ).toEqual([]);
    expect(rules({ deals: [deal({ outboundCount: 1, lastOutboundAt: daysAgo(3) })] })).toEqual([]);
    expect(rules({ deals: [deal({ outboundCount: 2, loggedTouches: 1, lastOutboundAt: daysAgo(6) })] })).toEqual([]);
  });
});

describe("rule 3: researched, no outreach", () => {
  it("triggers, leading with the top signal", () => {
    const [action] = run({ deals: [deal({ stage: "researched", topSignal: "Two trailer thefts in March." })] });
    expect(action?.text).toBe(
      "Harbor Freight Yards is researched but not contacted. Lead with: Two trailer thefts in March.",
    );
  });
  it("doesn't trigger once there is any outreach", () => {
    expect(rules({ deals: [deal({ stage: "researched", loggedTouches: 1 })] })).toEqual([]);
  });
});

describe("rule 4: lead needs research", () => {
  it("triggers for a lead", () => {
    expect(rules({ deals: [deal({ stage: "lead" })] })).toEqual(["lead_needs_research"]);
  });
  it("doesn't trigger for a closed deal", () => {
    expect(rules({ deals: [deal({ stage: "lead", status: "lost" })] })).toEqual([]);
  });
});

describe("rule 4: task due today or overdue", () => {
  it("triggers for today and overdue", () => {
    expect(rules({ tasks: [task(), task({ id: "t2", dueAt: daysAgo(3) })] })).toEqual(["task_due", "task_due"]);
    expect(rules({ tasks: [task({ dueAt: zonedTime(2026, 3, 10, 23, 59, TZ) })] })).toEqual(["task_due"]);
  });
  it("doesn't trigger for a later, undated or done task", () => {
    expect(rules({ tasks: [task({ dueAt: zonedTime(2026, 3, 11, 9, 0, TZ) })] })).toEqual([]);
    expect(rules({ tasks: [task({ dueAt: null })] })).toEqual([]);
    expect(rules({ tasks: [task({ doneAt: daysAgo(0) })] })).toEqual([]);
  });
});

describe("ordering", () => {
  it("sorts by priority, then deal value", () => {
    const actions = run({
      meetings: [meeting({ accountId: "a2" })],
      deals: [
        // Keys chosen so the alphabetical tiebreak would put them the other way round: value decides.
        deal({ id: "a-small", accountId: "a3", stage: "lead", annualValueCents: 1_000 }),
        deal({ id: "z-big", accountId: "a4", stage: "lead", annualValueCents: 9_000 }),
        deal({ id: "reply", accountId: "a5", lastInterestedAt: daysAgo(1), annualValueCents: 10 }),
      ],
    });
    expect(actions.map((action) => [action.priority, action.key])).toEqual([
      [0, "meeting:m1"],
      [1, "interested_reply:reply"],
      [4, "lead_needs_research:z-big"],
      [4, "lead_needs_research:a-small"],
    ]);
  });
});

describe("schedule and windows", () => {
  it("shows today on weekdays and next week from Friday 3 pm through Sunday", () => {
    expect(scheduleWindow(NOW, TZ)).toMatchObject({ label: "today", from: zonedTime(2026, 3, 10, 0, 0, TZ) });
    expect(scheduleWindow(zonedTime(2026, 3, 13, 14, 59, TZ), TZ).label).toBe("today");
    for (const opened of [
      zonedTime(2026, 3, 13, 15, 0, TZ),
      zonedTime(2026, 3, 14, 11, 0, TZ),
      zonedTime(2026, 3, 15, 20, 0, TZ),
    ]) {
      expect(scheduleWindow(opened, TZ)).toEqual({
        label: "next_week",
        from: zonedTime(2026, 3, 16, 0, 0, TZ),
        to: zonedTime(2026, 3, 21, 0, 0, TZ),
      });
    }
  });

  it("computes this week and this quarter in the rep's zone", () => {
    expect(weekWindow(NOW, TZ)).toEqual({
      from: zonedTime(2026, 3, 9, 0, 0, TZ),
      to: zonedTime(2026, 3, 16, 0, 0, TZ),
    });
    expect(quarterWindow(NOW, TZ)).toEqual({
      from: zonedTime(2026, 1, 1, 0, 0, TZ),
      to: zonedTime(2026, 4, 1, 0, 0, TZ),
    });
  });
});
