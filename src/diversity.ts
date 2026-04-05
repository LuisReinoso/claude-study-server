export const STOPWORDS = new Set([
  // ES
  "el","la","los","las","un","una","unos","unas","de","del","al","a","en","y","o","u","que","qué","como","cómo","por","para","con","sin","sobre","entre","su","sus","se","es","son","ser","fue","era","este","esta","estos","estas","ese","esa","eso","lo","le","les","mi","tu","si","sí","no","más","menos","cuando","cuándo","donde","dónde","porque","pero","también","ya","muy","puede","hacer","tiene","tener"
  ,
  // EN
  "the","a","an","of","to","in","on","at","by","for","with","from","is","are","was","were","be","been","being","it","its","this","that","these","those","and","or","but","not","no","yes","as","if","than","then","so","do","does","did","have","has","had","what","when","where","why","how","which","who","whom","you","your","they","their","them","i","my","we","our"
]);

export function tokenize(s: string): Set<string> {
  return new Set(
    (s || "")
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip accents
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface DiversityItem {
  text: string;
  bucket: string; // archetype or level
  raw: any;
}

/**
 * Greedy MMR-style selection:
 * 1. Drop items whose `text` Jaccard-overlaps an already-kept item by >= simThreshold
 * 2. Respect `maxPerBucket` cap on archetypes/levels while still trying to hit `targetCount`
 * 3. Prefer items from underrepresented buckets when choosing
 */
export function selectDiverse<T extends DiversityItem>(
  items: T[],
  targetCount: number,
  maxPerBucket: number,
  simThreshold: number = 0.55,
): T[] {
  const kept: T[] = [];
  const keptTokens: Set<string>[] = [];
  const bucketCount: Record<string, number> = {};

  // Rank candidates so that bucket-balancing is stable: iterate in original order
  // but score each by (bucketCount for its bucket, position) — lower is better.
  const remaining = items.slice();

  while (kept.length < targetCount && remaining.length > 0) {
    // Pick the candidate whose bucket is currently least represented
    let bestIdx = -1;
    let bestBucketLoad = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const load = bucketCount[remaining[i].bucket] ?? 0;
      if (load < bestBucketLoad) {
        bestBucketLoad = load;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;

    const cand = remaining.splice(bestIdx, 1)[0];
    const bucketLoad = bucketCount[cand.bucket] ?? 0;
    if (bucketLoad >= maxPerBucket) continue; // skip, over quota

    const candTokens = tokenize(cand.text);

    // Reject near-duplicates
    let dup = false;
    for (const kt of keptTokens) {
      if (jaccard(candTokens, kt) >= simThreshold) {
        dup = true;
        break;
      }
    }
    if (dup) continue;

    kept.push(cand);
    keptTokens.push(candTokens);
    bucketCount[cand.bucket] = bucketLoad + 1;
  }

  // Relaxed second pass: if we still don't have enough, re-include dedup-rejects
  // but keep the bucket cap. This prevents returning too few cards when the model
  // produced many near-duplicates but limited variety.
  if (kept.length < targetCount) {
    for (const cand of items) {
      if (kept.length >= targetCount) break;
      if (kept.includes(cand)) continue;
      const bucketLoad = bucketCount[cand.bucket] ?? 0;
      if (bucketLoad >= maxPerBucket) continue;
      kept.push(cand);
      bucketCount[cand.bucket] = bucketLoad + 1;
    }
  }

  return kept;
}
