import { STOPWORDS, tokenize, jaccard, selectDiverse, DiversityItem } from "./diversity";

// ===== tokenize =====

describe("tokenize", () => {
  it("lowercases and returns a Set of content words", () => {
    const tokens = tokenize("Machine Learning Algorithms");
    expect(tokens).toBeInstanceOf(Set);
    expect(tokens.has("machine")).toBe(true);
    expect(tokens.has("learning")).toBe(true);
    expect(tokens.has("algorithms")).toBe(true);
  });

  it("strips accents (NFD normalization)", () => {
    const tokens = tokenize("programaci\u00f3n funci\u00f3n \u00e1rbol");
    expect(tokens.has("programacion")).toBe(true);
    expect(tokens.has("funcion")).toBe(true);
    expect(tokens.has("arbol")).toBe(true);
  });

  it("removes punctuation", () => {
    const tokens = tokenize("hello, world! foo-bar (baz)");
    expect(tokens.has("hello")).toBe(true);
    expect(tokens.has("world")).toBe(true);
    expect(tokens.has("foo")).toBe(true);
    expect(tokens.has("bar")).toBe(true);
    expect(tokens.has("baz")).toBe(true);
  });

  it("filters English stopwords", () => {
    const tokens = tokenize("the quick brown fox and the lazy dog");
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("and")).toBe(false);
    expect(tokens.has("quick")).toBe(true);
    expect(tokens.has("brown")).toBe(true);
  });

  it("filters Spanish stopwords", () => {
    const tokens = tokenize("el algoritmo para los datos entre sistemas");
    expect(tokens.has("el")).toBe(false);
    expect(tokens.has("para")).toBe(false);
    expect(tokens.has("los")).toBe(false);
    expect(tokens.has("entre")).toBe(false);
    expect(tokens.has("algoritmo")).toBe(true);
    expect(tokens.has("datos")).toBe(true);
    expect(tokens.has("sistemas")).toBe(true);
  });

  it("filters tokens shorter than 3 characters", () => {
    const tokens = tokenize("go do it now run big");
    // "go", "do", "it" are < 3 chars (also stopwords); "now" = 3 chars, "run" = 3 chars, "big" = 3 chars
    expect(tokens.has("now")).toBe(true);
    expect(tokens.has("run")).toBe(true);
    expect(tokens.has("big")).toBe(true);
  });

  it("handles empty and falsy input", () => {
    expect(tokenize("").size).toBe(0);
    expect(tokenize(null as any).size).toBe(0);
    expect(tokenize(undefined as any).size).toBe(0);
  });

  it("returns a Set (no duplicates)", () => {
    const tokens = tokenize("apple apple apple banana banana");
    expect(tokens.size).toBe(2);
    expect(tokens.has("apple")).toBe(true);
    expect(tokens.has("banana")).toBe(true);
  });
});

// ===== jaccard =====

describe("jaccard", () => {
  it("returns 1.0 for identical sets", () => {
    const a = new Set(["alpha", "beta", "gamma"]);
    expect(jaccard(a, a)).toBe(1.0);
  });

  it("returns 0.0 for completely disjoint sets", () => {
    const a = new Set(["alpha", "beta"]);
    const b = new Set(["gamma", "delta"]);
    expect(jaccard(a, b)).toBe(0.0);
  });

  it("computes partial overlap correctly", () => {
    const a = new Set(["alpha", "beta", "gamma"]);
    const b = new Set(["beta", "gamma", "delta"]);
    // intersection = {beta, gamma} = 2, union = {alpha, beta, gamma, delta} = 4
    expect(jaccard(a, b)).toBeCloseTo(0.5);
  });

  it("returns 0 when both sets are empty", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  it("returns 0 when one set is empty", () => {
    const a = new Set(["alpha"]);
    expect(jaccard(a, new Set())).toBe(0);
    expect(jaccard(new Set(), a)).toBe(0);
  });
});

// ===== selectDiverse =====

describe("selectDiverse", () => {
  function makeItem(text: string, bucket: string): DiversityItem {
    return { text, bucket, raw: { text, bucket } };
  }

  it("returns exactly targetCount items when enough candidates exist", () => {
    const items = [
      makeItem("machine learning algorithms neural networks", "A"),
      makeItem("database query optimization indexing", "B"),
      makeItem("distributed systems consensus protocols", "C"),
      makeItem("functional programming lambda calculus", "A"),
      makeItem("operating system kernel memory management", "B"),
    ];
    const result = selectDiverse(items, 3, 2);
    expect(result.length).toBe(3);
  });

  it("rejects near-duplicates (Jaccard >= threshold)", () => {
    const items = [
      makeItem("machine learning algorithms for data science", "A"),
      makeItem("machine learning algorithms for data analysis", "B"), // near-dup
      makeItem("quantum computing qubits entanglement superposition", "C"),
    ];
    const result = selectDiverse(items, 3, 3, 0.4);
    // The near-duplicate should be rejected in the first pass, but may come back
    // in the relaxed second pass. With only 3 candidates and target=3, the relaxed
    // pass will re-include it. Test with target=2 instead to verify first-pass dedup.
    const strictResult = selectDiverse(items, 2, 2, 0.4);
    const texts = strictResult.map((i) => i.text);
    // Should keep the first and the quantum one, not both ML items
    expect(texts).toContain("machine learning algorithms for data science");
    expect(texts).toContain("quantum computing qubits entanglement superposition");
  });

  it("respects maxPerBucket cap", () => {
    const items = [
      makeItem("topic alpha first version", "bucketX"),
      makeItem("topic beta second version", "bucketX"),
      makeItem("topic gamma third version", "bucketX"),
      makeItem("topic delta fourth version", "bucketY"),
    ];
    const result = selectDiverse(items, 4, 1);
    const bucketCounts: Record<string, number> = {};
    for (const item of result) {
      bucketCounts[item.bucket] = (bucketCounts[item.bucket] ?? 0) + 1;
    }
    expect(bucketCounts["bucketX"] ?? 0).toBeLessThanOrEqual(1);
    expect(bucketCounts["bucketY"] ?? 0).toBeLessThanOrEqual(1);
  });

  it("prefers underrepresented buckets", () => {
    const items = [
      makeItem("alpha concept explanation details", "A"),
      makeItem("beta concept explanation details", "A"),
      makeItem("gamma concept explanation details", "A"),
      makeItem("delta unique different topic area", "B"),
    ];
    const result = selectDiverse(items, 2, 2);
    const buckets = result.map((i) => i.bucket);
    // Should pick one from A and one from B for balance
    expect(buckets).toContain("A");
    expect(buckets).toContain("B");
  });

  it("relaxed second pass fills up when first pass starved output", () => {
    // All items are near-duplicates in different buckets with a very low threshold
    const items = [
      makeItem("same words repeated here exactly", "A"),
      makeItem("same words repeated here exactly", "B"),
      makeItem("same words repeated here exactly", "C"),
    ];
    // With simThreshold=0.01, only the first passes dedup in the first pass.
    // The relaxed second pass should bring more in to try to reach targetCount.
    const result = selectDiverse(items, 3, 2, 0.01);
    expect(result.length).toBe(3);
  });

  it("returns empty output for empty input", () => {
    const result = selectDiverse([], 5, 2);
    expect(result).toEqual([]);
  });

  it("returns fewer than targetCount when not enough candidates", () => {
    const items = [
      makeItem("only one item available here", "A"),
    ];
    const result = selectDiverse(items, 5, 3);
    expect(result.length).toBe(1);
  });
});
