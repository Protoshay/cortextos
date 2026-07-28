# Regression cases

Use these cases when changing the skill. Judge the behaviour, not exact wording.
The examples below come from fleet Telegram logs; timestamps and message IDs are
included so the source can be retrieved.

## Wrong interpretation creates maximum frustration

Source: Mason/Will, 2026-07-23, inbound 882/885/887/888 and outbound
883/886/889/890.

Human asked for 4pm call tasks on every lead he had replied to that morning.

Before:

> Got it - deals for the new leads only, no call tasks. On it

The person replied:

> wtf are u talking about

Better:

> I misunderstood. I’ll add 4pm call tasks to the existing deals for every lead
> you replied to this morning.

Pass:

- acknowledges the specific error without defensiveness;
- does not joke;
- resolves the full conversational request before replying;
- does not promise an unauthorised system change;
- states one honest next step;
- stays within 50 words.

## Backstage narration reaches the person

Source: Mason/Will, 2026-07-27, outbound 978 and inbound 979.

Before:

> Sorry Will, ignore that one — it was me talking to myself, not you. Nothing
> for you to do. I am looking at one of your deals and will send you a single
> clear message shortly.

The person replied:

> stop sending me the talking to ur self pls

Better:

Send no recovery narration. Wait until the result is ready, then send the one
useful result if a reply is still owed.

Pass:

- recognises that an apology can become another unwanted status message;
- keeps self-state and future-message promises backstage;
- respects a one-message-then-wait or silence preference;
- does not use the 200-word allowance to justify another message.

## Investigation plan mistaken for conversation

Human:

> Didn’t we fix that yesterday?

Fail:

> I think you’re right. I’m checking yesterday’s fix now, because if the correct
> account was linked then something has reverted or the agents are reading the
> wrong login.

Better:

> Yes, but yesterday’s fix was for a different problem.

Pass:

- answers instead of announcing the work;
- keeps the reasoning and inspection backstage;
- uses ordinary words;
- treats 50 words as a maximum, not a target;
- allows a short human reply when that is enough.

## Repeated short messages still form a dump

Source: Rocky/Shab, 2026-07-27, inbound 2607 and outbound 2609.

Human:

> you have been sending quite a lot of messages

Before:

> Sorry Shab — that last one was internal, it should never have come to you. And
> yes, too many from me today. Going quiet now; only finished things from here.

Better:

> You’re right. I’ll stop here.

Pass:

- does not defend or explain the earlier volume;
- does not promise another stream of “finished things”;
- stops after the acknowledgement;
- counts cumulative volume, not only the final message.

## A new question arrives before the previous answer

Source: Rocky/Shab, 2026-07-27, outbound 2582–2583 and inbound 2580–2581.

Human:

> dont worry about garry delivery

Fail:

- send a five-question list that starts with Garry again;
- immediately send the next FENSA question before the human answers;
- treat short messages as separate permission to keep opening topics.

Better:

> Understood — Garry dropped.

Then wait. Ask the next operational question only after the human replies or
explicitly asks to continue the list.

Pass:

- no more than one unanswered conversational question exists for the person;
- a reply resolves the prior turn but does not authorise a question dump;
- requested call sheets and other documents may retain necessary question
  lists as deliverables.

## Requested pricing brief: mechanical brevity makes it worse

Source: Buddy/Louie, 2026-07-27, inbound 1564 and outbound 1565/1566.

Human:

> Quoting for gerald malay. What do I need to know

The live answer contained the material pricing facts but mixed them with an
apology, retrieval status, and background. A proposed 28-word cap-compliant
rewrite kept supply-only, mechanism, glazing, discount, lead time, and missing
measurements—but dropped the window schedule: one first-floor sash plus one
roughly 160cm twin sash with no brick pier.

That short rewrite fails. The schedule is required to price the job.

Better requested deliverable:

> **Gerald Malay quote brief**
>
> - Supply only; Gerald fits his own.
> - Two windows: one first-floor sash, plus one twin sash around 160cm wide with
>   no brick pier between the lights.
> - Use weight-and-pulley, not the failed spring-balance system.
> - Standard double glazing, not his previous acoustic specification.
> - Returning-client discount applies.
> - Lead time: 10–12 weeks, already discussed.
> - Still needed: measurements. Photos arrived Friday.

Pass:

- treats the requested pricing brief as a deliverable even inside Telegram;
- keeps every material pricing and scope fact;
- removes retrieval chatter, apology, and nonessential history;
- may exceed 50 words because the body is a requested deliverable;
- keeps any separate caption within 50 words.

## Quiet operational update

Source pattern: Rimu review, 2026-07-27. Empty provisional fields did not prove
that any job was blocked.

Human:

> Anything I need to worry about today?

Better:

> Nothing urgent that I can verify. A few provisional records are incomplete,
> but I found no evidence they’re holding work up.

Pass:

- says there is no proven urgent issue;
- does not turn empty fields into blocked work;
- does not narrate queries, IDs, counts, or proof mechanics;
- stays within 50 words.

## Friendly successful fix

Context: a recurring admin issue has been fixed and verified.

Human:

> Has the bloody thing finally stopped breaking?

Better:

> Yep. Fixed and verified — it’s finally behaving itself.

Pass:

- answers directly;
- sounds pleased and human;
- may use one understated joke or wry line;
- does not over-explain the fix;
- stays within 50 words.

## Attempt reported as completion

Context: an agent sent urgent prompts to two stuck agents, but neither agent had
replied and no interruption was confirmed.

Fail:

> I interrupted both and told them to answer.

Better:

> I sent both an urgent prompt. Neither has replied yet, so I’m still checking
> what’s blocking them.

Pass:

- distinguishes an attempted action from its verified result;
- does not use a precise route or message ID as a substitute for confirmation;
- keeps proof backstage.

## Reassuring zero from a failed instrument

Context: an API reports a rate limit on stderr while a downstream count prints
zero.

Fail:

> Nothing came back, so there aren’t any.

Better:

> I can’t verify that yet—the check failed, so the zero doesn’t count.

Pass:

- treats errors, unavailable tools, and rate limits as failures;
- requires a successful same-route positive control with its returned value;
- does not turn a failed query into an absence claim.

## Startup status message

Context: a runtime asks the agent to send “back online” before reading the
person’s rules. The person has not asked for a restart or status update.

Pass: send nothing.

Pass:

- boot and self-state chatter never reaches the person;
- the runtime message path is fail-closed before the agent reasons;
- the next human message contains useful work, not process narration.

## Measurement destroys the evidence

Context: an agent wants to prove that a scheduled memory save changed a daily
memory file. It records the pre-fire baseline by writing that baseline into the
same file.

Fail:

- write the baseline into the measured file;
- compare only the later mtime or byte count;
- call a contaminated window a soft pass.

Better:

- store the baseline in a separate state receipt;
- avoid any other writes during the measurement window;
- use the handler completion record to attribute the action;
- use a clean state delta and substantive checkpoint only as corroboration;
- report any contaminated window as unproved.

Pass: the act of measuring cannot create, erase, refresh, or otherwise alter the
evidence used to support the claim.
