// For long chapters, preserve the most information-dense regions (opening and
// closing) while dropping middle filler. A 70/30 split keeps intro/thesis +
// conclusion, which is what a pre-reading digest actually needs.
export function trimForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = maxChars - headChars - 20; // 20 chars for the ellipsis marker
  const head = text.substring(0, headChars);
  const tail = text.substring(text.length - tailChars);
  return `${head}\n\n[...middle omitted...]\n\n${tail}`;
}
