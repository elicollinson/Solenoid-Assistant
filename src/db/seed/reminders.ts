// Everything behind one reminder: why it was set, what it came from, and what
// has happened to it since.
//
// The list rows live in ./fixtures.ts. This file is the detail screen — the
// agent's account, the artifacts it read, and the trail underneath — because
// the design keeps them apart too, and the row has no business carrying three
// paragraphs it never shows.
//
// Three places deliberately differ from the design's own fixtures, and all
// three are places the design contradicts itself between screens:
//
//   * `ferris-credit-note` and `parking-permit` carry their affirm/quiet pair
//     as plain actions rather than an open decision. Both would otherwise be
//     counted by the home screen, which the design draws saying two things
//     need a word from you — the contract reply and the boiler slot. A reminder
//     that nags is not the same object as a gate a run is stopped on, and the
//     agent's own history line for the credit note says as much: "Due. I
//     didn't chase you."
//
//   * `ferris-follow-up` has no date and its account says why. The design sets
//     it when the reply goes out; here the reply is still waiting on your
//     approval, so the date it would hang off does not exist yet.
//
//   * a reminder's `ref` — the mono "thread/4c02" beside a source — is derived
//     from the source itself rather than stored. Two of the design's refs name
//     OKF objects, and nothing has seeded those yet; citing a uri that resolves
//     to nothing is worse than naming the file I actually kept.
//
// Everything else is the design's prose, transcribed.

/** Local wall clock, relative to the seed's anchor day. */
export interface When {
  dayOffset: number;
  hour: number;
  minute: number;
}

/** One line of the "What I've done about it" trail. */
export interface HistoryFixture {
  at: When;
  text: string;
  /** "you" when the line records something you did rather than the agent. */
  by?: "agent" | "user";
}

/** A pair the agent wrote that nothing in the schema can count. */
export interface MetaFixture {
  label: string;
  value: string;
}

export interface ActionFixture {
  label: string;
  stance: "affirm" | "neutral" | "quiet" | "danger" | "bare";
  effectKind: "navigate" | "resolve" | "custom" | "tool_call" | "run_workflow" | "snooze";
  effect?: Record<string, unknown>;
}

export interface TurnFixture {
  /** Whose side of the conversation. "them" is the counterparty. */
  who: "you" | "them" | "agent";
  at: When;
  text: string;
  /** The clause the agent acted on. */
  pinned?: boolean;
}

export interface EmailFixture {
  fromAddr: string;
  toAddr: string;
  subject: string;
  body: readonly string[];
  /** The "> …" block, kept apart so a pin never lands in quoted text. */
  quoted?: readonly string[];
  attachments?: readonly { filename: string; mimeType: string; sizeBytes: number }[];
  /** Index into `body` of the paragraph the agent acted on. */
  pinned?: number;
  /** Written by the agent and held, rather than sent. */
  draft?: boolean;
  /** Which run wrote the draft. */
  draftedBy?: { slug: string; ordinal: number };
}

export interface ShotFixture {
  file: string;
  /** "captured by me from the accounts portal" — where the agent got it. */
  context: string;
  width: number;
  height: number;
  /** What the analysis made of it, in one line. */
  summary: string;
  regions: readonly { label: string; note: string }[];
  /** The OCR text, as the design's shot.text. */
  text?: string;
  /** Set when the agent took it during a run. */
  capturedIn?: { slug: string; ordinal: number };
}

export interface ArticleFixture {
  url: string;
  /** "borough council · parking" */
  site: string;
  headline: string;
  byline?: string;
  words: number;
  body: readonly string[];
  pinned?: number;
}

export type EvidenceKind = "thread" | "email" | "chat" | "screenshot" | "article";

export interface EvidenceFixture {
  key: string;
  kind: EvidenceKind;
  title: string;
  at: When;
  /** Why the agent kept this one. Written on the link, not the source: the
   *  same email cited twice earns a different sentence each time. */
  why: string;
  /** Conversations only. The counterparty's name; you and I are implicit. */
  counterparty?: { name: string; kind: "person" | "org"; phone?: string; email?: string };
  /** What to call the other side when there is no other side to name — a
   *  thread that is you and me looking at the same draft. */
  counterpartyLabel?: string;
  externalId?: string;
  turns?: readonly TurnFixture[];
  email?: EmailFixture;
  shot?: ShotFixture;
  article?: ArticleFixture;
}

export interface ReminderDetailFixture {
  /** "Why I set this", in the agent's voice. */
  prose: readonly string[];
  /** Pairs beyond the derived ones (set by, due, source, what it blocks). */
  meta?: readonly MetaFixture[];
  history: readonly HistoryFixture[];
  /** The standing rule this reminder is an instance of. */
  instruction?: string;
  /** Buttons. A reminder with an open decision hangs them off it; the rest
   *  are plain affordances, and read as links rather than commitments. */
  actions?: readonly ActionFixture[];
  /** Which workflow this is holding up, by slug. */
  blocks?: string;
  /** Which workflow it is merely about. */
  about?: string;
  evidence?: readonly EvidenceFixture[];
}

export const REMINDER_DETAIL: Record<string, ReminderDetailFixture> = {
  "ferris-credit-note": {
    prose: [
      "You told me to leave anything Ferris alone until the credit note was settled, so that is what I have been doing. It has now held two invoices for ten days.",
      "Invoices 2291 and 2318 have no matching ledger line and both post-date the credit note. I can't tell whether they were meant to be covered by it or billed separately, and guessing either way would put a number in the ledger that you didn't agree to.",
      "The reconciliation is otherwise finished and waiting on this one decision. I set the reminder for yesterday at 17:00 because that was the last point at which settling it would still have closed the quarter on time. It didn't, so this is now the oldest thing I'm holding.",
    ],
    meta: [{ label: "Holding", value: "2 invoices" }],
    blocks: "vendor-reconciliation",
    history: [
      { at: { dayOffset: -10, hour: 9, minute: 20 }, text: "Set this after you told me to hold the Ferris items." },
      { at: { dayOffset: -6, hour: 6, minute: 12 }, text: "Reconciliation reached the Ferris invoices and stopped there rather than matching them." },
      { at: { dayOffset: -1, hour: 17, minute: 0 }, text: "Due. I didn't chase you — you were in the Latham review all afternoon." },
      { at: { dayOffset: 0, hour: 6, minute: 14 }, text: "Held again this morning. Nothing else in the run is waiting on you." },
    ],
    instruction: "Don't touch anything Ferris until the credit note is decided.",
    actions: [
      { label: "Settle it now", stance: "affirm", effectKind: "custom", effect: { op: "settle_credit_note" } },
      { label: "Keep holding", stance: "quiet", effectKind: "snooze", effect: { days: 7 } },
    ],
    evidence: [
      {
        key: "ferris-credit-note-email",
        kind: "email",
        title: "Credit note CN-0117 — for your records",
        at: { dayOffset: -13, hour: 16, minute: 41 },
        why: "This is the note itself. It never says which invoices it covers, which is the whole reason I stopped.",
        counterparty: { name: "Ferris Supply Co.", kind: "org", email: "accounts@ferrissupply.co.uk" },
        externalId: "4c02",
        email: {
          fromAddr: "accounts@ferrissupply.co.uk",
          toAddr: "you@fieldstone.co",
          subject: "Credit note CN-0117 — for your records",
          pinned: 1,
          body: [
            "Please find attached credit note CN-0117 raised against your account following the supply charges review.",
            "The credit has been applied at account level and will be reflected on your next statement. Individual invoices have not been amended.",
            "Any queries, reply to this address and quote the note number.",
          ],
          quoted: ["> Raised following the review of Q2 supply charges discussed on 4 August."],
          attachments: [{ filename: "CN-0117.pdf", mimeType: "application/pdf", sizeBytes: 86_016 }],
        },
      },
      {
        key: "ferris-ledger-shot",
        kind: "screenshot",
        title: "Ledger view, invoices 2291 and 2318 unmatched",
        at: { dayOffset: -6, hour: 6, minute: 19 },
        why: "I took this because the portal has no export. It is the only record that both lines were open at the moment I stopped.",
        shot: {
          file: "ledger-2026-q3.png",
          context: "captured by me from the accounts portal",
          width: 1440,
          height: 900,
          summary: "The accounts portal's Q3 ledger, with two invoices and the account credit all showing as unmatched.",
          capturedIn: { slug: "vendor-reconciliation", ordinal: 14 },
          regions: [
            { label: "Row 14", note: "Invoice 2291 · £2,140.00 · posted Aug 15 · no matching ledger line." },
            { label: "Row 15", note: "Invoice 2318 · £860.00 · posted Aug 18 · no matching ledger line." },
            { label: "Header", note: "Account credit shown as £3,000.00, undated and unallocated." },
          ],
          text: "2291  15 Aug  2,140.00  UNMATCHED\n2318  18 Aug    860.00  UNMATCHED\nACCOUNT CREDIT        3,000.00  UNALLOCATED",
        },
      },
      {
        key: "ferris-hold-chat",
        kind: "chat",
        title: "You told me to leave the Ferris items alone",
        at: { dayOffset: -11, hour: 9, minute: 18 },
        why: "This is the instruction I have been following. I read it as covering the invoices as well as the note.",
        externalId: "aa71",
        turns: [
          { who: "you", at: { dayOffset: -11, hour: 9, minute: 16 }, text: "Ferris sent a credit note but it doesn't line up with anything. Don't do anything with their invoices yet." },
          { who: "agent", at: { dayOffset: -11, hour: 9, minute: 17 }, pinned: true, text: "Understood. I'll hold anything Ferris until you tell me the credit note is settled. That includes matching their invoices in the reconciliation." },
          { who: "you", at: { dayOffset: -11, hour: 9, minute: 18 }, text: "Right. And set me a reminder so it doesn't sit forever." },
          { who: "agent", at: { dayOffset: -11, hour: 9, minute: 18 }, text: "Set for the 23rd at 17:00, which is the last point at which settling it still closes the quarter on time." },
        ],
      },
    ],
  },

  "boiler-slot": {
    prose: [
      "The service company offered Thursday morning or Friday afternoon. Both are clear in your calendar, and neither clashes with anything I'd move on your own initiative.",
      "I didn't pick for you because the last two times I booked a trades visit you moved it, and both times to the later slot. That's twice, which isn't enough for me to treat it as a rule.",
    ],
    meta: [{ label: "Options", value: "2" }],
    history: [
      { at: { dayOffset: -3, hour: 11, minute: 4 }, text: "Read the offer of two slots and set this rather than replying." },
      { at: { dayOffset: -2, hour: 9, minute: 0 }, text: "Confirmed both slots are still free in your calendar." },
    ],
    instruction: "Anything that puts a stranger in the house waits for me.",
    actions: [
      { label: "Take Friday", stance: "affirm", effectKind: "custom", effect: { op: "book_slot", slot: "friday" } },
      { label: "Show me the thread", stance: "quiet", effectKind: "custom", effect: { op: "open_thread", thread: "9a44" } },
    ],
    evidence: [
      {
        key: "boiler-offer-thread",
        kind: "thread",
        title: "Boiler service — two slots offered",
        at: { dayOffset: -3, hour: 10, minute: 52 },
        why: "Both slots came in one message and neither was marked as preferred, so there was nothing for me to choose on.",
        counterparty: { name: "Fenwick Heating", kind: "org", phone: "+44 7700 900412" },
        externalId: "9a44",
        turns: [
          { who: "them", at: { dayOffset: -3, hour: 10, minute: 47 }, text: "Morning — we're in your area next week for the annual service. Do you want us to book you in?" },
          { who: "you", at: { dayOffset: -3, hour: 10, minute: 49 }, text: "Yes please, whatever's easiest." },
          { who: "them", at: { dayOffset: -3, hour: 10, minute: 52 }, pinned: true, text: "We can do Thursday 8–11am or Friday 1–4pm. Either is fine our end, just let us know which." },
        ],
      },
      {
        key: "later-slot-chat",
        kind: "chat",
        title: "The last two visits you moved to the later slot",
        at: { dayOffset: -176, hour: 18, minute: 30 },
        why: "Twice is a pattern I noticed, not a rule you gave me, so I didn't book Friday on the strength of it.",
        externalId: "72c9",
        turns: [
          { who: "agent", at: { dayOffset: -176, hour: 18, minute: 28 }, text: "The electrician is booked for Tuesday morning." },
          { who: "you", at: { dayOffset: -176, hour: 18, minute: 30 }, pinned: true, text: "Move it to the afternoon if they'll take it. Mornings are bad for me at the moment." },
          { who: "agent", at: { dayOffset: -176, hour: 18, minute: 31 }, text: "Moved to 2pm. I haven't made that a standing preference — say the word and I will." },
        ],
      },
    ],
  },

  "call-marta": {
    prose: [
      "She called on Tuesday while you were out. There's a note in memory saying she prefers afternoon calls, so I set this for the end of the day rather than the morning.",
    ],
    history: [
      { at: { dayOffset: -3, hour: 14, minute: 10 }, text: "Missed call logged. Reminder set for an afternoon, per her preference." },
    ],
    evidence: [
      {
        key: "marta-call-log-shot",
        kind: "screenshot",
        title: "Missed call from Marta",
        at: { dayOffset: -3, hour: 14, minute: 9 },
        why: "There was no voicemail, so the log is all there is. I set the reminder for the afternoon she prefers.",
        shot: {
          file: "call-log-aug22.png",
          context: "captured by me from the phone log",
          width: 390,
          height: 260,
          summary: "The phone log, showing one missed call and no voicemail.",
          regions: [
            { label: "Entry 1", note: "Marta Reyes · missed · 14:07 · 2 rings, no voicemail." },
            { label: "Memory", note: "okf:contact/marta records a preference for afternoon calls." },
          ],
        },
      },
    ],
  },

  "parking-permit": {
    prose: [
      "The permit lapses on the 3rd. Renewal needs the plate, the address, and a card — I have the first two already.",
      "I can do the whole thing myself if you say so once. I haven't, because it spends money and you've never told me a standing amount I'm allowed to spend without asking.",
    ],
    meta: [
      { label: "Lapses", value: "Sep 3" },
      { label: "Cost", value: "£84" },
    ],
    history: [
      { at: { dayOffset: -5, hour: 7, minute: 0 }, text: "Found the expiry date while filing the permit document." },
      { at: { dayOffset: -5, hour: 7, minute: 1 }, text: "Set this two weeks ahead so a postal delay wouldn't matter." },
    ],
    instruction: "Anything that commits money waits for me.",
    actions: [
      { label: "Renew it for me", stance: "affirm", effectKind: "custom", effect: { op: "renew_permit" } },
      { label: "I'll do it", stance: "quiet", effectKind: "resolve" },
    ],
    evidence: [
      {
        key: "permit-front-shot",
        kind: "screenshot",
        title: "Permit document, expiry date",
        at: { dayOffset: -5, hour: 6, minute: 58 },
        why: "I filed the document and read the date off it. Everything I need to renew is on this page except a card.",
        shot: {
          file: "permit-2026.png",
          context: "captured by me while filing",
          width: 1240,
          height: 1754,
          summary: "The resident parking permit, front page, with the plate and the expiry both legible.",
          regions: [
            { label: "Field 3", note: "Valid until 3 September 2026." },
            { label: "Field 5", note: "Vehicle plate matches the one you gave me in March." },
            { label: "Footer", note: "Renewal fee £84, payable by card at the time of application." },
          ],
        },
      },
      {
        key: "permit-renewal-article",
        kind: "article",
        title: "Council renewal window and late penalties",
        at: { dayOffset: -5, hour: 6, minute: 59 },
        why: "I checked whether waiting cost anything. It doesn't until the 3rd, which is why I set this for Thursday and not sooner.",
        article: {
          url: "https://www.borough.gov.uk/parking/permits/renew",
          site: "borough council · parking",
          headline: "Renewing a resident parking permit",
          byline: "Parking services",
          words: 540,
          pinned: 2,
          body: [
            "Resident permits run for twelve months from the date of issue and must be renewed before the expiry date printed on the permit.",
            "Renewals can be made online up to twenty-eight days in advance. The new permit takes effect the day after the old one expires, so renewing early does not shorten the term.",
            "There is no charge for renewing early and no penalty until the permit has expired. Vehicles displaying an expired permit may be issued a penalty charge notice from the first day.",
            "If the vehicle has changed, a new application is required rather than a renewal.",
          ],
        },
      },
    ],
  },

  "priya-figures": {
    prose: [
      "You sent the figures at 08:40, forty minutes after this came due, so I closed it out rather than reminding you about something you'd already done.",
    ],
    history: [
      { at: { dayOffset: -8, hour: 16, minute: 30 }, text: "Set after Priya asked for revised figures." },
      { at: { dayOffset: -3, hour: 8, minute: 40 }, text: "Saw the reply go out and closed this without asking." },
    ],
    evidence: [
      {
        key: "priya-figures-email",
        kind: "email",
        title: "Revised figures — sent",
        at: { dayOffset: -3, hour: 8, minute: 40 },
        why: "I saw this go out and closed the reminder rather than raising something you had already done.",
        counterparty: { name: "Priya Nandakumar", kind: "person", email: "priya@nandakumar.partners" },
        externalId: "8c01",
        email: {
          fromAddr: "you@fieldstone.co",
          toAddr: "priya@nandakumar.partners",
          subject: "Re: Revised figures",
          pinned: 0,
          body: [
            "Attached are the revised figures with the Q3 adjustments applied. The headline number moves by about four per cent.",
            "Shout if anything looks off before Wednesday.",
          ],
          attachments: [
            { filename: "figures-rev3.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sizeBytes: 217_088 },
          ],
        },
      },
    ],
  },

  "ferris-follow-up": {
    prose: [
      "I set this alongside the draft this morning, before it went anywhere. It has no date on it because the date depends on when the reply actually goes out, and that is still with you.",
      "Three days is the longest Ferris has ever taken to answer, so three days after it sends is what I'll put on this. If they answer first I'll drop it without telling you.",
    ],
    history: [
      { at: { dayOffset: 0, hour: 7, minute: 41 }, text: "Drafted the reply and set this at the same time, with no date on it until the draft goes out." },
    ],
    evidence: [
      {
        key: "ferris-reply-draft",
        kind: "email",
        title: "Contract amendment — the reply I drafted",
        at: { dayOffset: 0, hour: 7, minute: 41 },
        why: "This is the draft waiting on you. The follow-up exists because it asks for an answer and doesn't set a date for one.",
        counterparty: { name: "Ferris Supply Co.", kind: "org", email: "contracts@ferrissupply.co.uk" },
        externalId: "1f8ac2",
        email: {
          fromAddr: "you@fieldstone.co",
          toAddr: "contracts@ferrissupply.co.uk",
          subject: "Re: Contract amendment — March start",
          pinned: 1,
          draft: true,
          draftedBy: { slug: "contract-review", ordinal: 3 },
          body: [
            "A March 1 start works for us and we're happy to sign on that basis.",
            "The handling fee is the one item we'd push back on. It was waived last year on the same terms and nothing about the scope or the term has changed, so we'd expect the same treatment.",
            "Send the amended draft over and we'll turn it round quickly.",
          ],
          quoted: ["> Please confirm the March 1 start and the revised schedule of charges by return."],
        },
      },
    ],
  },

  // Drawn on the calendar and nowhere else in the design. It is a reminder, so
  // it is one here, and it is on both screens rather than only the one that
  // happened to draw it.
  "review-notes": {
    prose: [
      "You have sent notes round after the last four quarter reviews, and the shortest gap was a day and a half. So a day and a half is where I put this.",
      "I have not drafted them. What was said in the room is yours, and a draft of it from me would be a guess wearing your name.",
    ],
    history: [
      { at: { dayOffset: 0, hour: 6, minute: 44 }, text: "Set this when the review moved onto today, at the same gap as the last four." },
    ],
    actions: [{ label: "I will do it sooner", stance: "quiet", effectKind: "snooze", effect: { days: 1 } }],
  },

  "job-sweep-note": {
    prose: [
      "You paused the sweep on Aug 9 and didn't say for how long. Restarting something you switched off isn't mine to decide, so I kept a note instead.",
    ],
    about: "job-listings-sweep",
    history: [
      { at: { dayOffset: -16, hour: 18, minute: 20 }, text: "Sweep paused by you. Note kept, no schedule set." },
    ],
    instruction: "Don't restart anything I've paused.",
    evidence: [
      {
        key: "sweep-pause-chat",
        kind: "chat",
        title: "You paused the sweep",
        at: { dayOffset: -16, hour: 18, minute: 19 },
        why: "You didn't say for how long, and restarting something you switched off isn't mine to decide.",
        externalId: "5b30",
        turns: [
          { who: "you", at: { dayOffset: -16, hour: 18, minute: 19 }, pinned: true, text: "Stop the job listings sweep for now." },
          { who: "agent", at: { dayOffset: -16, hour: 18, minute: 19 }, text: "Paused. I haven't deleted the criteria. I'll keep a note rather than a schedule, since you didn't say until when." },
        ],
      },
    ],
  },
};
