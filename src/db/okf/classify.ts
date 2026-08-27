// Which shelf a memory sits on.
//
// The design groups OKF objects into People / Places and things / Rules you
// gave me / Documents, because its fictional store holds four kinds of record.
// This store holds one: 314 files that all say `type: Memory`. So the group has
// to come from what a memory is *about* rather than what it is, and the only
// structured signal a memory carries about its subject is its tags.
//
// Rules are ordered and first-match-wins, which makes the result explainable —
// "this is under Work because it is tagged `interview`" — and stable. A memory
// tagged with both a person and `career` lands under work, because the useful
// question about it is the job, not the person.
//
// Deliberately no LLM: the grouping has to be identical on every reindex, and a
// classifier that drifts would move rows around the list for no reason the user
// could see.

/** The badge on the detail header, and the `kind` column. */
export type OkfKind = "person" | "health" | "work" | "travel" | "home" | "plan" | "interest" | "note";

export interface Shelf {
  kind: OkfKind;
  /** The section heading on the list. */
  group: string;
  /** The filter chip. Short enough to sit in a row of them. */
  chip: string;
  tags: readonly string[];
}

/**
 * First match wins, so order is the taxonomy.
 *
 * People comes first but is deliberately narrow — contact details and who
 * someone is to you, not everything a named person appears in. Widening it to
 * bare name tags would put 130 of the 314 under one heading and empty the rest.
 */
export const SHELVES: readonly Shelf[] = [
  {
    kind: "person", group: "People and contacts", chip: "People",
    tags: ["contact", "contacts", "phone", "nickname", "identity", "relationship", "spouse",
      "fiancée", "fiancee", "engagement", "cohabitation", "address", "email"],
  },
  {
    kind: "health", group: "Health and care", chip: "Health",
    tags: ["health", "medication", "nyc-health", "therapy", "doctor", "medical", "illness",
      "symptoms", "appointment", "vet", "dentist", "surgery", "covid", "allergy", "insurance",
      "pets", "mental-health", "fitness", "sleep"],
  },
  {
    kind: "work", group: "Work and career", chip: "Work",
    tags: ["work", "career", "job-search", "interview", "colleague", "recruiting", "compensation",
      "celeris", "feedback", "promotion", "manager", "meeting", "hiring", "layoff", "salary",
      "performance-review", "onboarding", "payments", "transition", "project", "ai", "airtable",
      "resume", "referral", "workplace"],
  },
  {
    kind: "travel", group: "Travel and trips", chip: "Travel",
    tags: ["travel", "flights", "trip", "group-trip", "vacation", "hotel", "commute", "airport",
      "itinerary", "train", "road-trip", "visit", "transit"],
  },
  {
    kind: "home", group: "Money and home", chip: "Home",
    tags: ["finance", "rent", "housing", "household", "budget", "bills", "venmo",
      "shared-finances", "apartment", "mortgage", "utilities", "home", "cleaning", "furniture",
      "gift", "food", "groceries", "moving", "repairs"],
  },
  {
    kind: "plan", group: "Plans and dates", chip: "Plans",
    tags: ["planning", "events", "schedule", "birthday", "wedding", "engagement-party", "party",
      "celebration", "anniversary", "holiday", "reservation", "action-item", "social",
      "wedding-planning", "rsvp"],
  },
  {
    kind: "interest", group: "Interests and things", chip: "Interests",
    tags: ["media", "movie", "movies", "music", "film", "horror-movie", "trailer", "camera",
      "photography", "coffee", "espresso", "sewing", "style", "clothing", "fashion", "books",
      "reading", "sports", "games", "politics", "civic", "hobby", "shared-content", "art",
      "design", "tv", "podcast", "cooking", "recipe", "technology", "education"],
  },
];

/** Where everything the rules do not claim goes. Never empty in practice, and
 *  worth leaving visible: it is the list of tags the taxonomy has not learned. */
export const FALLBACK: Shelf = { kind: "note", group: "Everything else", chip: "Other", tags: [] };

/** The list's section order, and the chip row's. */
export const GROUPS: readonly string[] = [...SHELVES.map((s) => s.group), FALLBACK.group];

export function shelfFor(tags: readonly string[]): Shelf {
  const set = new Set(tags.map((t) => t.toLowerCase().trim()));
  for (const shelf of SHELVES) {
    if (shelf.tags.some((tag) => set.has(tag))) return shelf;
  }
  return FALLBACK;
}
