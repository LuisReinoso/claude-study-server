import { query } from "@anthropic-ai/claude-agent-sdk";
import express from "express";
import cors from "cors";
import { trimForSummary } from "./trim";
import { STOPWORDS, tokenize, jaccard, selectDiverse, DiversityItem } from "./diversity";

// The Claude Agent SDK reads CLAUDE_CODE_OAUTH_TOKEN from the environment.
// If you keep your token under a namespaced variable (e.g. per-profile setups
// like CLAUDE_CODE_OAUTH_TOKEN_PERSONAL / _WORK), set CLAUDE_STUDY_TOKEN_VAR
// to that name and it will be mapped into CLAUDE_CODE_OAUTH_TOKEN here.
const tokenVarName = process.env.CLAUDE_STUDY_TOKEN_VAR;
if (tokenVarName && process.env[tokenVarName] && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = process.env[tokenVarName];
}

if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.warn(
    "WARNING: CLAUDE_CODE_OAUTH_TOKEN is not set. Requests will fail until you " +
    "export it (or set CLAUDE_STUDY_TOKEN_VAR to point to your custom env var).",
  );
}

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

// ===== CLAUDE HELPERS =====

interface AskOptions {
  enableWebSearch?: boolean;
  model?: string;
  maxTurns?: number;
}

async function askClaudeJson(
  systemPrompt: string,
  userMessage: string,
  schema: any,
  opts: AskOptions = {},
): Promise<any> {
  const { enableWebSearch = false, model, maxTurns } = opts;
  const messages: any[] = [];

  // Default turn counts: web search needs more turns, JSON-schema responses
  // typically resolve in one turn. Callers can override for latency tuning.
  const resolvedMaxTurns = maxTurns ?? (enableWebSearch ? 6 : 2);

  const queryOptions: any = {
    maxTurns: resolvedMaxTurns,
    allowedTools: enableWebSearch ? ["WebSearch", "WebFetch"] : [],
    systemPrompt: enableWebSearch
      ? systemPrompt + "\n\nYou have access to web search. Use it to VERIFY facts and enrich answers with current, accurate information when needed."
      : systemPrompt,
    outputFormat: {
      type: "json_schema",
      schema,
    },
  };
  if (model) queryOptions.model = model;

  for await (const message of query({
    prompt: userMessage,
    options: queryOptions,
  })) {
    messages.push(message);
  }

  // Check for structured_output in result messages (JSON schema mode)
  for (const msg of messages) {
    if (msg.type === "result" && msg.structured_output) {
      return msg.structured_output;
    }
  }

  // Fallback: parse text
  const text = extractText(messages);
  return parseJsonFromText(text);
}

function parseJsonFromText(text: string): any {
  try { return JSON.parse(text.trim()); } catch {}
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlock) { try { return JSON.parse(codeBlock[1]); } catch {} }
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) { try { return JSON.parse(jsonMatch[0]); } catch {} }
  throw new Error("Could not parse JSON from response");
}

async function askClaudeText(systemPrompt: string, userMessage: string): Promise<string> {
  const messages: any[] = [];

  for await (const message of query({
    prompt: userMessage,
    options: {
      maxTurns: 1,
      allowedTools: [],
      systemPrompt,
    },
  })) {
    messages.push(message);
  }

  return extractText(messages);
}

function extractText(messages: any[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg?.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) parts.push(block.text);
      }
    }
    if (msg?.content) {
      if (typeof msg.content === "string") parts.push(msg.content);
      else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text" && block.text) parts.push(block.text);
        }
      }
    }
    if (msg?.result?.text) parts.push(msg.result.text);
  }
  return parts.join("");
}

function extractAndParse(messages: any[]): any {
  const text = extractText(messages);
  const match = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[1] || match[0]);
  return JSON.parse(text);
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
- If you use web search to verify, include the verified information in the answer

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
${language !== "en" ? `Write in ${language}.` : ""}`;
}

// ===== ENDPOINTS =====

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", sdk: "claude-agent-sdk", jsonMode: true });
});

// Generic proxy - used by quiz-generator plugin (no JSON schema, returns raw text)
app.post("/api/generate", async (req, res) => {
  try {
    const { system, userMessage } = req.body;
    if (!userMessage) { res.status(400).json({ error: "userMessage is required" }); return; }

    const text = await askClaudeText(system || "", userMessage);
    res.json({ text, stopReason: "end_turn" });
  } catch (err: any) {
    console.error("Generate error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Over-generation factor for diversity filtering. 1.5x gives the dedup step room
// to prune near-duplicates without starving the final output.
const OVERGEN_FACTOR = 1.5;

app.post("/api/quiz", async (req, res) => {
  try {
    const { text, language = "es", types = ["true-false", "multiple-choice", "short-answer"], count = 5 } = req.body;
    if (!text?.trim()) { res.status(400).json({ error: "Quiz: No text provided. Send text in the request body." }); return; }
    if (text.trim().split(/\s+/).length < 30) { res.status(400).json({ error: `Quiz: Text too short (${text.trim().split(/\s+/).length} words). Need at least 30 words.` }); return; }

    const overCount = Math.ceil(count * OVERGEN_FACTOR);
    const result = await askClaudeJson(
      quizSystemPrompt(language, types, overCount),
      `Generate quiz questions about:\n\n${text.substring(0, 50000)}`,
      quizSchema
    );

    const rawQuestions: any[] = Array.isArray(result?.questions) ? result.questions : [];
    const items: DiversityItem[] = rawQuestions.map((q) => ({
      text: String(q.question ?? ""),
      bucket: String(q.level ?? "understand"),
      raw: q,
    }));
    const maxPerLevel = Math.max(1, Math.ceil(count / QUIZ_LEVELS.length) + 1);
    const kept = selectDiverse(items, count, maxPerLevel);
    const questions = kept.map((it) => it.raw);

    console.log(`[quiz] requested=${count} generated=${rawQuestions.length} kept=${questions.length}`);
    res.json({ questions });
  } catch (err: any) {
    console.error("Quiz error:", err.message);
    res.status(500).json({ error: `Quiz generation failed: ${err.message}` });
  }
});

app.post("/api/flashcards", async (req, res) => {
  try {
    const { text, language = "es", count = 10 } = req.body;
    if (!text?.trim()) { res.status(400).json({ error: "Flashcards: No text provided." }); return; }
    if (text.trim().split(/\s+/).length < 30) { res.status(400).json({ error: `Flashcards: Text too short (${text.trim().split(/\s+/).length} words). Need at least 30 words.` }); return; }

    const overCount = Math.ceil(count * OVERGEN_FACTOR);
    const result = await askClaudeJson(
      flashcardsSystemPrompt(language, overCount),
      `Generate flashcards from:\n\n${text.substring(0, 50000)}`,
      flashcardsSchema,
      { enableWebSearch: true }, // verify facts & enrich answers
    );

    const rawCards: any[] = Array.isArray(result?.cards) ? result.cards : [];
    const items: DiversityItem[] = rawCards.map((c) => ({
      text: String(c.front ?? ""),
      bucket: String(c.archetype ?? "application"),
      raw: c,
    }));
    const maxPerArchetype = Math.max(1, Math.ceil(count / FLASHCARD_ARCHETYPES.length) + 1);
    const kept = selectDiverse(items, count, maxPerArchetype);
    const cards = kept.map((it) => it.raw);

    console.log(`[flashcards] requested=${count} generated=${rawCards.length} kept=${cards.length}`);
    res.json({ cards });
  } catch (err: any) {
    console.error("Flashcards error:", err.message);
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
    // from mobile, where HTTP clients enforce ~30s socket timeouts. We:
    //   1. Use Haiku (3-5x faster than Sonnet/Opus) — quality is fine for digests
    //   2. Cap input at 8K chars via 70/30 head/tail trim (preserve intro + conclusion)
    //   3. Minimize turns. maxTurns=2 is the practical floor for the Agent SDK —
    //      one turn to generate, one to emit the structured result.
    const trimmed = trimForSummary(text, 5000);
    const result = await askClaudeJson(
      summarySystemPrompt(language),
      `Summarize:\n\n${trimmed}`,
      summarySchema,
      { model: "claude-haiku-4-5", maxTurns: 2 },
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
  console.log(`Using: Claude Agent SDK (OAuth token + JSON schema mode)`);
  console.log(`Endpoints: /api/health, /api/generate, /api/quiz, /api/flashcards, /api/summary`);
});
