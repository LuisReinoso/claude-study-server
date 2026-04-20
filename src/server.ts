import express from "express";
import cors from "cors";
import { trimForSummary } from "./trim";
import { STOPWORDS, tokenize, jaccard, selectDiverse, DiversityItem } from "./diversity";

// Backend: Ollama daemon on localhost. This replaces the Claude Agent SDK,
// which spawned the `claude` CLI as a subprocess — a model that is fragile
// when the service runs under systemd (PATH / HOME / config-dir issues, no
// TTY, env-var divergence between user shell and daemon). Ollama exposes an
// HTTP API on localhost:11434 that transparently handles both local and
// cloud models (cloud models are authenticated once via `ollama signin` and
// routed through the same local endpoint). No API keys are stored in this
// service — only the model name matters.
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "glm-5.1:cloud";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const PORT = parseInt(process.env.STUDY_SERVER_PORT || "3457", 10);

// ===== JSON SCHEMAS =====

// Quiz cognitive levels — Bloom-inspired, enforced the same way as flashcard
// archetypes. Makes the model spread across reasoning depths instead of
// defaulting to surface-level recall (Xiao 2023 "Useful" / "Suitable" gap).
const QUIZ_LEVELS = [
  "understand",  // paraphrase, explain in own words
  "apply",       // use the idea in a new situation
  "analyze",     // compare, contrast, identify assumption
  "evaluate",    // judge a claim, detect a flaw
] as const;

const quizSchema = {
  type: "object" as const,
  properties: {
    questions: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          type: { type: "string" as const },
          question: { type: "string" as const },
          answer: {},
          options: { type: "array" as const, items: { type: "string" as const } },
          level: {
            type: "string" as const,
            enum: QUIZ_LEVELS as unknown as string[],
          },
        },
        required: ["type", "question", "answer", "level"] as const,
      },
    },
  },
  required: ["questions"] as const,
};

// Card archetypes — enforced by prompt AND validated post-hoc to ensure variety.
// Grounded in Xiao et al. (BEA 2023), who found that ungrounded LLM-generated
// questions exhibit "obvious patterns, too straightforward, lack variation".
// Requiring explicit archetype tagging pushes the model toward diverse cognitive
// operations (Bloom-style: apply, discriminate, explain, transfer, contrast, edge case).
const FLASHCARD_ARCHETYPES = [
  "application",    // when would you use this?
  "discrimination", // how is A different from B?
  "causal",         // why does this work?
  "transfer",       // how would this apply to a new situation?
  "counterexample", // where does this fail / its limit?
  "consequence",    // what follows if this is true?
] as const;

const flashcardsSchema = {
  type: "object" as const,
  properties: {
    cards: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          front: { type: "string" as const },
          back: { type: "string" as const },
          archetype: {
            type: "string" as const,
            enum: FLASHCARD_ARCHETYPES as unknown as string[],
          },
        },
        required: ["front", "back", "archetype"] as const,
      },
    },
  },
  required: ["cards"] as const,
};

const summarySchema = {
  type: "object" as const,
  properties: {
    summary: { type: "string" as const },
    keyTerms: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          term: { type: "string" as const },
          definition: { type: "string" as const },
        },
        required: ["term", "definition"] as const,
      },
    },
    topics: { type: "array" as const, items: { type: "string" as const } },
  },
  required: ["summary", "keyTerms", "topics"] as const,
};

// ===== OLLAMA HELPERS =====

/**
 * Extracts a JSON object from a model response. Ollama's `format: "json"`
 * already guarantees valid JSON, but some models still wrap it in markdown
 * fences. This helper strips fences and falls back to bracket-matching.
 */
function parseJsonFromText(text: string): any {
  if (!text) throw new Error("Empty response from model");
  try { return JSON.parse(text.trim()); } catch {}
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlock) { try { return JSON.parse(codeBlock[1]); } catch {} }
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) { try { return JSON.parse(jsonMatch[0]); } catch {} }
  throw new Error("Could not parse JSON from response");
}

/**
 * Single HTTP call to the local Ollama daemon's chat endpoint. No SDK, no
 * subprocess, no multi-turn loop. `format: "json"` tells Ollama to constrain
 * the output to valid JSON. For cloud models (e.g. `glm-5.1:cloud`), the
 * daemon transparently proxies to ollama.com using credentials established
 * once via `ollama signin` — no API key is needed in this service.
 */
async function askOllamaJson(
  systemPrompt: string,
  userMessage: string,
  model: string = OLLAMA_MODEL,
): Promise<any> {
  const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      options: { temperature: 0.7 },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Ollama ${resp.status}: ${body.substring(0, 300)}`);
  }

  const data: any = await resp.json();
  const text: string = data?.message?.content ?? "";
  return parseJsonFromText(text);
}

/**
 * Free-form text generation via Ollama (no JSON constraint). Used by the
 * legacy /api/generate proxy endpoint that the quiz plugin calls directly.
 */
async function askOllamaText(
  systemPrompt: string,
  userMessage: string,
  model: string = OLLAMA_MODEL,
): Promise<string> {
  const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature: 0.7 },
      messages: [
        ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Ollama ${resp.status}: ${body.substring(0, 300)}`);
  }

  const data: any = await resp.json();
  return data?.message?.content ?? "";
}

// ===== DIVERSITY / OVER-GENERATE + RANK =====
//
// The BEA 2023 paper (Xiao et al.) found that LLM-generated educational
// questions score lower than human-written ones on "Useful" (3.25 vs 3.93)
// and "Suitable" (3.48 vs 3.92) dimensions, with reviewers noting "obvious
// patterns, too straightforward, lack variation". Teachers had to curate
// before assigning.
//
// To counter this without adding a curation UI, the server over-generates
// candidates (1.5x the requested count), then filters for diversity along
// two axes: (a) semantic overlap via Jaccard similarity on content-word
// tokens, (b) even spread across archetypes / cognitive levels. The top
// `count` cards that survive both filters are returned.
//
// Implementation extracted to ./diversity.ts (tokenize, jaccard, selectDiverse).

// ===== PROMPTS =====

function quizSystemPrompt(language: string, types: string[], count: number): string {
  const typeDescriptions: Record<string, string> = {
    "true-false": `True/False: { "type": "true-false", "question": "...", "answer": true/false }`,
    "multiple-choice": `Multiple Choice (4 options): { "type": "multiple-choice", "question": "...", "options": ["a","b","c","d"], "answer": 0 } (answer is index)`,
    "fill-in-the-blank": "Fill in the Blank: { \"type\": \"fill-in-the-blank\", \"question\": \"The ____ is...\", \"answer\": [\"missing word\"] }",
    "short-answer": `Short Answer: { "type": "short-answer", "question": "...", "answer": "..." }`,
    "matching": `Matching (3-8 pairs): { "type": "matching", "question": "Match...", "answer": [{"leftOption":"...","rightOption":"..."}] }`,
  };

  const enabledTypes = types
    .filter((t) => typeDescriptions[t])
    .map((t) => typeDescriptions[t])
    .join("\n");

  // Target distribution: spread across cognitive levels as evenly as possible.
  const maxPerLevel = Math.max(1, Math.ceil(count / QUIZ_LEVELS.length) + 1);

  return `You are an expert study assistant. Generate exactly ${count} comprehension questions.

PURPOSE: Test if the reader UNDERSTOOD the text, not if they memorized it. Questions should reveal gaps in understanding.

COGNITIVE DIVERSITY IS MANDATORY. Each question MUST be tagged with a "level":
- "understand": paraphrase or explain the idea in different words
- "apply": use the idea in a new situation not mentioned in the text
- "analyze": compare ideas, identify an assumption, or break apart a claim
- "evaluate": judge a position, find a flaw, or weigh trade-offs

STRICT DISTRIBUTION RULE: NO MORE THAN ${maxPerLevel} questions per "level" in your output. Fail this rule and the output is invalid.

RULES:
- Ask "why" and "how" questions, not "what" or "who"
- Test understanding of arguments, reasoning, and connections — not isolated facts
- NEVER ask two questions that probe the same idea with different wording
- For multiple choice: wrong options should represent common MISUNDERSTANDINGS, not random wrong answers
- For true/false: use statements that are subtly wrong in their reasoning, not obviously false
- For short answer: ask the reader to explain, connect, or apply — not recite

GOOD: "¿Por qué el autor argumenta que pensar es una técnica y no un talento?" (level: analyze)
BAD: "¿En qué ciudad nació el autor?" (level: surface recall — forbidden)

Mix these question formats:
${enabledTypes}

OUTPUT FORMAT: { "questions": [ { "type": "...", "question": "...", "answer": ..., "level": "..." }, ... ] }
The root key MUST be "questions".

${language !== "en" ? `Generate all content in ${language}.` : ""}`;
}

function flashcardsSystemPrompt(language: string, count: number): string {
  // Target distribution across archetypes: aim for an even spread, allow +1 slack.
  const maxPerArchetype = Math.max(1, Math.ceil(count / FLASHCARD_ARCHETYPES.length) + 1);

  return `You are an expert study assistant. Generate exactly ${count} flashcards for LONG-TERM knowledge retention.

PHILOSOPHY: The reader wants to APPLY what they learn, not memorize trivia. Each card should change how they think or act.

ARCHETYPE DIVERSITY IS MANDATORY. Every card MUST be tagged with exactly one "archetype":
- "application": "¿Cuándo aplicarías X?" / "¿En qué situación usarías X?"
- "discrimination": "¿Cuál es la diferencia clave entre A y B?" / "¿En qué se distingue X de lo que podría confundirse con él?"
- "causal": "¿Por qué funciona X?" / "¿Qué hace que X sea efectivo?"
- "transfer": "¿Cómo aplicarías X a [dominio nuevo]?" / "¿Qué cambiarías en [situación real] usando X?"
- "counterexample": "¿Dónde falla X?" / "¿Cuál es una excepción a X?"
- "consequence": "¿Qué implica que X sea verdadero?" / "¿Qué se deduce de X?"

STRICT DISTRIBUTION RULE: NO MORE THAN ${maxPerArchetype} cards per archetype. Spread across at least 3 different archetypes if count >= 4. Fail this rule and the output is invalid.

DIVERSITY CHECK: Before finalizing, re-read your cards. If any two fronts probe the SAME idea (even with different words), replace one of them with a card from an unused archetype.

NEVER generate:
- Trivial definition cards ("¿Qué es X?" → "X es...") — archetype "recall" is forbidden
- Cards answerable without reading the text
- Cards about names, dates, or facts that don't change behavior
- Two cards that share >60% of content words in their fronts

Keep answers under 2 sentences. Focus on the ONE insight per card that matters in 6 months.

ENRICHMENT RULES:
- Use the text as PRIMARY source for card topics
- ENRICH answers with your own knowledge to add depth and accuracy
- If the text contains outdated information, use CURRENT knowledge instead
- If you can add a practical example or modern context, do it
- NEVER fabricate facts you're not confident about — accuracy is critical

OUTPUT FORMAT: { "cards": [ { "front": "...", "back": "...", "archetype": "..." }, ... ] }
The root key MUST be "cards".

${language !== "en" ? `Generate all content in ${language}.` : ""}`;
}

function summarySystemPrompt(language: string): string {
  // Tight output caps: this endpoint is latency-critical (mobile, ~30s socket
  // budget). Fewer output tokens = lower end-to-end time. The caps are enforced
  // in the prompt because JSON schemas don't support maxItems in this SDK's
  // output_format path.
  return `You are a study assistant. Create a COMPACT pre-reading summary.

STRICT OUTPUT LIMITS (for latency — the user is on mobile with a tight socket budget):
- "summary": 2-3 sentences maximum. No more.
- "keyTerms": EXACTLY 3 items. Each definition ≤ 1 sentence.
- "topics": EXACTLY 3 items. Each ≤ 8 words.

Focus on the highest-signal concepts only. Skip filler.

OUTPUT FORMAT: { "summary": "...", "keyTerms": [ { "term": "...", "definition": "..." } ], "topics": ["..."] }
The root keys MUST be "summary", "keyTerms", "topics".

${language !== "en" ? `Write in ${language}.` : ""}`;
}

// ===== ENDPOINTS =====

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", backend: "ollama", model: OLLAMA_MODEL, host: OLLAMA_HOST });
});

// Generic proxy - used by quiz-generator plugin (no JSON schema, returns raw text)
app.post("/api/generate", async (req, res) => {
  try {
    const { system, userMessage } = req.body;
    if (!userMessage) { res.status(400).json({ error: "userMessage is required" }); return; }

    const text = await askOllamaText(system || "", userMessage);
    res.json({ text, stopReason: "end_turn" });
  } catch (err: any) {
    console.error("Generate error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// All endpoints are mobile-critical: Android kills HTTP sockets at ~10-20s.
// Every endpoint trims input to 5K via trimForSummary (70/30 head/tail split)
// and over-generates by 1.25x. Quality comes from prompt engineering + the
// diversity filter, not model size. With Ollama the latency is dominated by
// the model itself, not SDK overhead — a single HTTP round-trip to the local
// daemon, which proxies to the cloud when the model has a `:cloud` suffix.
const OVERGEN_FACTOR = 1.25;
const INPUT_TRIM = 5000;

app.post("/api/quiz", async (req, res) => {
  const started = Date.now();
  try {
    const { text, language = "es", types = ["true-false", "multiple-choice", "short-answer"], count = 5 } = req.body;
    if (!text?.trim()) { res.status(400).json({ error: "Quiz: No text provided. Send text in the request body." }); return; }
    if (text.trim().split(/\s+/).length < 30) { res.status(400).json({ error: `Quiz: Text too short (${text.trim().split(/\s+/).length} words). Need at least 30 words.` }); return; }

    const overCount = Math.ceil(count * OVERGEN_FACTOR);
    const trimmed = trimForSummary(text, INPUT_TRIM);
    const result = await askOllamaJson(
      quizSystemPrompt(language, types, overCount),
      `Generate quiz questions about:\n\n${trimmed}`,
    );

    const rawQuestions: any[] = Array.isArray(result?.questions) ? result.questions
      : Array.isArray(result?.quiz) ? result.quiz : [];
    const items: DiversityItem[] = rawQuestions.map((q) => ({
      text: String(q.question ?? ""),
      bucket: String(q.level ?? "understand"),
      raw: q,
    }));
    const maxPerLevel = Math.max(1, Math.ceil(count / QUIZ_LEVELS.length) + 1);
    const kept = selectDiverse(items, count, maxPerLevel);
    const questions = kept.map((it) => it.raw);

    console.log(`[quiz] requested=${count} generated=${rawQuestions.length} kept=${questions.length} elapsedMs=${Date.now() - started}`);
    res.json({ questions });
  } catch (err: any) {
    console.error("Quiz error:", err.message, `elapsedMs=${Date.now() - started}`);
    res.status(500).json({ error: `Quiz generation failed: ${err.message}` });
  }
});

app.post("/api/flashcards", async (req, res) => {
  const started = Date.now();
  try {
    const { text, language = "es", count = 10 } = req.body;
    if (!text?.trim()) { res.status(400).json({ error: "Flashcards: No text provided." }); return; }
    if (text.trim().split(/\s+/).length < 30) { res.status(400).json({ error: `Flashcards: Text too short (${text.trim().split(/\s+/).length} words). Need at least 30 words.` }); return; }

    const overCount = Math.ceil(count * OVERGEN_FACTOR);
    const trimmed = trimForSummary(text, INPUT_TRIM);
    const result = await askOllamaJson(
      flashcardsSystemPrompt(language, overCount),
      `Generate flashcards from:\n\n${trimmed}`,
    );

    const rawCards: any[] = Array.isArray(result?.cards) ? result.cards
      : Array.isArray(result?.flashcards) ? result.flashcards : [];
    const items: DiversityItem[] = rawCards.map((c) => ({
      text: String(c.front ?? ""),
      bucket: String(c.archetype ?? "application"),
      raw: c,
    }));
    const maxPerArchetype = Math.max(1, Math.ceil(count / FLASHCARD_ARCHETYPES.length) + 1);
    const kept = selectDiverse(items, count, maxPerArchetype);
    const cards = kept.map((it) => it.raw);

    console.log(`[flashcards] requested=${count} generated=${rawCards.length} kept=${cards.length} elapsedMs=${Date.now() - started}`);
    res.json({ cards });
  } catch (err: any) {
    console.error("Flashcards error:", err.message, `elapsedMs=${Date.now() - started}`);
    res.status(500).json({ error: `Flashcard generation failed: ${err.message}` });
  }
});

// trimForSummary extracted to ./trim.ts

app.post("/api/summary", async (req, res) => {
  const started = Date.now();
  try {
    const { text, language = "es" } = req.body;
    if (!text?.trim()) { res.status(400).json({ error: "Summary: No text provided." }); return; }
    if (text.trim().split(/\s+/).length < 20) { res.status(400).json({ error: `Summary: Text too short (${text.trim().split(/\s+/).length} words). Need at least 20 words.` }); return; }

    // Summary is latency-critical: it blocks the pre-reading flow and is called
    // from mobile, where HTTP clients enforce ~10-20s socket timeouts. With
    // Ollama the daemon handles model + cloud routing in a single round trip.
    const trimmed = trimForSummary(text, INPUT_TRIM);
    const result = await askOllamaJson(
      summarySystemPrompt(language),
      `Summarize:\n\n${trimmed}`,
    );
    console.log(`[summary] bytesIn=${text.length} bytesSent=${trimmed.length} elapsedMs=${Date.now() - started}`);
    res.json(result);
  } catch (err: any) {
    console.error("Summary error:", err.message, `elapsedMs=${Date.now() - started}`);
    res.status(500).json({ error: `Summary generation failed: ${err.message}` });
  }
});

// ===== START =====

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Claude Study Server running on http://0.0.0.0:${PORT}`);
  console.log(`Backend: Ollama at ${OLLAMA_HOST}, default model: ${OLLAMA_MODEL}`);
  console.log(`Endpoints: /api/health, /api/generate, /api/quiz, /api/flashcards, /api/summary`);
});
