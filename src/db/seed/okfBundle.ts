// A synthetic OKF bundle, for tests.
//
// The real store under okf/ is personal — contacts, addresses, health — and is
// gitignored for that reason, so nothing in the test suite may read it. This
// writes a small bundle that exercises every shape the indexer has an opinion
// about: a memory whose facts are field-shaped, one that states a label twice
// with two answers, one that is nothing but prose, one that has been
// deprecated, one that is past its review date, cross-links in both the body
// and a `## Related` block, and a log with more than one entry for a file.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Fixture {
  id: string;
  body: string;
}

const FILES: Fixture[] = [
  {
    id: "gathering-at-the-orchard",
    body: `---
type: Memory
title: The orchard gathering — Sept 12, at Wren's, bring the long table
description: A gathering at Wren's orchard on September 12. Wren is hosting, the long table is coming from us, and there is no rain plan yet.
tags: [personal, planning, events, party]
generated: { by: okfManagerAgent, at: 2026-08-14T11:02:00Z }
stale_after: 2026-11-01
sources:
  - resource: user conversation
    title: You told me over dinner
    author: human:user
---

## Details

- **Date:** September 12
- **Host:** Wren
- **Bringing:** the long table
- **Rain plan:** none agreed

## Context

Wren offered the orchard before anyone asked, and nobody has raised what happens if it rains.

## Related

- [Wren, and how you know her](/memories/wren-and-how-you-know-her.md)
`,
  },
  {
    id: "wren-and-how-you-know-her",
    body: `---
type: Memory
title: Wren — met through the allotment, keeps the orchard
description: Wren keeps the orchard at the end of the lane. You met through the allotment committee.
tags: [personal, contacts, relationship]
generated: { by: okfManagerAgent, at: 2026-06-02T09:15:00Z }
stale_after: 2026-12-01
sources:
  - resource: allotment committee minutes
    title: Committee minutes, March
---

## Memory

Wren keeps the orchard at the end of the lane and you met her through the allotment committee.

## Contact

- **Phone:** listed on the committee sheet
`,
  },
  {
    id: "the-shed-roof",
    body: `---
type: Memory
title: The shed roof — two different quotes, both from August
description: Two quotes for the shed roof, and I have not worked out which is current.
tags: [personal, household, repairs]
generated: { by: okfManagerAgent, at: 2026-08-09T16:40:00Z }
stale_after: 2026-08-20
sources:
  - resource: text messages
    title: Quotes read out of your texts
    author: human:tobin-ashgrove
---

## Quotes

- **Quote:** £1,240, ridge and felt
- **Quote:** £980, felt only
- **Quoted by:** Tobin Ashgrove

## Context

Both arrived in August. Newer is not the same as current, so I kept both.
`,
  },
  {
    id: "the-long-walk-in-may",
    body: `---
type: Memory
title: The long walk in May
description: You walked the ridge in May and said afterwards you wanted to do it yearly.
tags: [personal, walking]
generated: { by: okfManagerAgent, at: 2026-05-30T19:00:00Z }
stale_after: 2027-01-01
sources:
  - resource: user conversation
    title: You mentioned it afterwards
    author: human:user
---

## Memory

You walked the ridge in May with [Wren](/memories/wren-and-how-you-know-her.md) and said afterwards that you wanted to make it a yearly thing.

## Context

Nothing has been arranged for next year.
`,
  },
  {
    id: "the-old-bike-lock-code",
    body: `---
type: Memory
title: The old bike lock code
description: The code for the bike lock you no longer own.
tags: [personal, household]
status: deprecated
generated: { by: okfManagerAgent, at: 2026-02-11T08:00:00Z }
stale_after: 2027-01-01
sources:
  - resource: user conversation
    title: You told me when you bought it
    author: human:user
---

## Memory

The lock went with the bike. Kept so that a note referring to it still resolves.
`,
  },
];

const LOG = `# Bundle Update Log

## 2026-08-14
* **Update**: Updated [The orchard gathering — Sept 12, at Wren's, bring the long table](/memories/gathering-at-the-orchard.md).

## 2026-08-09
* **Creation**: Established [The shed roof — two different quotes, both from August](/memories/the-shed-roof.md).

## 2026-07-30
* **Creation**: Established [The orchard gathering — Sept 12, at Wren's, bring the long table](/memories/gathering-at-the-orchard.md).

## 2026-06-02
* **Creation**: Established [Wren — met through the allotment, keeps the orchard](/memories/wren-and-how-you-know-her.md).

## 2026-05-30
* **Creation**: Established [The long walk in May](/memories/the-long-walk-in-may.md).

## 2026-02-11
* **Creation**: Established [The old bike lock code](/memories/the-old-bike-lock-code.md).
`;

const INDEX = `---
okf_version: "0.2"
---

# Groups

* [memories](memories/)
`;

/** Write the bundle under `root` and return the path. */
export function writeOkfFixture(root: string): string {
  mkdirSync(join(root, "memories"), { recursive: true });
  writeFileSync(join(root, "index.md"), INDEX);
  writeFileSync(join(root, "log.md"), LOG);
  for (const file of FILES) writeFileSync(join(root, "memories", `${file.id}.md`), file.body);
  return root;
}

/** What the fixture holds, so a test can assert against it by name. */
export const FIXTURE_IDS = FILES.map((f) => `memories/${f.id}`);
