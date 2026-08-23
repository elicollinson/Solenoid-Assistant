// Split a string into substrings, each containing a random number of words
// (at least two) up to a maximum word count per chunk. Throws if maxLength
// is less than two.
export function chunkWords(
  input: string,
  maxLength: number,
  random: () => number = Math.random,
): string[] {
  if (maxLength < 2) {
    throw new Error(
      `maxLength must be at least 2, received ${maxLength}`,
    );
  }

  const words = input.trim().split(/\s+/).filter(Boolean);
  const chunks: string[] = [];

  let i = 0;
  while (i < words.length) {
    // Random length in [2, maxLength], but never exceed remaining words.
    const remaining = words.length - i;
    const upper = Math.min(maxLength, remaining);
    const lower = Math.min(2, remaining);
    const length =
      lower >= upper ? lower : lower + Math.floor(random() * (upper - lower + 1));

    const slice = words.slice(i, i + length).join(" ");
    chunks.push(slice);
    i += length;
  }

  return chunks;
}
