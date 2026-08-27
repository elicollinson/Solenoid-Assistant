// The one sentence a list draws under its title.
//
// The server writes it in two halves: the agent's own line, then a clause
// counting what is true of the list right now — how late you are, how many are
// waiting on you, how many need a word before it goes further.
//
// Nothing writes to the database yet, so a mark given in the browser changes
// that count without the server ever hearing about it, and the sentence would
// go on claiming four while the list underneath it drew three. Only the clause
// after the first full stop was ever a count, so only the clause is rewritten;
// the agent's own line is left exactly as it was written.
//
// Each surface keeps its own clause, because each one counts a different thing
// and says so in its own words. What is shared is the splitting and the words
// for small numbers — the product spells those out in prose.

export const WORDS = ["Nothing", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

/** The number as the product says it in a sentence: "Three", not "3". */
export const spell = (n: number) => WORDS[n] ?? String(n);

/** The agent's line, kept; the count after it, replaced. */
export function recount(lede: string, clause: string): string {
  const head = lede.slice(0, lede.indexOf(".") + 1);
  return head ? `${head} ${clause}` : lede;
}
