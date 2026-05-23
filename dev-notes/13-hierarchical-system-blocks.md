# Hierarchical system blocks ("topics")

Design notes for promoting `data/chatbots/<slug>/` from a flat directory to a topic-aware tree, with a runtime mechanism for the LLM to request additional reference material on demand. Captured 2026-05-23.

**Status:** design-in-flight. Targeted at **v1.1.0** (post-first-customer). Capturing now so the design exists before the first customer pressure-tests whether flat blocks are sufficient.

Companion to:

- [`04-system-blocks.md`](04-system-blocks.md) — current flat-blocks design
- [`11-budget-handoff.md`](11-budget-handoff.md) — M20's `extraBlocks` mechanism, which this design extends
- [`00-project-tracker.md`](00-project-tracker.md) — milestones; this lands post-pivot

---

## Motivation

The flat-blocks model assembles every `.md` file under `data/chatbots/<slug>/` into the system prompt on every `POST /chat`. That's fine for a chatbot with a handful of short blocks against a wide-context model (Haiku at 200k tokens). It falls apart in two distinct ways:

1. **Tight-context providers (Pi/Ollama).** A 4k-token window forces operator discipline that doesn't scale beyond a few topics. Real product catalogues, FAQ banks, or branch listings can't all fit, so the operator has to either pick the most-likely-needed subset (and lose coverage) or upgrade to a wider-context provider (and lose the self-hosted story).
2. **Metered providers.** Even with a 200k window, every conversation pays for the full system prompt on every turn. For a chatbot with 50k tokens of product info, that's most of the bill — and most of the content isn't relevant to any given conversation.

The conventional answer is RAG (embed everything, vector-search at request time, retrieve the top-K chunks). It works but it brings: an embedding store to operate, a chunk-retrieval policy to tune, an opaque "why didn't it find X" failure mode, and a re-embedding cost when content changes. For a pre-sales bot whose operator knows the content structure up-front, that's overkill.

This design is **RAG-without-vectors**: the operator organises content into named topics with short summaries; the LLM picks topics by name from a table-of-contents instead of cosine-similarity over embeddings. Deterministic, debuggable, no embedding store.

---

## Shape

The directory under `data/chatbots/<slug>/` becomes a one-level tree:

```
data/chatbots/headwall-devx/
├── 10-overview.md             ← always included
├── 20-demos.md                ← always included
├── HANDOFF_SOFT.md            ← M20 reserved; conditional inject
├── HANDOFF_HARD.md            ← M20 reserved; response body on terminate
└── products/                  ← a topic
    ├── README.md              ← always included (the topic summary)
    ├── thingy-me-bob.md       ← only included when topic is active
    └── doohicky.md            ← only included when topic is active
```

Two zones of content:

- **Always included** in every request:
  - Top-level `.md` files (existing flat-blocks behaviour, unchanged).
  - Each subdirectory's `README.md`, treated as the topic's summary. These collectively form a table-of-contents the LLM uses to decide what to load.
- **Conditionally included** when the LLM has requested the topic and the topic is still active for the session:
  - All other `.md` files inside the subdirectory.

The set of available topic names is implicit in the directory structure — no separate registry.

---

## Mechanism

### How the LLM requests a topic

The LLM emits a tagged token anywhere in its reply:

```
<load-topic>products/doohicky</load-topic>
```

The chat adapter parses the token out of the reply text, strips it from the visible reply (so the visitor never sees it), validates the topic path against what exists on disk, and writes it into the session's active-topics list. The validated reply text plus a stripped flag is what gets persisted to the messages table and returned to the widget.

**The topic is loaded on the *next* turn, not the current one.** This is the key non-tool-use property:

- Same-turn loading would require a second LLM call (load topic → re-prompt with new context → get the *real* answer). That's an agentic loop; we don't want it.
- Next-turn loading also encourages naturally conversational behaviour: the model says something like "I'd be happy to tell you about the doohicky — what would you like to know?" and on the visitor's next message, the doohicky's full content is in context.

If the LLM emits multiple `<load-topic>` tags in one reply, all of them activate for the next turn (subject to the active-topic cap; see open questions).

### Topic-index injection

A new auto-generated block, always present after the always-included top-level files, lists every available topic and its README content. Conceptually:

```
<block name="topics-index">
The following topics are available. To load a topic's full content for the
next turn, emit <load-topic>topic-name</load-topic> in your reply.

## products
[content of data/chatbots/<slug>/products/README.md]

## branches
[content of data/chatbots/<slug>/branches/README.md]
</block>
```

This is the cost-shape ceiling for the always-included prefix. Operator discipline: keep READMEs short — title + 1–2 paragraphs of what's behind the topic.

### Session state

Active topics are persisted on the session row:

```
sessions.active_topics  JSON NULL   -- ordered list of topic names
```

JSON column (not a join table) because topics are short strings, capped per session, and we never query across them relationally.

### Composition with M20

The chat path already has `extraBlocks` (M20, for HANDOFF_SOFT injection) — this design extends the same mechanism. On every `POST /chat`:

1. Load top-level disk blocks (existing).
2. Build the topic-index block from each subdir's README.
3. For each currently-active topic, load every `.md` file in that subdir except README.
4. Call `assemblePrompt({ persona, diskBlocks, extraBlocks: [topicIndex, ...activeTopics, ...handoffSoftIfApplicable] })`.

### Anthropic prompt-caching interplay

This design is *cache-friendly*: the stable prefix (handling rule + persona + top-level + topic-index) is the same on every turn within a session, so it caches cleanly. Active topics append after the cached prefix and shift over time, but the cache savings come from the heavy stable bulk above, not the dynamic tail.

---

## Open design questions (settle during the v1.1 implementation pass)

1. **Topic lifecycle / eviction.** Persist for the whole session vs FIFO eviction after N active topics vs auto-evict after K turns of disuse. **Lean:** FIFO cap (e.g. `max_active_topics` per chatbot, default 3) — simple, predictable, lets the LLM rotate focus without runaway context bloat. Disuse-eviction is harder to reason about.
2. **Nesting depth.** One level (subdir = topic) vs arbitrary nesting (e.g. `products/widgets/blue.md`). **Lean:** one level. Operators who need deeper hierarchy can use prefix conventions inside the topic (`products/blue-widget.md`).
3. **Topic-name pattern.** Currently disk-block names match `^[A-Za-z0-9_-]+$`. Topic names should be the subdir name with the same pattern. The full reference is `<subdir>/<basename>` with a `/` separator. The validator extends to `^[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)?$`.
4. **Empty subdirectories / missing README.** Empty subdir: skip silently (consistent with flat-blocks empty-file handling). Missing README inside a populated subdir: log a warning + still expose the topic in the index with a "(no description)" placeholder. **Lean:** require README; refuse to expose the topic without one. Forces operator discipline; the README is the LLM's only way to know whether the topic is relevant.
5. **Reserved names in subdirs.** Should `PERSONA.md` / `HANDOFF_SOFT.md` / `HANDOFF_HARD.md` be reserved inside topic subdirs too? **Lean:** no — those names only have meaning at the top level. A `products/HANDOFF_SOFT.md` would be a perfectly ordinary topic file (though weirdly named — operator's call).
6. **CLI surface.** `sw blocks list <slug>` becomes tree-aware: shows the tree with always-included markers and per-file token estimates. New flags: `--topic <name>` to preview what loads when a single topic is active; `--all-topics` to preview the maximally-active state. No `sw chatbot topics activate <slug> <topic>` command — activation is a runtime/per-session concern, not an operator one.
7. **HTTP / admin surface.** Does the admin API need to expose the topic list? Probably not — `GET /admin/chatbots/{slug}/blocks` already lists files; making it tree-aware is the smallest extension. No need for separate `/topics` routes.
8. **Adapter token-parsing seam.** The `<load-topic>` parsing logic should live alongside any future "structured response affordances" (buttons, URL suggestions) — they share a need for "LLM emits a tagged token; adapter strips it; server acts on it." **Lean:** ship a small reply-postprocessor module (`src/services/reply-postprocess.ts`) that the chat path runs over every assistant reply before persisting. The first user is `<load-topic>`; future users land here too.
9. **Visibility to the visitor.** If the LLM emits a malformed `<load-topic>` (typo, no matching subdir), the postprocessor silently drops it from the reply and logs a warning. Should the visitor's view of the conversation still look natural? **Lean:** yes — the stripped reply must be free of any "(failed to load topic)" residue. The model has to be polite either way.
10. **Telemetry.** Does `sw chatbot usage` need a per-topic breakdown? Probably useful for operators tuning what's worth promoting to always-included. **Lean:** out of scope for the first cut; revisit once we have usage data.

---

## What this doc is not

- **Not a v1.0.0 commitment.** v1.0.0 = first paying customer live on the M20-shaped surface. This design ships *only if* the first customer's content shape strains flat blocks; otherwise it stays on the shelf as the answer to a problem we haven't yet hit.
- **Not RAG.** No embeddings, no vector store, no chunk-retrieval policy. The LLM picks topics by name from a TOC the operator wrote. If a chatbot needs true semantic retrieval, that's a different project (and a different repo).
- **Not tool use.** `<load-topic>` is a one-way "please add this to my context for next turn" — no function call, no return value, no agentic loop. The model's reply is rendered as text once any `<load-topic>` tags are stripped; the loaded content appears on the *next* turn's prompt.
- **Not a content-management tool.** Operators still author markdown files in `data/chatbots/<slug>/<topic>/`. No HTTP-side WYSIWYG. The admin API's existing block PUT/GET extends to the tree shape and that's it.
