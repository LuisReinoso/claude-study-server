# claude-study-server

> **Part of the Study Framework** — a small ecosystem of tools designed to work together for evidence-based learning in Obsidian. The framework is made of four independent pieces:
>
> | Component | Role |
> |---|---|
> | [**obsidian-speed-reading**](https://github.com/LuisReinoso/obsidian-speed-reading) | RSVP reader with recall practice, streaks, and session tracking |
> | [**obsidian-study-spaced-repetition**](https://github.com/LuisReinoso/obsidian-study-spaced-repetition) (fork of `st3v3nmw/obsidian-spaced-repetition`) | Review-time flashcard scheduling using `question::answer` notes |
> | [**obsidian-study-quiz**](https://github.com/LuisReinoso/obsidian-study-quiz) (fork of `ECuiDev/obsidian-quiz-generator`) | In-note quiz UI, simplified to use this server as its only provider |
> | **claude-study-server** *(this repo)* | Backend that generates the summaries, flashcards, and quiz questions the plugins consume |
>
> Each piece is independent and can be used on its own. The full framework is grounded in learning-science research (Roediger & Karpicke on retrieval practice, Dunlosky on effective study strategies, Xiao et al. 2023 on LLM-generated educational content, among others).

Self-hosted HTTP backend that turns the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) into a study assistant. Given a chunk of text it returns:

- **Summaries** with key terms and topics (latency-optimized for mobile)
- **Flashcards** (`front`/`back`) that spread across six learning archetypes
- **Quiz questions** (true/false, multiple-choice, fill-in-the-blank, short-answer, matching) spread across Bloom-style cognitive levels

The endpoints are plain JSON-over-HTTP so any client can use them — you don't need the companion Obsidian plugins to benefit from the server.

## Why not just call the Claude API directly from the plugin?

Three reasons:

1. **Auth**: the server uses your Claude Code OAuth token (the one the `claude` CLI already has on your machine), so you don't need a separate Anthropic API key with its own billing.
2. **Quality filtering**: the server over-generates candidates and runs a diversity filter (Jaccard similarity + archetype balancing) before returning them. This counters the "obvious patterns, lack variation" failure mode that [Xiao et al. (BEA 2023)](https://aclanthology.org/2023.bea-1.52/) documented for LLM-generated questions.
3. **Latency shaping**: the `/api/summary` endpoint is tuned for mobile clients (~30 s HTTP timeout) by using Claude Haiku, a tight input trim, and strict output caps.

## Endpoints

All endpoints take JSON and return JSON. `text` must contain at least ~20–30 words.

| Endpoint | Purpose | Model |
|---|---|---|
| `GET /api/health` | Health check | — |
| `POST /api/summary` | Digest + key terms + topics, latency-critical | `claude-haiku-4-5` |
| `POST /api/flashcards` | Front/back cards with archetype tagging | default (Sonnet-class) |
| `POST /api/quiz` | Mixed-type questions with cognitive-level tagging | default (Sonnet-class) |
| `POST /api/generate` | Raw text proxy (no schema, used by obsidian-study-quiz) | default |

### Request shape examples

```bash
curl -X POST http://localhost:3457/api/summary \
  -H "Content-Type: application/json" \
  -d '{"text":"Retrieval practice is a learning technique...","language":"es"}'
```

```bash
curl -X POST http://localhost:3457/api/flashcards \
  -H "Content-Type: application/json" \
  -d '{"text":"...","language":"es","count":6}'
```

```bash
curl -X POST http://localhost:3457/api/quiz \
  -H "Content-Type: application/json" \
  -d '{"text":"...","language":"es","count":5,"types":["multiple-choice","short-answer"]}'
```

### Response shapes

```jsonc
// /api/summary
{
  "summary": "2–3 sentence digest",
  "keyTerms": [{ "term": "...", "definition": "..." }],
  "topics": ["...", "...", "..."]
}

// /api/flashcards
{
  "cards": [
    { "front": "...", "back": "...", "archetype": "application" }
  ]
}

// /api/quiz
{
  "questions": [
    { "type": "multiple-choice", "question": "...", "options": ["a","b","c","d"], "answer": 0, "level": "analyze" }
  ]
}
```

## Flashcard archetypes

The server requires every card to be tagged with one of these six archetypes and enforces an even spread across them via a post-hoc diversity filter:

| Archetype | Probe |
|---|---|
| `application` | When would you use this? |
| `discrimination` | How does A differ from B? |
| `causal` | Why does this work? |
| `transfer` | How would this apply to a new situation? |
| `counterexample` | Where does this fail? |
| `consequence` | What follows if this is true? |

Trivial "definition" cards (`What is X?` → `X is...`) are explicitly forbidden in the prompt.

## Quiz cognitive levels

Questions are required to spread across four Bloom-inspired levels:

| Level | Probe |
|---|---|
| `understand` | Paraphrase / explain in own words |
| `apply` | Use the idea in a new situation |
| `analyze` | Compare, contrast, find assumptions |
| `evaluate` | Judge a claim, find a flaw |

## Requirements

- Node.js 18+
- `pnpm` (or `npm` / `yarn`)
- A Claude Code OAuth token (set `CLAUDE_CODE_OAUTH_TOKEN` or install the `claude` CLI and sign in)

## Install & run

```bash
git clone <this-repo>
cd claude-study-server
pnpm install
pnpm run build

# Configure your token (one of):
cp .env.example .env
# then edit .env and set CLAUDE_CODE_OAUTH_TOKEN=...

# OR export it directly in your shell:
export CLAUDE_CODE_OAUTH_TOKEN="<your-token>"

pnpm start
```

By default the server listens on `http://0.0.0.0:3457`. Change with `STUDY_SERVER_PORT` in `.env`.

### Accessing from Obsidian mobile

The server binds to `0.0.0.0`, so any device on the same network can reach it. For cross-network access (e.g. Obsidian on mobile + server on a home machine) the recommended setup is [Tailscale](https://tailscale.com/): install it on both devices, point the Obsidian plugin at the server's Tailscale IP, and you're done.

## Running as a systemd service (Linux)

A template unit file ships in `claude-study-server.service`. Copy it and fill in the two placeholders (`<USER>`, `<INSTALL>`):

```bash
sudo cp claude-study-server.service /etc/systemd/system/
sudo sed -i "s|<USER>|$USER|; s|<INSTALL>|$PWD|" /etc/systemd/system/claude-study-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now claude-study-server
```

## Configuration reference

| Env var | Default | Purpose |
|---|---|---|
| `STUDY_SERVER_PORT` | `3457` | HTTP port |
| `CLAUDE_CODE_OAUTH_TOKEN` | *(required)* | Read by the Claude Agent SDK |
| `CLAUDE_STUDY_TOKEN_VAR` | *(unset)* | Name of an env var to copy into `CLAUDE_CODE_OAUTH_TOKEN` at startup (for users who keep the token under a namespaced variable) |

## How the diversity filter works

Both `/api/flashcards` and `/api/quiz` over-generate by 1.5×, then use a greedy selection pass to:

1. Reject near-duplicates by computing Jaccard similarity on content-word tokens (Spanish + English stopwords filtered, accents normalized). Items sharing ≥ 55% of tokens with an already-kept item are dropped.
2. Enforce a cap of `ceil(count / N) + 1` per bucket (archetype or level), choosing from the currently least-represented bucket at each step.
3. Do a relaxed second pass if the first pass starved the output — only the bucket cap is enforced the second time.

The result is tagged back out to the client without the archetype/level fields leaking into the consumer's data model (though they are included for clients that want them).

## Latency budget for `/api/summary`

Measured on a 20 KB Spanish chapter:

| Configuration | Latency |
|---|---|
| Sonnet, `maxTurns: 3`, 50 KB input cap, verbose prompt | ~36 s (too slow for Android's ~30 s socket limit) |
| Haiku, `maxTurns: 2`, 15 KB input | ~24 s |
| Haiku, `maxTurns: 2`, 8 KB head/tail trim, output caps in prompt | **~12 s** |

The trim function keeps the first 70 % and last 30 % of the text (intro + conclusion — the highest-signal regions for a pre-reading digest).

## License

MIT — see [LICENSE](./LICENSE).
