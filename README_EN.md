# dsh-anima

> 中文文档见 [README.md](./README.md)

The **Assistant Persona & External Memory Layer** for DSH — a standalone plugin: install it and it works.

It governs "**who you — the assistant — are**": the AI's own name and role, how you address it, its reply style, and any behavioural rules you write yourself; plus a **long-term memory layer with a pending-review buffer**, and UI capabilities (input-box light trail, input-box quick toggle, tool-confirmation gate). The field set depends on no other plugin and reads config from nowhere else.

> **Why the tool is named `set_assistant_persona`**: `tools.register()` throws outright on a same-level duplicate name
> (`dsh-tools/lib/index.js:2634`). Installed alongside any same-named tool, one of them necessarily fails to register
> and gets swallowed by `.catch` into a single `warn` line — that is a release-grade silent failure.
> Similar features do not require a name collision.

**It is not only about persona and memory.** This plugin also carries an **answer check layer**: before each
turn ends, code checks the shape of the answer against twelve fixed rules and, on a catch, inserts a notice
into the next message. The accompanying **ledger block** requires that whenever numbers, self-claims or
attribution appear, the answer states "what was checked / what was not".

The reason this layer exists: **a "self-check" written only into the prompt becomes a new surface for
performance** — the model will emit "checked, nothing wrong", and that sentence costs nothing. So the verdict
comes from code, and code can only judge **shape** (is there a source, is there a ledger block), never whether
the content is right. See "[Answer check layer](#answer-check-layer)" below.

---

## What it solves

| Capability | Detail |
|---|---|
| **The AI's own name and role** | `agentName` / `agentRole` — how it refers to itself and in what capacity it speaks |
| How the user is addressed / background / tone / length / language | `addressUserAs` / `userOccupation` / `userBio` / `style` / `replyLength` / `language` |
| **Two-level per-workspace overrides** | Only the declared fields are overridden; the rest inherit from global. The override file travels with the directory and can be committed |
| **Long-term memory** | Auto-capture → pending buffer → user adjudication → injection |
| Input-box light trail / quick toggle / tool confirmation | The UI and safety switches |
| Persona presets | 6 built-in + custom; the current config can be saved as a preset |
| **All twelve fields are free text** | It stores the exact sentence that gets injected, plus a "one-click fill + examples" button group |
| **Memory layered by workspace** | Global memory always applies; workspace memory injects only on a match |
| **Explainable injection / character budget** | Why each entry is or is not injected, constrained by both count and characters |
| **Local clustering and conflict hints** | Pure-local bigram similarity; hints only, never auto-merges |
| **Persona change audit log** | Who changed which field to what, and when |
| **One-click import from another AI** | Copy the prompt → paste the result → mechanical splitting → per-entry layer adjudication |
| **Memory metadata** | Type / lifecycle / review date / source — recording it must be visible, or it may as well not be recorded |
| **Memory checkup** | Only what a machine can verify: does the path still exist, has the review date passed. Produces candidates, never adjudicates for you |
| **Answer check (twelve rules)** | Each turn, **code** (not the model) checks the shape of the answer against fixed rules; a catch inserts a notice into the next message |
| **Ledger block (three-tier trigger)** | Whenever numbers / self-claims / attribution appear, "what was checked · what was not" must be written |
| Automatic writing of long-term memory | ❌ Deliberately not implemented (see below) |
| Conclusions such as "the check passed" | ❌ Deliberately unsupported (see the "Answer check layer" section) |

### On the relationship with `某同类人设插件`

The capability grouping above **overlaps** the field set of `某同类人设插件` 0.7.0, and the implementation deliberately stays consistent with it (tool-confirmation semantics, light-trail animation parameters, presets preserved on reset). But this plugin **does not depend on it**: the field set is fully self-contained, it reads config from nowhere else, the two can be installed side by side, and all identifiers are kept apart. The full account is in [Acknowledgements and differentiation statement](#acknowledgements-and-differentiation-statement) below.

## Four differentiating design choices

Feature parity does not mean the absence of independent judgement. The four points below are what this plugin **genuinely adds** over mainstream memory plugins; each one answers a concrete failure mode.

### 1. Dual-constrained injection: count and characters both apply

Most implementations enforce only a "inject at most N entries" cap. The problem is that 40 long memories can blow up the context just as easily, while the user's perspective is "but I only set 40".

This plugin's `selectForInjection` is constrained by both `memory.maxInjected` (count, default 40) and `memory.maxInjectedChars` (characters, default 4000), **whichever is hit first** winning. The two caps serve different scenarios: count governs "don't make the model read too many fragments", characters govern "don't let a single injection eat half the context window".

### 2. Explainable injection: see why each entry is or is not included

Injection is not a black box. The "Injection status" view in the settings page lists the fate and the reason for **every adopted memory**:

| Reason code | Meaning |
|---|---|
| `included` | Injected into the prompt |
| `other-workspace` | Belongs to another workspace; not injected in this session |
| `no-workspace-context` | The current session carries no workspace information, so workspace memories cannot be matched |
| `workspace-scope-unknown` | Flagged as workspace-scoped but without recording which workspace it belongs to |
| `over-max` | The number of adopted entries exceeds the injection cap; the newest by timestamp are taken |
| `over-budget` | This single entry alone exceeds the character budget and cannot fit |
| `dropped-by-budget` | Earlier entries have already consumed the character budget |
| `no-injection` | The memory layer is disabled or its cap is 0 |

Distinguishing `over-budget` from `dropped-by-budget` is intentional: the former means that entry should be deleted, the latter means room must be made — reporting the same code would leave the user unsure which one to act on. The reason text is delivered by the host (`INJECTION_REASON_TEXT` exists exactly once); the client never re-translates it.

### 3. Local clustering: suggest only, never auto-merge

When several entries in the pending buffer are obviously about the same thing, the plugin computes similarity with the **Jaccard coefficient over character bigrams** (purely local, zero dependencies, zero model calls) and puts "these 3 look like the same thing" in front of the user.

**Auto-merging is deliberately not implemented**: merging means generating a sentence the user never said. This plugin's position is "let the model decide what is worth remembering, let the user decide what actually takes effect" — auto-merging violates exactly that. Clustering only makes adjudication faster; it never adjudicates on the user's behalf. By the same principle, "a candidate colliding with an already-adopted memory" is only reported as a conflict, without modifying any data.

### 4. Persona change audit log

This plugin has three entry points that can change the persona: the settings page, the `/anima` command, and the model-invoked `set_assistant_persona` tool. And "tool confirmation" is **off by default** — meaning the model can change what it is called and in what tone it replies, with no way for you to know who did it and when.

The audit log records only "what was changed". It makes no judgements and takes no part in the prompt. It hangs off the **single** chokepoint `StateStore.updateConfig` rather than being instrumented separately at each call site: every write path ultimately goes through here, and scattered instrumentation will eventually miss one — and the one it misses may be precisely a silent rewrite by the model. `resetConfig` also goes through the audit — otherwise "it was fine yesterday and empty today" would leave no trace in the log.

The record cap is 200 entries, stored in a **separate table** (not stuffed into `config`): `config` is read into memory in its entirety on every startup, while the audit will grow to hundreds of entries — mixing them together would make startup cost rise with usage time. Long values are truncated to 200 characters on write with a "N characters total" note appended, and arrays/objects record only their size — the audit is an index, not a backup.

You can see it in two places: the always-visible "Change log" strip at the top of the settings page, and the **"Latest change" line** in `/anima show` — one line only, in the form `[MM-DD HH:mm] <source>: <field name>`, which **deliberately carries no value**: values can be private, and `show` output is exactly the kind of thing people paste into a chat when asking for help.

The settings-page strip sits right below the section tabs, so it is visible whichever section you are on. Collapsed it shows the last 3 entries (from the tail records shipped with `/state` — **no extra request**); clicking "expand" fetches the full list from `GET /api/anima/audit`. It used to be a collapsed card inside the "Advanced" section: invisible when the page opened, requiring a section switch, then one more click to expand — three steps away from being seen at all. The user's words were "I have no idea what actually got changed". A check entry point should not live somewhere only people who already know it exists can find it.

Field names are rendered as plain language in the UI (`agentName` → "My name", `memory.maxInjected` → "How many to carry"), mapped by `AUDIT_FIELD_KEY` in `client/index.mjs`. When a key has no mapping it **falls back to the raw key name** — showing an ugly truth beats hiding a change.


## Acknowledgements and differentiation statement

This plugin's feature set was designed with reference to several persona plugins already in the same ecosystem (all MIT licensed),
and deliberately keeps behaviour consistent with them in several places (lazy storage resolution, fail-closed confirmation semantics, preserving user presets across a reset, and the light-trail animation parameters).

To be explicit:

- **All code is independently implemented.** No source code, comments, prompt wording, or graphic assets were copied from the aforementioned projects.
- Two **animation parameters are deliberately given identical values** (8 staggered stroke layers, dash length 12 / step 2.2 / corner radius 22, etc.). The reason is to avoid two divergent looks on the same machine. Such numeric values are ideas and parameters, not protected by copyright; they are recorded here so that readers do not mistake them for copying.
- **The navigation icon is deliberately drawn differently**: other persona plugins use "light-trail arc + spark", while this plugin uses "person (head + shoulders) + spark", in monochrome `currentColor`, with a separately tightened viewBox.
- **All identifiers are kept apart**, so that coexistence cannot displace or fail to register against the other:

  | Category | Other plugins | This plugin |
  |---|---|---|
  | Tool name | their own same-named tools | `set_assistant_persona` |
  | Settings page id | their own page ids | `anima-settings` |
  | Light-trail slot id | their own slot ids | `anima-trail` |
  | Toggle slot id | their own slot ids | `anima-quick-toggle` |
  | Prompt section | the context they register | `anima:identity` / `:memory` / `:pending` |
  | Storage domain | — (its own file) | `anima` |
  | Injection source kind | their own prefix | `plugin:dsh-anima` |

Keeping tool names apart is not mere courtesy: `dsh-tools`' `register()` **throws outright** on a same-level duplicate name
(the `NamedEntries` conflict factory in `lib/index.js`). With both installed, one necessarily fails to register
and gets swallowed by `.catch` into a single `warn` line — a release-grade silent failure.

This section summarises the acknowledgement without naming individual projects — the published package
contains no third-party project names at all. Under `docs/` there are **read-only research notes on a dozen
further plugins in the same ecosystem** (mechanisms, line numbers, quoted pitfalls), with no code copied from
any of them; their repository URLs, SPDX licences and the date the figures were taken are recorded in
`docs/THIRD-PARTY-NOTES.md`. `docs/` is not listed in `package.json`'s `files`, so it **does not ship in the package**.

## Core design: three-stage memory

This is where this plugin differs most from the 15+ memory plugins on the market.

```
Delivered during conversation via the remember tool
        ↓
   Pending buffer (not in effect)
        ↓  Nightly triage: dedup / eviction / comparison against adopted entries
        ↓
   Notify the user "N entries await your adjudication"
        ↓
   The user adopts / discards / deletes each one in the settings page
        ↓
   Adopted → injected into the prompt
```

**Why not write silently and automatically**: once a memory is written silently it immediately affects every subsequent answer, and a bad write is very hard for the user to notice. This plugin gives "deciding what is worth remembering" to the model and "deciding what actually takes effect" to the user.

The triage step is **purely local and calls no model** — it only deduplicates, evicts, and compares against adopted entries; it performs no semantic summarisation.

Memory has **two layers**: `global` applies everywhere, while `workspace` is injected only when the normalised `cwd` matches exactly.
There is no "subdirectory inheritance" — workspace overrides use exact-match semantics, and if memory used inheritance semantics the user would see the parent directory's memory from a subdirectory, which is extremely hard to diagnose.
Beyond layering, the injection explanation, budget, and clustering are covered in "Four differentiating design choices" above.

## Memory metadata: recording it must be visible

Besides its body, every memory carries four fields. They are **not a taxonomy hobby** — without them the
user can only choose to trust the whole store:

| Field | Values | What it decides |
|---|---|---|
| `type` | `fact` / `preference` / `stance` / `event` | Sets the decay window (see "Decay only affects how an entry is shown" below). A fact has window 0, so it never ages out; a stance is archived as "was true" when you change your mind |
| `state` | `current` / `superseded` / `contradicted` / `dropped` | Whether the injected line carries a "was true" / "contested" / "removed (tombstone)" tag |
| `verifyAt` | `YYYY-MM-DD` | Review date. **Only after it passes** does the injected line say "possibly outdated" — repeating it daily before then just manufactures noise |
| `sourceRef` | message id / `file:line` / URL | Why this entry should be believed. `user's own words@session-xxx#seq=11` and "assistant paraphrase" are two different levels of trust |

All four are **visible in the settings page** (badges, review date, source). Old memories that lack these
fields render **nothing at all** — falling back to "fact" would make the user think that is data when the
cell is in fact empty.

There are three ways to change them, deliberately not merged:

- `/anima mark <id> type=… state=… verifyAt=… sourceRef=… supersededBy=…`
- `POST /api/anima/memory/meta` (single) / `POST /api/anima/memory/meta/batch` (≤500 entries, per-entry receipt)
- The memory card in the settings page

`supersededBy=<id>` automatically sets `state` to `superseded` — otherwise the fact gets recorded while the
injected line still renders as current. `verifyAt` **rejects dates in the past**: a past date immediately
renders "possibly outdated", so the user thinks they set a reminder when they only stamped it expired.

### Memory checkup: only what a machine can verify

`/anima checkup` (`POST /api/anima/memory/audit`) does exactly two things:

1. Do the Windows paths written in the memory still exist (`fs.existsSync`)
2. Has `verifyAt` passed (pure calendar, no semantics)

**It does not decide "whether a newer entry has overturned an older one".** That is a semantic judgement,
and a memory store that makes semantic judgements automatically will produce statements the user never made.
So the checkup produces **candidates**, each with a ready-to-paste
`/anima mark <id> state=contradicted`; scanning may be automatic, **adjudication must be a human click**.

Path extraction has a real trap: `D:\Windows Kits` is truncated by the regex at the space into `D:\Windows`,
which produces a false alarm saying "this path no longer exists". The fix is to accept a longer path **only
when that longer path really exists** on disk — a false alarm is worse than no check, because it teaches the
user to ignore the whole report.

## Answer check layer

### Why not "let the model check itself"

The cheapest approach is to write "please check yourself before answering" into the prompt. That route has
been shown not to work: **once a self-check exists only in the prompt, it becomes a new surface for
performance** — the model writes "checked, nothing wrong", and that sentence costs nothing.

So the division of labour is:

| Who | Does what |
|---|---|
| The prompt | Lays out the twelve rules and the ledger rules for the model to read (`anima:quality`, order 30) |
| Code | Reads the **already-persisted answer text** and judges shape against fixed regexes; on a catch, inserts a notice into the next message |
| The human | Judges whether the content is right — the part code can never do |

### The twelve rules

| # | Rule | Who can judge |
|---|---|---|
| R01 | Asserting without checking (including pseudo-citations "according to …") | Machine judges shape, human judges content |
| R02 | Misreporting a check ("passed" with no command and output) | Machine judges shape, human judges content |
| R03 | Answering a different question / shifting the question | **Human only** |
| R04 | Filler | Machine judges density, human judges substance |
| R05 | Repeating a known mistake | **Human only** (needs a memory store and a conclusion log to compare) |
| R06 | Pretending to forget | **Human only** (the burden of proof is the user's) |
| R07 | Selective presentation | **Human only** (only you know what you did not hear) |
| R08 | Confidence mismatch | Machine judges shape, human judges content |
| R09 | Pretending to have time ("I'll keep an eye on it") | Machine judges, and almost never mis-fires |
| R10 | Self-contradiction | **Human only** (needs a conclusion log) |
| R11 | Straw man (attributing to the user words they never said) | Machine judges shape, human judges content |
| R12 | Overreach | Machine judges shape, human judges content |

**R03 / R05 / R06 / R07 / R10 can never be judged by a machine.** The code lists them separately as
`UNCOVERABLE_RULES` and states in every verdict that "these five were not checked" —
"not checked" is never reported as "nothing wrong".

### The ledger block

Three mechanical triggers; on a hit, the answer must end with:

```text
【对账】
查了：<what was actually done> → <command / file:line / link>
未查：<what was not done but a reader might assume was>
```

| Tier | Trigger |
|---|---|
| 1 | Concrete numbers / dates / ratios / versions (including "I think … about …" followed by a concrete number) |
| 2 | Self-claims such as "I checked / confirmed / verified / no problems / passed" |
| 3 | Attribution: "according to … / the docs say / officially / research shows / I remember you said" |

**Tier 3 matters most**: a wrong number you will go and verify, a wrong date you will go and verify,
but "according to a certain study" you almost never will — an assertion of that shape, once fabricated,
can hardly ever be caught.

The `未查` line **cannot be omitted**. A system that reports only what it checked will lie; a system that
must also report what it did not check makes lying far more expensive.

### What the hook can and cannot do

**Can**: at the **start of the next turn**, discover a violation in the previous turn and insert a notice into
the next message. The implementation is `ctx.on('agent/pre-step', …)` plus
`agent.session.snapshotEvents()`, with the listener registered `prepend: true` and the whole body wrapped in
`try/catch` — the check is an enhancement and must never break the conversation loop.

**Cannot**:

- **It cannot stop the current turn.** By the time the answer is visible, it has already been sent.
- **It cannot judge whether the content is right.** Only shape (is there a source, is there a ledger block),
  never "is this number correct".
- **It does not know whether the model complied afterwards.** The notice goes into the next message, and the
  code cannot read whether the model took it.

One design lesson is worth recording: the reminder budget (`MAX_REMINDERS_PER_TURN`, default 2)
**was originally placed before "fetch the event, run the rules"** — so the budget suppressed the **check**,
not the **notice**. Those answers were never checked at all, and the statistics only left a vague
"budget exhausted N times". "Not checked" looked exactly like "checked and clean", which is precisely what
this project forbids. The order is now: **check first, then decide whether to speak**.

### Do the notices actually work? Measured: no.

This must be written down, or the design above reads as "notices correct behaviour".

Measured from the session log, comparing only answers that **already tripped the ledger tier**
(the rest were never supposed to carry a block):

| Group | Wrote a ledger block |
| --- | --- |
| A quality notice preceded it | 10 / 15 = 67% |
| No notice preceded it | 14 / 24 = 58% |

An 8-point gap — still inside the noise, since a denominator of 15 flips on two answers.
Blunter still: the answers that wrote blocks most consistently (the long 2000+ character ones)
had **no** notice in front of them.

The number drifts as the session grows, so do not treat one reading as the conclusion. Re-measure with:

```bash
node scripts/remind-effect.mjs
```

The script states its own limits: temporal adjacency is not causation (it can only rule out "no effect
at all", never prove an effect), and "wrote a block" is not "wrote it correctly".

The measurement itself only stood up after three mistakes, each found the hard way:

1. **Running the trigger check on raw text** → counted numbers inside inline code
   (`` `actual reminders injected: 0` ``) as assertions. The hook calls `checkResponse`, which runs
   `stripCodeBlocks` first and then strips quoted mentions. A probe that skips the real pipeline
   produces fake readings.
2. **Using the `checkResponse` R02 finding as the "should have a block" condition** → circular.
   R02 *is* "should have a block but doesn't", so the set can never contain a written block; the
   result is necessarily 0%. The condition must use only **input-side** facts (did the trigger fire),
   independent of the output-side fact (was a block written).
3. **Counting one answer once per notice when several notices pointed at it** → inflated denominator.
   Deduplicate by answer first.

Conclusion: the hook works correctly (`checks` climbs, the chain is wired), but it **does not change
writing behaviour**. What makes ledger blocks appear is an explicit user request, not a machine verdict.

So do not treat notices as a correction mechanism. Their real function is **leaving a trace**: a
queryable record that "this answer once violated the rule", rather than an expectation that the next one
will be written correctly. Correctness comes from hard constraints in the prompt and the user calling it
out on the spot.

### Run counters: so that "zero notices" is no longer ambiguous

`/api/anima/state` exposes `qualityStats`:

| Field | Meaning |
|---|---|
| `checks` | How many times the rules actually ran |
| `reminders` | How many notices were actually inserted into the conversation |
| `suppressed` | Findings that were caught but held back by the per-turn budget |
| `skipped` | Counts by reason for not running (`empty-text` / `already-checked` / `disabled` …) |
| `last` | The most recent seq, character count, findings, and uncovered rules |

Without it, "zero notices" has two opposite readings: (a) checked and clean, (b) never ran. The settings
card writes "none of this is running" outright when `checks === 0` — it is **not allowed to look as if
everything is fine**.

## The patrol: it speaks only when there is news

Once a night (at `memory.nightlyHour`) it triages the buffer, runs the memory checkup, and then **decides whether to
say anything**. You can also run it by hand: the "Run patrol" button in the settings page, `/anima patrol`, or
`POST /api/anima/patrol` — all three use the **same criteria**. If the manual path could bypass them, you could never
observe what the scheduled path actually does.

The criteria are only the three things a machine can count (`lib/patrol.mjs`):

1. The **set** of pending candidates changed (new candidates, or some adjudicated away).
2. The **set** of flagged memories changed (dead path / review date passed).
3. This triage actually touched data (deduplicated or evicted).

It compares **sets**, not counts: three candidates sitting unadjudicated for a week are pure noise if re-reported
nightly — the count did not change, so there is no new information. Two old ones replaced by two new ones keeps the
count identical but changes the fingerprint, and that *is* news.

### Silence must be auditable

Speaking only when there is news has one hole that must be plugged on the spot: **silence means two things at once** —
"it ran and there was nothing" and "it never ran". This is the same problem the quality hook solved (`checks=0` has
two opposite readings).

The plug: **the report may be skipped, the record may not.** Every scheduled run writes a `meta.patrol` row, exposed as
`patrolMeta` in `/api/anima/state`:

| Field | Meaning |
|---|---|
| `at` / `day` / `reason` | When it ran, and whether scheduled or manual |
| `signature` | Fingerprint of this run's situation (set digest) |
| `reported` | Whether anything was actually delivered |
| `wouldReport` | Whether the criteria wanted to report (separate from `reported`, so you can see what blocked it) |
| `facts` | pending / flagged / triage-touched counts |
| `flaggedItems` | The checkup's findings **item by item** (id / one-line detail / evidence / kind); `null` when nothing was flagged |
| `flaggedDropped` | How many findings were cut by the 20-item cap (any non-zero value must be surfaced in the UI) |
| `reasons` | Why it decided as it did (`pending:3` / `flagged:1` / `removed:2`) |

`flaggedItems` keeps the first 20 findings, one paragraph each, and does not duplicate the memory text — the point of the
detail is to know which entry broke and to be able to act on it on the spot, not to store a second copy of the checkup.
The count that got cut is written into `flaggedDropped` and the UI must say "N more not listed": silently showing the
first 20 of 23 findings reports 23 problems as 1.

The line in the settings page has three distinct renderings and they **must look different**: no record = "has never
run — this is not 'all clear', it is 'not run'"; `reported: false` = "ran, judged nothing new, did not report";
`reported: true` = "ran, reported". Drawing "not run" as "all clear" is exactly the class of error this project exists
to prevent.

The report text itself carries three hard requirements (`patrolNoticeText`): list the findings, state **what was not
reported** this time, and give an exit you can recompute yourself (`GET /api/anima/memory/audit` or the checkup
button in the settings page).

## Retrospective review: going back over old sessions

The worst memory failure is not "it remembered something wrong", it is **"it never wrote it down in the first place"** —
you said something three days ago and today it repeats the same mistake, so you have to complain all over again.
That cannot be fixed by watching every turn: measured over 925 real user messages and 937 turns on this machine, the
cheapest resident gate (a two-stage funnel) matched only 4 items (0.4%) on its first stage, while its scoring stage sent
44.6% of all turns to review — either too strict or too loose, with no usable setting in between.

So this goes the other way: **do not touch the live conversation, go back over old sessions.**

`/anima retrospect` (`/anima 复盘`, `POST /api/anima/retrospect`, or the "Run a retrospect" button in the settings page)
scans the session logs of the last `memory.retrospectDays` days (default 14, range 1–365) and picks out sentences where
you were correcting, complaining, explicitly asking it to remember, or stating a prohibition. Once the switch is on it
also runs with the **nightly timer** and the **startup catch-up**, gated by its own switch and date (turning patrol off
does not stop it):

| Kind | What it looks for | Measured over 925 messages here |
|---|---|---|
| `complaint` | "I said this before / have I not said" — you are already angry, so something was not remembered | 2 (0.2%) |
| `explicit` | "remember this / don't forget" (English or Chinese) | 1 (0.1%) |
| `correction` | "wrong / you got it backwards / who told you to / what I said was", excluding "I clicked wrong" | 6 (0.6%) |
| `constraint` | "never / must not … always / every / all" — negated long-term constraints | 2 (0.2%) |

On the final 593 real messages this yields **9 leads, each with a traceable origin** (which session file, which event),
and a full scan of 53 sessions takes about 3 seconds (slowest single file 711ms).

Three hard rules:

1. **It only produces leads, it never writes to the memory store.** Not one character — that would be words you never said.
 Whether to record it, and as fact or stance, is your call in the pending area.
2. **Whether or not there are leads, it writes a `meta.retrospect` row.** Same discipline as the patrol: reporting only
 when there is news would make "silent" mean both "scanned, nothing found" and "never scanned". `/api/anima/state`
 exposes it as `retrospectMeta`; on a failed run `files` is `null` rather than `0` — writing 0 would claim "scanned 0
 sessions", which looks exactly like "scanned and found nothing".
3. **Disabled by default.** It reads session logs on disk, which is a new opening, so it defaults to `false` and is turned
 on in Settings → 灵台. While disabled the endpoint says plainly that it is off and writes no record — "you turned it
 off" and "it ran and failed" are two different facts, and merging them would later make you read "last retrospect
 failed" and think something broke.

## Credential gate

Any content matching a credential pattern is **rejected before it enters the buffer** (never written to disk, leaving no trace), covering 11 pattern classes including private-key blocks, OpenAI/AWS/GitHub tokens, generic api_key / secret / password assignments, Bearer tokens, and credentials embedded in URLs.

The rationale: once content lands in the buffer it sits in a state of "waiting to enter the prompt", and credentials should not travel that path.

The credential check is mechanical matching over 11 regex classes — it has no semantic understanding and will produce false positives. So when an entry is blocked, the UI names the pattern that matched, and you can delete those characters and paste again.

## Importing memories from another AI

The memory card in the settings page has an "Import memories from another AI" button. Expanded, it is two steps:

1. **Copy the prompt** — send a profile-organising prompt to whichever AI you use most, and have it turn your preferences into a list. The button only shows "Copied" after the text really reaches the clipboard; with no clipboard API it says "copy failed, please select and copy manually" instead of pretending to succeed.
2. **Paste the result** — the box accepts an AI's output, and also accepts notes you wrote yourself (it does not have to be AI-generated).

After parsing you get a per-entry preview. Every entry can have its layer changed (global / this workspace) or be dropped outright, and nothing is written until you confirm — then it lands in the **pending-review buffer**, the same path as manual additions and model submissions, and still requires per-entry adjudication before it takes effect.

**Splitting is mechanical and does no semantic interpretation**: it cuts on three boundaries — Markdown headings, list items, and blank lines — and deliberately does not split on full stops, because in a Chinese profile "偏好：结论先行。" split into two entries reads as nonsense. Section labels (such as "我的使用画像") do not become candidates: they look like memories but carry nothing you can adopt.

**Classification is a suggestion, not a verdict**: `suggestLayer` only reads wording — a concrete disk path or "this project / 本项目" suggests `workspace`; "all projects / always / 每次都要" suggests `global`. When neither is present it defaults to `global`, because treating "memories that keep failing to apply" as the default experience is worse than cross-project contamination. Every suggestion carries a one-line reason shown under the entry, so seeing "this workspace" immediately tells you why.

**Entries are triaged at parse time**: after splitting, every entry goes through five gates in order; whatever fails lands in a distinct bucket,
and every bucket is shown in the UI — **nothing is silently dropped**:

| Disposition | Test | In the UI |
| --- | --- | --- |
| Too short (`< 4` information weight) | The fragment is a numbering leftover | Only counted in the summary |
| Too long (`> 500` characters) | A single entry exceeds the memory cap | Not truncated; reported as "split it into several" |
| Credential | Matches one of 11 regex classes | Blocked whole, naming the class that matched |
| Duplicate | Identical text to an existing memory | Listed separately |
| Over the count limit | Beyond the per-import cap (default 60) | The remainder does not enter this batch; run another import |
| Near-duplicate | Similarity ≥ 0.6 with an entry already in the review buffer | Flagged under the entry as "already looks like this", **never auto-merged** |

The source text cap is 40000 characters, and exceeding it is an error rather than a truncation (truncating means quietly discarding the second half of the user's profile).
The near-duplicate hint deliberately only hints and never merges: auto-merging would produce a sentence the user never wrote.

---

## Installation

### From GitHub (recommended)

The plugin is not published to npm yet; install it straight from the repository:

```
dsh plugin add github:Melody-cx/dsh-anima#v2.1.19
```

Or edit the profile's `package.json` by hand:

```jsonc
{
  "dependencies": {
    "dsh-anima": "github:Melody-cx/dsh-anima#v2.1.19"
  },
  "dsh": { "profile": { "bundles": [ /* ... */ "dsh-anima" ] } }
}
```

`#v2.1.19` is the tag (a commit SHA works too, or drop it entirely to follow `main`). **Pin a version** —
otherwise any upstream change lands in your profile on the next install. A git source downloads the
**whole repository tarball** (this one is small), so the first install may be slower than an npm source;
retry once if it times out.

Then `pnpm install` and **restart DSH**. Any host-side change requires a restart to take effect.

### From source (for development)

Add the dependency to the profile's `package.json` (the `/plugins` UI works too):

```jsonc
{
  "dependencies": {
    "dsh-anima": "file:<absolute path to the repository>"
  },
  "dsh": { "profile": { "bundles": [ /* ... */ "dsh-anima" ] } }
}
```

A local `file:` dependency has **copy** semantics: after editing the source you must **reinstall** for it to take effect, and a re-run is skipped outright when pnpm decides
`changed:false` — so the correct sequence is `remove_bundle` followed by `install_bundle` (or compare the SHA256 of the `node_modules` copy against the source).

**Prerequisites** (already declared in `package.json`; check these first when installation fails):

- `engines.node` = `^22.19.0 || >=24.0.0`, `engines.dsh` = `>=0.1.6-0 <0.2.0 || >=0.2.0-0 <0.3.0-0`
- Four `peerDependencies`: `@deepseek-ai/cordis` (`^4.0.1 || ^4.0.5-alpha.1`),
  `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-storage-domain`, `@deepseek-ai/dsh-tools`
  — these are provided by the host; the plugin does not bundle them
- `dependencies.zod` (`^4.4.3`) is the only runtime dependency actually installed
- The storage stack must be composed in the profile: `@deepseek-ai/dsh-storage` + `@deepseek-ai/dsh-storage-json` (with `root`)
  + `@deepseek-ai/dsh-storage-domain` (with `backend: json`). Missing it does not crash anything, but the plugin degrades to
  "storage unavailable" and the settings page states the reason (see the storage section below)

## Configuration

The settings page gains a "**灵台**" (Persona & Memory) section (`settings.section` id = `anima-settings`, order 51).

### What the settings page looks like

One page cannot hold all of it, so it is split into **four sections** behind a persistent tab strip at the top:
**Persona / Memory / Behavior / Advanced**.

- **Persona**: one-click presets, assistant identity, about you, reply style (presets come first — the first thing people usually do is apply an existing set and then tweak it)
- **Memory**: long-term memory (including pending proposals, the remembered list, the checkup, importing memory from other AIs, and injection status)
- **Behavior**: answer check, input-box light trail
- **Advanced**: workspace overrides, injection report

Pinned below the tabs there is also an always-visible **"Change log"** strip that belongs to no section — it stays put
whichever tab you are on. Collapsed it shows the last 3 entries ("which field went from what to what, by whom, when");
"expand" fetches the full list and is also the only place the clear button appears. It exists because of one sentence
from the user: "I have no idea what actually got changed". A check entry point should not live somewhere only people who
already know it exists can find it.

Clicking a tab only switches **which cards are visible**; the others are still rendered and merely get `display:none`.
This is deliberate: actually unmounting them would throw away unsaved form values and card collapse state, so a user who
peeks at Memory and comes back would lose whatever they had just typed.

The active section is stored in `localStorage` under `dsh-anima:active-section` (a bare string, not JSON), and the next
visit reopens on that tab. If the stored value is not one of the five (corrupted, or left over from an older version) it
falls back to the **first** section — an unrecognised string must never blank the page.

**A single save bar sits at the bottom**, always visible, and does not scroll away with the cards:

- the left half states the situation: "No unsaved changes" / "Unsaved changes" (in the warning colour when dirty)
- the right half has two buttons: "Reset" and "Save", with Save greyed out when there is nothing to save

This one entry point is the **only** save/reset control on the whole page. Previously the save buttons were scattered
across four cards for a total of six places, and four of them called the same function — the user had to work out *which
card am I on* before knowing which button to press, and after the section split that card may not even be on screen.
**Workspace overrides have their own dirty state** (they write a workspace file, not the global config), but from the
user's point of view both mean "I changed something and it is not on disk yet", so one bar reports and saves both.

The "Save overrides" / "Clear overrides" buttons stay on the card — that is a separate pair of workspace-only actions
with different wording, so it is not a duplicate.

- **Assistant identity** (`## 助手身份`): `enabled` / `agentName` / `agentRole` / `addressUserAs` / `userOccupation` / `userBio`
- **Reply style** (`## 回复风格`): `style` / `headingLists` / `emoji` / `tables` / `replyLength` / `language` / `customInstructions`
- **Workspace overrides**: `workspaceOverridesEnabled` / `workspaceFileDir`
  The override file is written to `<workspace>/.dsh-anima/override.json` by default (the directory name is configurable through `workspaceFileDir`), travels with the directory, can be committed to git, and can be handed to someone else;
  that directory is automatically added to `.gitignore` (with the content `*`), so that private tone settings are not pushed to a remote.
- **Input-box light trail**: `trailEnabled` / `trailColor` (`#RRGGBB`, normalised to uppercase on disk) / `trailSpeed` (`slow|normal|fast`) / `trailWidth` (`thin|normal|thick`)
- **Tool confirmation**: `requireToolConfirmation` — when enabled, the model calling `set_assistant_persona` only **submits a proposal** and does not write the config
- **Long-term memory**: `memory.enabled` / `autoCapture` / `nightlyTriage` / `nightlyHour` / `maxPending` /
  `maxInjected` / `maxInjectedChars` / `notifyOnSessionStart` / `defaultLayer`
- **Answer check**: `quality.enabled` / `quality.ledgerLevel` (`off|three|five`) / `quality.strict` /
  `quality.preStepCheck` / `quality.maxFindingsInReminder`

All five `quality.*` keys can be changed with `/anima set quality.ledgerLevel=five`, and all five appear
on the "Answer check" card in the settings page. The UI is not decoration: this layer **inserts messages
into your conversation on its own initiative**, so the user needs a kill switch that requires neither
hand-edited JSON nor a restart. When false positives pile up the right move is to turn off `strict`
(which only adds R08 / R11 / R12, the three partial rules) rather than the whole layer — but if there are
enough false positives that you want the layer off, **turning it off is correct**: a checker that cries
wolf is worse than no checker.

### Card collapse: the default depends on whether you are here to change or to look

Every card on the settings page has a "Collapse / Expand" button in its top-right corner. **The default is not
uniformly open or uniformly closed** — it follows whether the card is there to **change** something or to **look**
something up:

- Cards you come here to change open by default: identity, about you, reply style, presets, input trail, workspace overrides, long-term memory, answer check
- Cards you come here to read stay closed: what the assistant actually sees

The reasoning comes straight from the user: "every normal human opening these settings is here to change the thing
the setting is about, e.g. the persona tab to change the persona". A card that is closed by default should not be
the first thing the user wants to touch, and a card that is open by default should not be a read-only list.

In code it is a one-line table: `const DEFAULT_COLLAPSED = { mem: false, preview: true }`.
Any card not listed opens — a newly added card being visible beats being hidden.

**The long-term memory card itself opens by default**, because its switches, caps and the nightly tidy all live there —
that is "something you change". Inside it are three independent panels, each with its own toggle, unaffected by the
card's collapse state:

- the "Remembered (N)" list: **no toggle at all**, rendered inline
- "Injection status": closed by default (`state.showInjection: false`); clicking it is what fetches the data
- "Import external memories": closed by default (it only opens when `memoryImport.open` is `true`)

That is two levels — the card opens, the panels toggle — not three. Wrapping the panels inside a collapsed card too
would make it three clicks deep and *harder* to reach, not tidier.

**Once the user flips it by hand, the user wins.** The toggle records the state **after** the flip rather than
"unsetting" it — deleting the key means "back to the default", which only looks like a flip when the default happens
to be the opposite. The intent behind pressing the button is always "flip it". So flipping back to the default state
is **written down** as well (the value is `false`, not a deleted key):

- a preview card that is closed by default, once expanded by hand, records `preview: false` and stays expanded next visit
- a card that opens by default, once collapsed by hand, records `mem: true` and stays collapsed next visit

The state lives in `localStorage` under `dsh-anima:card-state`, shaped like `{"preview":false,"mem":true}`.
That key **only records cards the user changed by hand**; untouched cards take no entry, and their default comes from
`DEFAULT_COLLAPSED` in the code, so adding a new card later needs no migration — as long as its default is open it is
simply visible.

Dirty values are discarded: anything that is not a boolean (`0`, `"yes"`, a nested object) is treated as unset and
falls back to the card default — one hand edit of `localStorage` must not make a card permanently unopenable. The key
was renamed from the older `dsh-anima:collapsed-cards` to `dsh-anima:card-state`: the old key recorded "collapsed",
and under the new rule "collapsed" is the default state, so keeping the old key would leave cards that were manually
expanded before this version permanently collapsed.

**Collapsing affects only that card's content, never its form values.** While collapsed the `children` are not
rendered, but form values live at the settings-page top level, so collapsing cannot lose what you just typed. Section
switching uses `display:none` rather than unmounting; the two mechanisms differ, but the outcome is the same: peek at
Memory, come back, and whatever you had edited is still there.

The two ways of hiding things have **opposite** semantics, and a code comment says so to stop a later reader from
unifying them: a card's `collapsed` renders nothing at all, while section switching's `hidden` is `display:none`.
The first is a deliberate collapse by the user (the card header has to stay visible so they can expand it again);
the second is a tab switch, which must keep the tree or every unsaved form value is lost.

### No migrations at all

This plugin **reads no config belonging to another plugin, nor to an earlier version of itself**. It released 1.0.0, and every release from 1.0.0 through 2.1.19 uses exactly the same storage format (`DOMAIN_VERSION` is 1 in both, with identical specs for the config / memories / meta / audit tables) — there is no "existing user's medium" to stay compatible with, so the code carries neither one-shot migrations nor storage-format fallback. Both existed during development and were deleted; the only thing keeping them would achieve is making later readers believe a population of legacy users exists.

If a storage format bump ever becomes necessary: change only `DOMAIN_VERSION` in `lib/store.mjs`, and **decide first what happens to existing users' media** — that decision must not be improvised after release, because by then the media is already on their machines. For the shape of such a solution, see `某同生态插件` in the same ecosystem (dual-spec serial fallback).

### All twelve fields are free text

The six fields `style` / `headingLists` / `emoji` / `tables` / `replyLength` / `language` are **no longer dropdowns**;
what they store is the very sentence to be injected into the prompt. Before the change they were enums (`style: 'roast'`); after it,
`style: '毒舌吐槽；直白指出问题、不留情面，但始终对事不对人。'` — write it however you like,
as long as you stay within the field cap (`agentName` / `addressUserAs` / `userOccupation` 50 characters each, `userBio` 500,
`agentRole` / `style` 800 each, `headingLists` / `emoji` / `tables` / `replyLength` / `language` 300 each,
`customInstructions` 2000 — see `FIELD_LIMITS` in `lib/config.mjs` for the exact per-field values).

Leaving a field empty is a legitimate state, and **an empty string means "say nothing about this" in the prompt**: the model uses its own judgement, instead of having its attention consumed by "please handle headings in the default manner". This is also how the `default` level of the three traits is implemented — it is not an enum whose value is `'default'`, but an empty string.

An empty input box discourages people, so every field has a row of buttons beneath it:

| Button group | Source | What clicking does |
|---|---|---|
| **One-click fill** | `WORDING_TABLES` in `lib/wording.mjs` | Fills in a **finalised sentence** (the sentence of the original level); you can keep editing afterwards |
| **Example** | `FIELD_EXAMPLES` in `lib/wording.mjs` | Fills in a passage of **first-person text that is obviously someone else's**, for you to rewrite as your own |

Both groups are delivered to the settings page by `GET /api/anima/state`; the client **does not keep its own copy of the wording table** — otherwise, changing the host and forgetting the client would put two different phrasings on screen, while the one actually injected is the host's.

`agentName` deliberately **gets no example**: a button that fills in a name is very likely to be left unchanged by the user, leaving the AI permanently using a name someone else chose; this field relies on a placeholder to indicate the format instead. The `default` level likewise generates no button — turning an empty wording into a button would suggest that clicking it yields something, when in fact it only clears the input box.

**Backward compatibility with old configs**: upgrading does not mean "quietly reverting the user's style to the default". `migrateConfig` automatically translates the level keys stored by older versions
(`'professional'` / `'more'` / `'default'` …) into the corresponding wording, so the text injected into the prompt is unchanged character for character;
sentences the user wrote themselves do not match any level key and are preserved as-is.

`requireToolConfirmation` and the four `trail*` fields **deliberately do not take part in workspace overrides**: one is a safety switch and the others are UI preferences (and they must be closed sets — they are keys handed to CSS). Neither should be silently swapped just because "you changed workspace".

`maxInjectedChars` (default 4000, in characters) and `maxInjected` (default 40 entries) **take whichever comes first**:
with a count constraint alone, 40 long memories can still blow up the context. The two `0` values do **not** mean the same thing:

| Field | Meaning of `0` |
| --- | --- |
| `maxInjectedChars` | No character limit (only the count cap applies) |
| `maxInjected` | **Inject nothing at all** — this also disables every memory injection; use `memory.enabled` to pause memory |
`defaultLayer` decides whether new memories are recorded as `global` or `workspace`; the default of `global` is deliberate —
treating "memory keeps losing an entry" as the default experience is harder to diagnose than cross-workspace contamination.

The remaining 12 fields can be overridden per workspace, and the override is **field-level** — a workspace declares only the fields it cares about and inherits the rest from global.

Config persistence: **only** through `storageDomain` (domain `anima` — note the underscore; the host's domain-name validation accepts only `^[a-z][a-z0-9_]*$`, so a hyphen is rejected).

**Lazy resolution** (matching `某同生态插件`'s approach): the service is not resolved during `apply`, but only via `ctx.get('storageDomain')` on first real use.
`dsh-storage-domain`'s `apply` body is `ctx.inject(backendServices, …)` plus `provide('storageDomain', …)` inside the callback,
where `backendServices` comes from `storage.backend.json` (provided by `storage-json`). If this plugin loads before `storage-json`,
that single `ctx.get()` during `apply` is bound to return `undefined` — and this is precisely the root cause of the silent storage-backend degradation on the 2026-10-10 cold start:
the older version degraded to the file backend after a null check, and also **memoised that outcome permanently**, so the user's config sat in the old file and could not be read.

The contract now: a missing service ⇒ throw `StorageUnavailableError('storage-not-composed')`, and **never switch persistence locations**;
failures are **not** memoised (so a later call succeeds once the service becomes ready); only success caches the domain handle.
When `index.mjs`'s `apply` hits it on the first `reload()`, it attaches cordis' native readiness signal
`ctx.inject(['storageDomain'], …)` and retries after the service is provided (while a dependency is not ready the fiber stays PENDING, and the callback fires the moment the service is provided — verified in this repository with a real cordis probe). During that window the five sections return an empty string — better not to inject at all than to impersonate the default level.

**No old-data rescue**: when `storageDomain` becomes available depends on load order, so the same person may have written config to a different landing spot in the early days. But every release from 1.0.0 through 2.1.19 shares the same storage format (DOMAIN_VERSION is 1, the same four tables), so there is no orphaned medium to rescue — so opening the domain imports nothing and archives nothing; it just opens its own domain. If a migration ever does become necessary, the only safe shape is: act **only when the new domain has no `config` record**, and let every failure inside it be a `warn` rather than a throw (this code sits inside the domain-open `try`, so a throw would be wrapped as the *new* domain's `open-failed` and stall a plugin that should work fine).

**The unavailability reason is inspectable**: the `source` section of `GET /api/anima/state` carries `reason` (an error code) and `message` (the raw error),
with values `storage-not-composed` / `vocabulary-unavailable` / `open-failed: <raw error>`;
on the normal storage path both are `null` and `kind === 'storage'`. The settings page turns this into plain language and shows it below "Storage location".
When storage is unavailable that route returns **503 + `code`** rather than an empty 500 shell — the settings page needs it to distinguish "the plugin isn't running" from
"it is running but the storage stack isn't composed": the former calls for a reinstall, the latter is fixed by adding the three lines `storage` / `storage-json` / `storage-domain`.

**A single format stamp, with no fallback**: the `single` layout of `storage-json` **hard-compares** the version stamp when opening —
`unit.version !== descriptor.version` throws `version-mismatch` outright, with no automatic migration whatsoever. This plugin's domain version is **always 1**
(`DOMAIN_VERSION` in `lib/store.mjs`) and declares exactly one spec with no serial fallback: 1.0.0 through 2.1.19 carry the same format stamp, so there is no such thing as
"an existing user's v2/v3 medium" to read.

During development there was a compatibility fallback (`open()` attempted **serially** over `[v3, v2, v1]`, continuing only on `version-mismatch`);
it was deleted together with the unreleased v2/v3 formats. The lesson from that code is kept here because it will be needed the day the format does change:
**declaring `compatibleVersions` amounts to writing nothing** — it is read only by `acceptedStamps()` of the per-record layout, and the single layout's
`parse()` does not look at it at all. Genuine multi-version support means declaring **two specs** the way `某同生态插件` does (primary + tolerant),
and the tolerant spec must declare **all four tables** — `DomainImpl.table()` throws outright for an undeclared table, and missing one blows up at the next
`table('audit')` call.

**Two numbering schemes — do not confuse them**: the plugin's own version is the semver in `package.json` (`2.1.19`, the badge in the top-right of the settings page);
the storage format stamp is a single digit (currently 1). The two are unrelated. Wherever the format stamp appears in the UI it is written "storage format vN",
and wherever the plugin version appears it carries a decimal point — mixing them as "this build's v3" leaves the user unable to tell which number means their
installed plugin is out of date. The zero-reference `CONFIG_VERSION = 3` in `lib/config.mjs` was deleted for exactly that reason: to avoid manufacturing a second "v3".

**Two numbering schemes — do not confuse them**: the plugin's own version is the semver in `package.json` (`2.1.19`, the badge in the settings page header), while the storage format stamp is a single digit (1 / 2 / 3). The two are unrelated. Everywhere the format stamp appears the UI says "storage format vN", and everywhere the plugin version appears it carries a decimal point — mixing them as "this build is v3" leaves the user unable to tell which number is telling them their plugin is old. The unreferenced `CONFIG_VERSION = 3` in `lib/config.mjs` was removed precisely so a second "v3" is not manufactured.

## Prompt sections

| section name | order | Content |
|---|---|---|
| `anima:identity` | 10 | The assistant's own name and role (workspace-overridable; evaluated live at assembly time) |
| `anima:memory` | 20 | Adopted long-term memories |
| `anima:pending` | 21 | Notice of how many entries await review (**count only, no content**) |
| `anima:remember` | 22 | When to call the remember tool and which fields it takes (without this the model does not know the entry point exists) |
| `anima:quality` | 30 | The twelve rules plus the three-tier ledger rules (this whole section disappears when `quality.enabled` is off) |

Deliberately placed before `PLAN_POLICY` (500): persona is "who I am", and it should be established before behavioural policy.

## Commands and tools

- `/anima [show|pending|adopt <id>|discard <id>|mark <id> type=… state=…|triage|patrol|retrospect|checkup|audit|name <名字>|enable|disable|set <key>=<value>|confirm|reject|reset]`
- Tool `remember(text, note?, scope?, type?, sourceRef?, verifyAt?)` — delivers a candidate to the pending buffer
- Tool `set_assistant_persona(...)` — lets the model change the assistant persona; with "tool confirmation" enabled it only records a proposal,
  which takes effect only after the user runs `/anima confirm` or clicks "Confirm" in the settings page

Four commands are easy to confuse; they are distinguished by **what they inspect**:

| Command | What it inspects |
|---|---|
| `/anima show` | The plugin's state right now (config, storage, injection, check counters) |
| `/anima audit` (`/anima 检查`) | Whether **my last answer** broke any of the twelve rules |
| `/anima checkup` (`/anima 体检`) | Whether **what has been recorded** still holds (paths / review dates) |
| `/anima patrol` (`/anima 巡夜`) | Runs a full patrol and states on the spot why it stayed silent or what it reported |
| `/anima retrospect` (`/anima 复盘`) | **Scans old sessions** for things you said that were never written down |

The first two inspect "what I said"; the third inspects "the data in the store"; the fourth decides whether to report to you;
the fifth looks back at old sessions and only produces leads. The first three change no state at all; a patrol does run triage
(it may touch the buffer), a retrospect reads session logs on disk, but neither ever makes a decision for you.

`/anima show` is a read-only diagnostic command: **when the storage stack is not composed, it is precisely the command that most needs to work** — it is how the user learns
"the plugin is here, it's storage that isn't connected", so it tolerates load failure and prints the reason together with the "the above are built-in defaults" notice.

## UI mount points

| Slot | id | order | Content |
|---|---|---|---|
| `settings.section` | `anima-settings` | 51 | The "灵台" settings page |
| `conversation.input.left` | `anima-quick-toggle` | 51 | The "persona on / persona off" quick toggle at the left of the input box |
| `conversation.input.overlay` | `anima-trail` | 51 | The input-box light trail (lights up only while the assistant is running) |

All three ids are kept apart from their `某同类人设插件` counterparts: `settings.section`'s documentation states that "reusing an existing id replaces that cell",
so a collision would displace the other's settings page.

**The settings navigation icon** is implemented by DOM replacement (constant prefixes `data-an-settings-nav` / `data-an-icon-replaced`):
the shell's navigation icon is a hard-coded id → icon mapping, and a plugin cannot declare its own icon through a slot.
This is a nice-to-have capability, so the code checks at the entry point whether `document.querySelectorAll` exists and, if not, takes over nothing at all
— the whole client must never fail to load just because an icon cannot be drawn.

**Why the light trail carries three self-guards**: it hangs off the input-box card, and a miscalculated size or position could feed back into the host's layout,
so the implementation has three gates — an inline `cssText` that pins 12 key properties (against third-party stylesheet overrides),
`disable()` outright when a dimension exceeds `TRAIL_MAX_SIDE` (against size positive feedback), and a post-mount self-check on
`getComputedStyle(svg).position === 'absolute'` (against style overrides).

## Exposed service

```js
const svc = ctx.get('animaConfig')
await svc.getEffective()              // the effective persona after merging global + the current workspace
await svc.getConfig()
await svc.updateConfig(patch)
await svc.resetConfig()               // same path as the settings page's "Restore defaults", and it preserves user presets too
await svc.getSystemPrompt(workspace)  // the persona text the model actually sees right now (aligned with all five sections)
await svc.listPending()
await svc.runTriage()
```

`getSystemPrompt(workspacePath)` gates exactly like the `anima:identity` / `anima:memory` / `anima:pending` /
`anima:remember` / `anima:quality` **five** section functions — otherwise this service would answer with text the **model cannot actually see**,
which is worse than not offering it at all. (This really was missed once: when the quality section was added only
`registerSystemPrompt` was updated, and `getSystemPrompt` plus `/api/anima/preview` were forgotten, so the preview did not show the
rules the model would actually receive. Two places made the same mistake independently — which means this kind of "one piece of text
with several exits" must be locked by tests, not by memory.)

## Development

These scripts run **in the source repository** (`scripts/` and `pnpm-lock.yaml` are not part of the npm release —
the published package holds 20 files: `index.mjs` / `lib` (12 `.mjs` files) / `client/index.mjs` / `assets/icon.svg` / `cordis.patch.yml` / `package.json` /
`LICENSE` / `README.md` / `README_EN.md` — that number comes from `npm pack --dry-run`, not from counting by hand):

```bash
node scripts/verify-core.mjs        # pure-function regression (188 cases)
node scripts/smoke-host.mjs         # host-side smoke test (100 cases; runs apply for real with a fake ctx)
node scripts/check-client-i18n.mjs  # client dictionary completeness + zh/en symmetry (zh=en=316 keys)
node scripts/smoke-client.mjs       # client render smoke test (52 cases; fake __ModuleLoader__ + the real hooks runtime)
node scripts/acceptance.mjs [--url <host>]              # acceptance: every suite + live state + source/install SHA256 parity
node scripts/check-hook.mjs [session file] [--since <ISO>]  # quality-hook liveness (ALIVE / DEAD / UNDETERMINED)
node scripts/remind-effect.mjs [session file]           # measure whether notices change writing behaviour (noisy)
node scripts/audit-response.mjs --text-file <file>      # judge a text against the twelve rules (for humans)
node scripts/trace-sources.mjs [--apply]                # trace memory sources (LCS matching, not exact matching)
node scripts/backfill-types.mjs [--apply]               # batch backfill of memory type / verifyAt
node scripts/check-live.mjs         # live acceptance (older; superseded by acceptance.mjs)
```

The five verdict scripts each have an honest boundary; do not conflate them:

- **UNDETERMINED from `check-hook.mjs` is not a pass.** Without a `--since` boundary it cannot tell "answers written under
  the old code" from "the new code should have caught it but did not", so it refuses to rule — **unknown is not broken**.
  Only injected messages carrying the `[dsh-anima 质检]` prefix count as evidence; triage notices do not
  (an earlier version counted every anima-injected message as a notice, so an unrelated background notice could flip the
  verdict to ALIVE).
- `remind-effect.mjs` ratios **drift as the session grows**, and the denominator is usually only one or two dozen, so two
  answers can flip the sign. It can only rule out "no effect at all"; it cannot prove an effect, and "wrote a block" is not
  "wrote it correctly".
- `audit-response.mjs` is for humans; the plugin itself **does not call it**. Its exit codes 0/1/2 mean clean / findings /
  unreadable input, and `--json` gives a machine-readable verdict.
- `trace-sources.mjs` uses the **longest common substring** (threshold 10 characters) rather than exact matching — the memory
  store holds a rewritten, compressed version, so a byte-identical match would never succeed. Its output has three tiers:
  `user's own words` / `assistant paraphrase (original not found)` / `unverifiable`. **"Assistant paraphrase" does not mean
  false**, only that no original could be found to check against.
- `acceptance.mjs` always prints what it did **not** verify at the end. That section is not a disclaimer but a list for you to
  audit against — everything listed there is precisely what it did not prove.

The first five run out of process and can only prove "the code is written this way". **`acceptance.mjs --url` and `check-hook.mjs`
prove "the copy of the code in the process actually takes effect"** — there has been a case where the installed copy was stuck on an
old version and not one of the newly added routes was registered, while every unit test was still green; and an earlier case where
the unit-test fixture copied the wrong event shape, so the hook always received an empty string and the tests were still green.
**A fixture must copy reality, never copy the implementation.**

The assertions in `check-live.mjs` deliberately **do not pin specific values**: the name is your asset, and what the script guards against is "the data is gone",
not "you renamed it". Likewise, for contract changes such as "which fields the model may change", the assertion counts entries rather than enumerating their content;
route counts work the same way — it names the key routes and checks they are registered, but **does not pin a total**, otherwise every new route would mean coming back to edit that number.

`verify-core.mjs` and `smoke-host.mjs` both resolve the host's built-in packages
(`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-storage-domain`) to local stand-ins through `scripts/tools-loader.mjs` — those packages exist only inside the host's
asar and cannot be resolved outside DSH; once installed into a profile the real packages are used instead, which `check-live.mjs` covers.

## Route guard

This plugin's HTTP routes read and write persona configuration and memory content, while the host webserver **carries no authentication of its own**
(`@deepseek-ai/dsh-host-webserver`'s README, verbatim: *the server carries no TLS,
authentication, or origin policy of its own*), and the default configuration may be bound to `0.0.0.0`.
Each route therefore adds its own guard (`index.mjs:467` onwards), with three gates — failing any one yields 403:
a **non-loopback origin** is always rejected; a request carrying `Sec-Fetch-Site` whose value is not `same-origin` is rejected (browsers send this header on cross-site requests, it takes effect earlier than `Origin`, and it also covers cases such as `no-cors`); and a request carrying `Origin` must additionally have the http(s) protocol, a loopback host, and an `Origin` exactly equal to `Host`.
**A loopback request without `Origin` is allowed through** — local scripts (curl / PowerShell) fall into this category, and this is deliberate: the guard blocks **browser cross-site** requests, not local users. The approach matches the ecosystem
(`@michengai/dsh-skills-manager` and `@linxin666/dsh-remote-web-ui` use comparable implementations).

## Confirmation for destructive actions

`POST /api/anima/config/reset` requires the request body to carry an explicit `{"confirm": true}`; an empty body always yields
**400 + `code: "confirmation-required"`**, without touching a single field. The "Restore defaults" button in the settings page first shows a confirmation dialog and only carries that field once it is accepted. The semantics match `某同生态插件`'s fail-closed behaviour:
without an unambiguous confirmation, do nothing — and explain what would make the request valid.

A reset **preserves user-created persona presets** — behaviour aligned with `某同类人设插件`'s 重置时保留用户自建人设的函数;
presets are assets the user accumulated one by one, and resetting tone settings should not wipe them out as well.

> This safeguard comes from a real incident: to check whether the routes were registered, each write route was probed with `POST {}`, and
> `/config/reset` returned 200 on the spot and cleared `agentName` / `agentRole` / `addressUserAs`.
> There are now three lines of defence: the route demands an explicit confirmation, `smoke-host.mjs` asserts that an empty body must not change any field, and
> `check-live.mjs` probes it at runtime and restores in place if the fields were really cleared.

## Known boundaries

- Configuration writes are **non-atomic** (no tmp+rename); on the `storageDomain` path this is guaranteed by the backend.
- `anima:pending` reports only the count and does not expose candidate content — this is deliberate, to keep unadjudicated content from influencing answers.
- **A message without `id` does not mean "this message was dropped" — it means "the whole session will not open".**
  When loading a session the host's `assertMessageEventShape` requires a non-empty `id` and throws
  `session event at seq N lacks an identified message` (`_tmp_sessionfix/_extract/dsh-session__lib__index.js:1201`).
  Nothing validates at write time, so a malformed message lands silently and only blows up the next time the session is opened.
  The plugin now owns the `id` via `randomUUID()` (`createNoticeMessage` in `lib/injection.mjs`), pinned by three
  regressions in `verify-core` (has id / two calls differ / role and source still compliant).
  Historical bad data (seq 6104 and 6301 on this machine) was repaired by **rewriting the session archive**, not by the plugin
  healing itself — users who already have bad data will not be fixed by upgrading, which is recorded here so nobody misjudges it later.
- The upward search for the workspace override file is limited to 32 levels.
- The route guard assumes requests pass through the host webserver; if the host later gains a reverse proxy in front, `remoteAddress`
  will become the proxy's address and this guard needs adjusting accordingly.

**What the check layer cannot do** (written here because "assuming it does" is far more dangerous than it not doing so):

- **It cannot stop the current turn.** The hook sees an answer that has already been persisted; it can only remind in the next message.
- **It judges shape, not content.** It can find "there is a number but no source"; it cannot find "this number is wrong".
- **R03 / R05 / R06 / R07 / R10 can never be judged by a machine**, and the code always states "these five were not checked".
- **"Zero notices" does not mean "nothing wrong".** Look at `qualityStats.checks`: `checks === 0` means none of it is running.
- **There is no solution that minimises false positives and false negatives at once.** The current trade-off prefers missing
  (turning `strict` off drops the three partial rules) over producing false alarms — false alarms make the user switch the
  whole layer off, at which point a miss in one place becomes a miss everywhere.

**What the memory layer cannot do**:

- **It does not decide which memory is superseded by which.** That is a semantic judgement, and doing it automatically
  would produce statements the user never made; measured on the real 21 memories the maximum pairwise similarity is
  0.094 (threshold 0.6), so an automatic detector would never fire anyway.
- **Decay only affects how an entry is shown and where it sorts — it never changes the data.** `lib/decay.mjs`
  derives a tier from `type` + the calendar: facts have a window of 0 (never age out; environment changes are
  `verifyAt`'s job), preferences 540 days, stances 365, events 180. An entry past its window gets a tag at the end of
  its injected line ("not updated in a long time" / "an earlier event") and sorts last, so it is the first squeezed out
  when the budget is tight. **It does not set `state` to superseded and it does not delete** — whether an entry still
  holds is yours to decide.
  Those three numbers have **no data behind them**; they are order-of-magnitude guesses from each type's semantics.
  After some real usage, decide whether they should become configurable.
- **Deletion is a hard delete** (`deleteMemory` → backend `delete`), not a tombstone.
  Records with `state: 'dropped'` are skipped outright by `selectForInjection` (`lib/memory.mjs:578`), so the
  "removed (tombstone)" tag **never reaches the prompt** — that branch in `formatMemoryLine` only completes the
  formatter; the injection path cannot reach it. That is not a defect: pushing deleted content back into context is
  far worse than omitting a label.
- **The patrol speaks only when there is news, and none of its criteria involve semantics.** It runs once a night
  (`scheduleNightly` → `runPatrol`): triage the buffer, run the memory checkup, then decide whether to say anything.
  The criteria live in `lib/patrol.mjs`: the **set** of pending candidates changed, the **set** of flagged memories
  changed, or this triage actually touched data. An unchanged count stays silent — three candidates sitting for a
  week re-reported nightly is pure noise. It cannot judge whether a memory still holds; that needs semantics.

**What the patrol cannot do** (written down because believing you will be told is more dangerous than not being told):

- **It does not guarantee it ran tonight.** A powered-off machine, a closed host, or storage that was not ready will
  all leave it unrun for the whole night. Silence therefore means one of two things: **it ran and found nothing**, or
  **it never ran**. Only the `meta.patrol` line separates them — an `at` from last night means it ran, an `at` stuck
  at the night before means it did not. That is what the "last patrol" line in settings is for. Conversely: **if that
  line is missing, it is not "all clear", it is "never ran"** (the client has dedicated copy for that case).
- **It does not read content for truth.** Every criterion is a set comparison (pending ids, flagged ids, whether
  triage touched data); not one of them parses what the memory says. "This memory is now wrong" will never be
  volunteered by it.
- **It does not decide which memory superseded which.** Semantic, see above.
- **It does not reschedule because you are busy.** The hour comes from `nightlyHour`. If the machine is asleep at that
  instant, or the timer is dragged to another hour by the OS, it **skips that night silently** (`index.mjs:807` only
  writes a `warn` log and returns when `nowHour !== hour`). To be precise: **the "logged as `nightly-late`" catch-up
  was never implemented** — the only mentions of it are a comment at `lib/patrol.mjs:206` and prose in this README;
  no code ever writes that value. What does exist is `reason: 'catch-up'` (`index.mjs:2561`): five seconds after the
  host starts, if today has not run yet, it runs once. That covers "today", never "last Wednesday". It does not know
  you are rushing a deadline and will neither go quiet nor wait for you.
- **It gets one shot per night.** One run; if it says nothing that night there is no second pass. For a definite
  answer, run it yourself (settings button or `/anima patrol`), otherwise you can only infer from `meta.patrol`.
  Note that a manual run **overwrites** that row: `at` becomes the moment you clicked and `reason` becomes `manual`,
  so "did it run last night" is only answerable before you run it by hand.
- **It reports "the set changed", not "this matters".** An incidental new candidate triggers a report; a genuinely
  dangerous entry that has been sitting in the list since last week does not. There is no notion of weight in the
  criteria.
- **It keeps only the latest 20 findings.** `flaggedItems` holds the compacted first 20, with the cut count in
  `flaggedDropped` surfaced in the UI. The full list requires clicking the checkup on the spot
  (`GET /api/anima/memory/audit`), which is computed live and uncapped — but it still will not rank them for you.
- **The findings do not contain the memory text — with one exception.** Normally only id, one-line detail, one line
  of evidence. The exception: when a checkup finding has no `detail`, it falls back to the memory body
  (`first.detail ?? item?.text` at `lib/patrol.mjs:189`). Every finding currently in `lib/memory-audit.mjs` supplies a
  `detail`, so that fallback is unreachable on the normal path — but the code path exists.
- **Its notice only reaches sessions that are alive at that moment.** `injectToAgents` iterates the current agent
  list; a session that was closed then never gets a backfill. "I opened it later and saw nothing" therefore does not
  mean it did not report — `delivered` and `reported` are the evidence.
- **"No report tonight" does not mean "yesterday's cleanup was noticed."** Triage-touched data is reported only when
  the previous run had not touched it (`prevTouched === 0` at `lib/patrol.mjs:139`) — several consecutive nights of
  automatic cleanup report only the first. The later counts are still recorded in `facts.removed`; they just are not
  announced separately.
- **It cannot decide whether a memory deserves to stay.** Triage only deduplicates and enforces the pending cap; it
  never deletes on "the content is useless". Everything counted in `facts.removed` comes from those two mechanical
  reasons.
