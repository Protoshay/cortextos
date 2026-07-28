# Research notes

Use this file only when maintaining or revising the skill.

## Main source reviewed

`blader/humanizer`, version 2.9.1, commit
`523374dee72d67c7b2b5f858ea0094ffda49c3ac`, reviewed 2026-07-27:

- Repository: https://github.com/blader/humanizer
- Skill: https://github.com/blader/humanizer/blob/main/SKILL.md
- License: MIT, Copyright (c) 2025 Siqi Chen

Useful principles adapted into original fleet wording:

- preserve information and never invent facts;
- calibrate against the person's real voice;
- personality is useful only when the channel supports it;
- remove sycophancy, filler, vague claims, promotional language, chatbot
  artefacts, formulaic patterns, and mechanical rhythm;
- run the detection/edit pass privately and emit only the finished text.

Not adopted:

- hard bans on em/en dashes, curly quotes, bold, lists, emojis, or particular
  conversational phrases;
- detector evasion as a goal;
- one generic "human" voice for every person and agent;
- draft/audit/final output in chat, which would expose working and create noise.

## Fleet evidence that shaped this version

- User preference: 50 words per reply; 200 cumulative agent words before a
  useful question or forward check.
- User preference: warm, conversational, honest, occasionally cheeky, with dry
  wit and humour when appropriate.
- User preference: proof and working stay backend.
- Screenshot example: Kami split one answer across eight messages, exposed code,
  routing, system detail, and speculative working before asking the useful
  question. Stored in Otis's interaction tracker.
- Will's live ruling: internal or restart chatter is not a deliverable;
  one-message-then-wait can override cumulative word allowances.

## Maintenance rule

Every confirmed breach becomes a regression example. Fix the loophole by
behaviour class rather than agent name. Preserve existing good behaviour and
re-run earlier examples after each revision.
