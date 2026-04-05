import { trimForSummary } from "./trim";

describe("trimForSummary", () => {
  it("returns short text unchanged when under maxChars", () => {
    const text = "Hello world";
    expect(trimForSummary(text, 100)).toBe(text);
  });

  it("returns text unchanged when length equals maxChars exactly", () => {
    const text = "a".repeat(200);
    expect(trimForSummary(text, 200)).toBe(text);
  });

  it("trims long text with 70/30 head/tail split and ellipsis marker", () => {
    const text = "A".repeat(300) + "B".repeat(300) + "C".repeat(400);
    const maxChars = 500;
    const result = trimForSummary(text, maxChars);

    expect(result).toContain("[...middle omitted...]");
  });

  it("head portion is 70% of maxChars", () => {
    const text = "x".repeat(1000);
    const maxChars = 500;
    const result = trimForSummary(text, maxChars);

    const headChars = Math.floor(maxChars * 0.7); // 350
    const head = result.split("\n\n[...middle omitted...]\n\n")[0];
    expect(head.length).toBe(headChars);
  });

  it("tail portion is the last 30%-minus-20 characters of original text", () => {
    // Build a text where each char position is identifiable
    const text = Array.from({ length: 1000 }, (_, i) => String(i % 10)).join("");
    const maxChars = 500;
    const result = trimForSummary(text, maxChars);

    const headChars = Math.floor(maxChars * 0.7); // 350
    const tailChars = maxChars - headChars - 20;   // 130
    const tail = result.split("\n\n[...middle omitted...]\n\n")[1];
    const expectedTail = text.substring(text.length - tailChars);
    expect(tail).toBe(expectedTail);
  });

  it("handles empty string", () => {
    expect(trimForSummary("", 100)).toBe("");
  });

  it("preserves unicode characters", () => {
    const text = "\u00e9\u00e0\u00fc\u00f1".repeat(100); // 400 chars
    const maxChars = 200;
    const result = trimForSummary(text, maxChars);

    expect(result).toContain("[...middle omitted...]");
    // Verify no mangled characters - all parts should only contain our original chars
    const parts = result.split("\n\n[...middle omitted...]\n\n");
    expect(parts[0]).toMatch(/^[\u00e9\u00e0\u00fc\u00f1]+$/);
    expect(parts[1]).toMatch(/^[\u00e9\u00e0\u00fc\u00f1]+$/);
  });
});
