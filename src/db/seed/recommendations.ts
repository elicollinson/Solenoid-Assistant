// Standing suggestions the agent has formed from watching the work.
//
// Transcribed from the Claude Design project (ui_kits/agent/data.js —
// RECOMMENDATIONS, RECOMMENDATION_DETAIL and RECOMMENDATION_EVIDENCE). Its own
// fixtures: nothing here is borrowed from activity, reminders or workflows, and
// the design says so itself.
//
// Five places deliberately differ from the design's fixtures:
//
//   * every date is an offset from the day the seed runs, not the design's
//     Aug 24. The seed anchors itself to today so the list reads as this
//     morning; the distances between the dates are the design's.
//
//   * the shelf, the mark, the "when" and half of the "basis" are derived
//     rather than stored. "adopted Aug 11 · 6 runs since" is a status and a
//     decision date in front of a count, and the first two are already columns.
//
//   * a settled suggestion keeps its affirm and quiet words in the fixture but
//     is seeded no actions. The design leaves them on the object and hides them
//     in the view; a button that cannot be pressed is better not sent.
//
//   * the design labels the two turns of the Ferrier Row thread "My draft" and
//     "Your send". Here they are a message from me and a message from you, and
//     the viewer names them from that — the same information, said once.
//
//   * two "what changes" lines are dropped — "In force since | Aug 11" and
//     "Declined | Aug 03". Both restate the decision date, which the pair
//     above them already carries, and here it would carry it twice in two
//     different formats. For the same reason the adopted one's account says
//     "You took this after a run" rather than naming a date that moves.
//
// The standup suggestion the Activity aside draws is NOT here. It lives in
// ./fixtures.ts as RECOMMENDATION, because the design authored it for that card
// rather than for this list. It is seeded as a recommendation like any other,
// so it appears here too — see the note in ./design.ts.
import type { EvidenceFixture, When } from "./reminders";

export interface RecommendationFixture {
  key: string;
  title: string;
  /** proposed → Waiting on you, adopted → Standing, declined → Set aside. */
  status: "proposed" | "adopted" | "declined";
  confidence: "strong" | "worth_a_look" | "weak";
  formed: When;
  /** When you answered it. Absent while it is still waiting on you. */
  decided?: When;
  /** The row's one line. */
  blurb: string;
  /** What it rests on, in the agent's own count. Once answered, only the part
   *  the status and the decision date do not already say. */
  basisLabel?: string;
  basisCount?: number;
  basisRunCount?: number;
  /** The rule it would become. */
  scopeUri: string;
  /** "Vendor reconciliation", "One contact" — what it reaches. */
  scopeLabel: string;
  affirm?: string;
  quiet?: string;
  /** "What I noticed". */
  prose: readonly string[];
  /** Where it stopped short of acting. */
  restraint: string;
  /** "What changes if you say yes". */
  effect: readonly (readonly [string, string])[];
  /** The "From" pair. The agent's own count, in the agent's own unit: five
   *  drafts is not five runs, and rounding it to runs would change what it
   *  said. */
  from: string;
  evidence?: readonly EvidenceFixture[];
}

export const RECOMMENDATIONS: readonly RecommendationFixture[] = [
  {
    key: "spend-floor",
    title: "Let me settle vendor differences under £50 myself",
    status: "proposed",
    confidence: "strong",
    formed: { dayOffset: 0, hour: 6, minute: 40 },
    blurb:
      "I asked you about fourteen of these last quarter and you approved every one. I stopped short of a rule because you never gave me one.",
    basisLabel: "14 approvals · 0 rejections",
    basisCount: 14,
    basisRunCount: 6,
    scopeUri: "okf:policy/spend-floor",
    scopeLabel: "Vendor reconciliation",
    affirm: "Set the floor at £50",
    quiet: "Keep asking me",
    prose: [
      "Every reconciliation run this quarter turned up a handful of differences small enough that the answer never changed. I brought fourteen of them to you and you approved fourteen.",
      "I could have inferred a threshold from that and started acting on it. I didn't, because a spend rule is yours to write, not mine to assume. So I'm asking for it in one place instead of asking fourteen more times.",
    ],
    restraint:
      "I did not apply this while waiting. The four differences from this morning's run are still sitting unresolved.",
    effect: [
      ["Questions I'd stop asking", "roughly 12 a quarter"],
      ["Money in scope", "£50 per line, £600 seen"],
      ["What I'd still bring you", "anything Ferris, at any amount"],
    ],
    from: "6 runs",
    evidence: [
      {
        key: "spend-floor-chat",
        kind: "chat",
        title: "The fourteenth approval",
        at: { dayOffset: -3, hour: 7, minute: 2 },
        why: "It's the clearest statement that the amount, not the vendor, is what you're deciding on.",
        externalId: "0821",
        turns: [
          {
            who: "agent",
            at: { dayOffset: -3, hour: 7, minute: 2 },
            text: "Trellis invoice 4471 is out by £31.40 against the ledger. Post the difference?",
          },
          {
            who: "you",
            at: { dayOffset: -3, hour: 7, minute: 4 },
            text: "Yes. Honestly anything under fifty just post it, I don't need to see those.",
            pinned: true,
          },
          {
            who: "agent",
            at: { dayOffset: -3, hour: 7, minute: 4 },
            text: "Noted, but I'd rather you set that as a rule than have me read it off one message. I'll keep asking until you do.",
          },
        ],
      },
      {
        key: "spend-floor-shot",
        kind: "screenshot",
        title: "Approvals ledger, this quarter",
        at: { dayOffset: 0, hour: 6, minute: 38 },
        why: "Fourteen approvals, no rejections. It's the count the suggestion rests on.",
        shot: {
          file: "approvals-q3.png",
          context: "my own record",
          width: 1440,
          height: 780,
          summary: "The quarter's approval ledger, filtered to what I asked about and what you said back.",
          regions: [
            { label: "Column 3", note: "Amount. Every row under £50." },
            { label: "Column 5", note: "Outcome. Approved, fourteen times." },
          ],
          text: "14 requests · 14 approved · 0 rejected\nlargest £48.20 · smallest £3.05 · total £412.60",
        },
      },
    ],
  },
  {
    key: "tuesday-triage",
    title: "Move inbox triage to 05:30 on Tuesdays",
    status: "proposed",
    confidence: "strong",
    formed: { dayOffset: 0, hour: 6, minute: 12 },
    blurb:
      "Your Tuesday standup notes land at 05:45, so the six o'clock run reads them a week late. Shifting one weekday would fix it.",
    basisLabel: "7 runs missed the notes",
    basisCount: 7,
    basisRunCount: 7,
    scopeUri: "okf:task/inbox-triage",
    scopeLabel: "Scheduled workflow",
    affirm: "Shift Tuesdays to 05:30",
    quiet: "Leave the schedule",
    prose: [
      "Inbox triage runs at six every weekday. On Tuesdays your standup notes arrive at 05:45 and I read them the following Tuesday, so the actions I raise on a Tuesday are always a week behind the room.",
      "Moving one weekday half an hour earlier fixes it without touching the other four. I haven't changed the schedule because you set it.",
    ],
    restraint: "I kept running at six and flagged the stale reads rather than quietly re-timing myself.",
    effect: [
      ["Runs affected", "Tuesdays only"],
      ["New time", "05:30, from next week"],
      ["What stays", "Mon, Wed, Thu, Fri at 06:00"],
    ],
    from: "7 runs",
    evidence: [
      {
        key: "tuesday-triage-mail",
        kind: "email",
        title: "Tuesday standup notes",
        at: { dayOffset: -6, hour: 5, minute: 45 },
        why: "The timestamp is the whole argument: quarter to six, fifteen minutes before I read anything.",
        counterparty: { name: "Marta Iyer", kind: "person", email: "marta.iyer@fieldstone.co" },
        externalId: "0818",
        email: {
          fromAddr: "marta.iyer@fieldstone.co",
          toAddr: "you@fieldstone.co",
          subject: "Standup notes — Tuesday",
          pinned: 1,
          body: [
            "Short one this week. Three items carried over, one new.",
            "Sending these early so they're in front of you before the six o'clock sweep picks up the day.",
          ],
        },
      },
    ],
  },
  {
    key: "ferrier-row-drafts",
    title: "Stop drafting replies to Ferrier Row",
    status: "proposed",
    confidence: "worth_a_look",
    formed: { dayOffset: -1, hour: 14, minute: 20 },
    blurb:
      "You rewrote my last five drafts to that address almost entirely. I'd rather hand you the thread than a draft you don't want.",
    basisLabel: "5 drafts, 5 rewritten",
    basisCount: 5,
    scopeUri: "okf:contact/ferrier-row",
    scopeLabel: "One contact",
    affirm: "Hand me the thread instead",
    quiet: "Keep drafting",
    prose: [
      "I've drafted five replies to Ferrier Row and you've rewritten all five down to the greeting. The drafts aren't saving you anything; they're giving you something to delete first.",
      "I'd rather stop and hand you the thread with the facts pulled out. If the pattern changes I'll offer to draft again.",
    ],
    restraint: "I have not stopped drafting on my own. There's a sixth draft waiting in the thread from this morning.",
    effect: [
      ["What I'd send instead", "the thread and a fact list"],
      ["Where it applies", "Ferrier Row only"],
      ["Reversible", "yes, any time"],
    ],
    from: "5 drafts",
    evidence: [
      {
        key: "ferrier-row-thread",
        kind: "thread",
        title: "Draft five, before and after",
        at: { dayOffset: -1, hour: 14, minute: 2 },
        why: "Kept because the rewrite changed the position, not the wording.",
        counterpartyLabel: "you, editing me",
        externalId: "ferrier-5",
        turns: [
          {
            who: "agent",
            at: { dayOffset: -1, hour: 14, minute: 2 },
            text: "Happy to look at moving the date — let us know what suits and we'll work around it.",
          },
          {
            who: "you",
            at: { dayOffset: -1, hour: 14, minute: 12 },
            text: "The date stands. We've moved twice already.",
            pinned: true,
          },
        ],
      },
    ],
  },
  {
    key: "quarter-boundary",
    title: "Group quarter-boundary differences rather than asking per invoice",
    status: "adopted",
    confidence: "strong",
    formed: { dayOffset: -16, hour: 6, minute: 12 },
    decided: { dayOffset: -13, hour: 9, minute: 2 },
    blurb:
      "You took this one in August. I've held it since and it has cut the reconciliation run from nineteen questions to four.",
    basisLabel: "6 runs since",
    basisRunCount: 4,
    scopeUri: "okf:policy/quarter-boundary",
    scopeLabel: "Vendor reconciliation",
    affirm: "Keep it",
    quiet: "Drop the rule",
    prose: [
      "You took this after a run that asked you nineteen separate questions about the same quarter boundary. Since then I group them and ask once.",
      "Six runs have used it. The reconciliation run now averages four questions instead of nineteen.",
    ],
    restraint:
      "It only covers differences that sit either side of a quarter close. Anything else I still bring individually.",
    effect: [
      ["Runs under it", "6"],
      ["Questions saved", "about 15 a run"],
    ],
    from: "4 runs",
  },
  {
    key: "digest-without-finance",
    title: "Send the weekly digest without waiting for the finance source",
    status: "declined",
    confidence: "worth_a_look",
    formed: { dayOffset: -24, hour: 21, minute: 30 },
    decided: { dayOffset: -21, hour: 21, minute: 14 },
    blurb:
      "You said no, and said why: a partial digest reads as a complete one. I won't raise it again unless the source starts failing weekly.",
    basisRunCount: 3,
    scopeUri: "okf:task/weekly-digest",
    scopeLabel: "Weekly digest",
    affirm: "Send it anyway",
    quiet: "Keep stopping",
    prose: [
      "I suggested sending the digest on time with a note where the finance section should be. You declined and told me a partial digest reads as a complete one to whoever gets it.",
      "I've held that ever since: when finance fails twice, I stop and tell you rather than send.",
    ],
    restraint: "I won't raise this again unless the finance source starts failing every week.",
    effect: [
      ["What I do instead", "stop and tell you"],
      ["Would re-raise if", "weekly source failures"],
    ],
    from: "3 runs",
  },
];

/** The line above the list. Counted after it, not in it. */
export const RECOMMENDATIONS_LEDE = "Changes I'd make to how I work, drawn from what I've watched.";
