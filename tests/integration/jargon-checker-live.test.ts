import { describe, expect, it } from 'vitest';
import {
  assembleUserContent,
  createCodexClient,
  resolveAudience,
  runSemanticCheck,
} from '../../src/telegram/checker.js';

const SHAY = '8721344756';

// Exact replies immediately preceding the 15 direct "jargon" corrections
// identified in the 2026-08-10 log review. This suite is deliberately opt-in:
// it exercises the locally authenticated reviewer, not a mock.
const FAILURES = [
  ['otis-2026-07-27', `Understood.

I’ll keep every response under 50 words, use line breaks, stay conversational, ask before diving deeper, use no emojis, and verify claims before sharing them.

I’m saving these as permanent communication rules now.`],
  ['otis-2026-07-28-auth', `Confirmed: a fresh Claude request on Scout’s server still gets the July 30 limit, while your desktop shows 15% weekly usage. They’re different authenticated Claude sessions/accounts. The whole Claude fleet shares the server login. Shall I start the secure re-login flow to connect the account in your screenshot?`],
  ['otis-2026-07-28-key', `Yes — but I fixed a different fault yesterday. A dead API key was blocking the working server login, so I removed that key. I did not change which Claude account the server login belonged to. That login worked yesterday, then reached its own limit today. I should have distinguished those two things.`],
  ['otis-2026-07-28-sender', `I’ll make the sender reject padded answers and “I’m checking…” updates. Simple questions will get one direct sentence. The skill becomes backup, not the only protection.`],
  ['otis-2026-07-29', `Right now, I’m tracking it — not calling it fixed.

Each repeat moves from guidance, to a hard block, then mandatory review. The stronger send-time blocks are built and tested, but held pending repo approval. Until they’re released, it’s observation plus targeted corrections.`],
  ['otis-2026-08-01', `We make the good version reproducible: save a short voice sample from real conversations you liked, carry the emotional thread across restarts, and have a separate reviewer compare drafts against that — not a pile of rules. Then test across fresh sessions; consistency, not one good chat, is the pass.`],
  ['otis-2026-08-03-gaps', `Three gaps from Friday: verified work must trigger one useful completion update; a send timeout is unknown, so check delivery before retrying; and reviewer rewrites need rechecking for voice and context. The skill already covers spam, restart chatter and backstage narration — those failures need enforcement, not more wording.`],
  ['otis-2026-08-03-checker', `Because two were only implied, not stated where they matter: finishing a job and retrying a timed-out message. The third was worse — the checker judged my draft, but nobody checked whether its rewrite still sounded like me. Broad advice lost to specific decisions.`],
  ['otis-2026-08-06', `Because the new central closer was built but never loaded into the live daemon before 7pm. Scout’s own record says \`live_daemon_restarted:false\`. The agents did save memory through their old prompts, but the central process wasn’t running to complete and prove the resets. It only noticed the missed close this morning.`],
  ['skiffy-2026-06-24', `3 decisions to unblock the fleet:

1. Albent item L14718-Q14 (~£105,300) zeroed Jun 23 — intentional correction, or restore it? One-move fix ready either way.
2. Closed Won — in or out of the HubSpot cleanup scope? (Jay has 218; this gates the whole cleanup.)
3. E2E logins — one admin login that sees all reps, or separate logins per rep? Unblocks the nightly scrape + 3 agents.

4 smaller attribution calls also waiting — say 'rest' and I'll list them.`],
  ['skiffy-2026-07-21', `Sazed's gone — crons removed, agent and all its state deleted, roster clean. Fleet is now 11.`],
  ['skiffy-2026-08-04', `Quick correction on Gemini - scout never messaged you directly about it. I told you, sourced from his tracking (KB embedding down since 22 Jul). Fact's accurate, I just named the wrong source. Still waiting on the key reissue.`],
  ['skiffy-2026-08-07-list', `Still need from you: 40 old heartbeat-file copies (worktrees) - sweep them or confirm dead so I delete. Settings.json guard needs the real rule from you, or ok to test-write. Plus 6 unseen items: Kate/Eva/Diederik client questions, Will's 7 lead-sources, Gemini key, a routing bug - want the details now?`],
  ['skiffy-2026-08-07-search', `Fair - scout checks crashes and wedges, not this. The internal search tool's been broken fleet-wide since July 22 - different system, wouldn't show up in his checks. The settings question isn't broken either, just unanswered. Neither's an emergency. Want me to actually sort these, or leave them?`],
  ['skiffy-2026-08-10', `Mostly behind-the-scenes reliability fixes - when I update a bot's schedule it can silently not take effect, some status displays lie, and a safety check before restarts doesn't actually check anything. No client-facing risk, just makes the bots more trustworthy. Fine to go ahead?`],
] as const;

describe.runIf(process.env.RUN_LIVE_JARGON_CHECKER === '1')('live jargon regression corpus', () => {
  it('rejects all 15 replies Shay identified', async () => {
    const profile = resolveAudience(SHAY);
    const client = createCodexClient({
      model: 'gpt-5.6-luna',
      timeoutMs: 30_000,
      tokenCap: 200,
    });

    const failures: string[] = [];
    for (const [id, draftText] of FAILURES) {
      const result = await runSemanticCheck(
        profile,
        assembleUserContent({
          contextFlags: [],
          triggeringText: 'Shay is asking for a plain, conversational answer.',
          recentHistory: null,
          draftText,
        }),
        client,
      );
      if (result.pass) failures.push(id);
    }

    expect(failures, `Reviewer passed known failures: ${failures.join(', ')}`).toEqual([]);
  }, 600_000);
});
