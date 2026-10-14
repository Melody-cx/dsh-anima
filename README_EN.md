# dsh-anima

> 中文文档见 [README.md](./README.md)

The **Assistant Persona & External Memory Layer** for DSH — a standalone plugin: install it and it works.

It governs "**who you — the assistant — are**": the AI's own name and role, how you address it, its reply style, and any behavioural rules you write yourself; plus a **long-term memory layer with a pending-review buffer**, and UI capabilities (input-box light trail, input-box quick toggle, tool-confirmation gate). The field set depends on no other plugin and reads config from nowhere else.

> **Why the tool is named `set_assistant_persona`**: `tools.register()` throws outright on a same-level duplicate name
> (`dsh-tools/lib/index.js:2634`). Installed alongside any same-named tool, one of them necessarily fails to register
> and gets swallowed by `.catch` into a single `warn` line — that is a release-grade silent failure.
> Similar features do not require a name collision.

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
| Automatic writing of long-term memory | ❌ Deliberately not implemented (see below) |

### On the relationship with `dsh-soul`

The capability grouping above **overlaps** the field set of `dsh-soul` 0.7.0, and the implementation deliberately stays consistent with it (tool-confirmation semantics, light-trail animation parameters, presets preserved on reset). But this plugin **does not depend on it**: the field set is fully self-contained, it reads config from nowhere else, the two can be installed side by side, and all identifiers are kept apart. The full account is in [Acknowledgements and differentiation statement](#acknowledgements-and-differentiation-statement) below.

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

You can see it in two places: the "Change log" card in the settings page (the full list, clearable entry by entry), and the **"Latest change" line** in `/anima show` — one line only, in the form `[MM-DD HH:mm] <source>: <field name>`, which **deliberately carries no value**: values can be private, and `show` output is exactly the kind of thing people paste into a chat when asking for help.

## Acknowledgements and differentiation statement

This plugin's feature set **draws on** the designs of [dsh-soul](https://github.com/Aliuyanfeng/dsh-soul) (MIT) and
`dsh-checkpoint-rewind`, and deliberately keeps behaviour consistent with them in several places (lazy storage resolution, fail-closed confirmation semantics, preserving user presets across a reset, and the light-trail animation parameters).

To be explicit:

- **All code is independently implemented.** No source code, comments, prompt wording, or graphic assets were copied from the aforementioned projects.
- Two **animation parameters are deliberately given identical values** (8 staggered stroke layers, dash length 12 / step 2.2 / corner radius 22, etc.). The reason is to avoid two divergent looks on the same machine. Such numeric values are ideas and parameters, not protected by copyright; they are recorded here so that readers do not mistake them for copying.
- **The navigation icon is deliberately drawn differently**: dsh-soul uses "light-trail arc + spark", while this plugin uses "person (head + shoulders) + spark", in monochrome `currentColor`, with a separately tightened viewBox.
- **All identifiers are kept apart**, so that coexistence cannot displace or fail to register against the other:

  | Category | dsh-soul | This plugin |
  |---|---|---|
  | Tool name | `set_persona` | `set_assistant_persona` |
  | Settings page id | `soul-settings` | `anima-settings` |
  | Light-trail slot id | `soul-trail` | `anima-trail` |
  | Toggle slot id | `soul-quick-toggle` | `anima-quick-toggle` |
  | Prompt section | `soul:persona` | `anima:identity` / `:memory` / `:pending` |
  | Storage domain | — (its own file) | `anima` |
  | Injection source kind | `plugin:dsh-soul` | `plugin:dsh-anima` |

Keeping tool names apart is not mere courtesy: `dsh-tools`' `register()` **throws outright** on a same-level duplicate name
(the `NamedEntries` conflict factory in `lib/index.js`). With both installed, one necessarily fails to register
and gets swallowed by `.catch` into a single `warn` line — a release-grade silent failure.

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
`changed:false` — so the correct sequence is `remove_bundle` followed by `install_bundle` (or compare the SHA256 of the `node_modules` copy against the source). Once the package is published to npm, that line simply becomes `"dsh-anima": "^1.0.0"`.

Then `pnpm install` and **restart DSH**. Any host-side change requires a restart to take effect.

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

- **Assistant identity** (`## 助手身份`): `enabled` / `agentName` / `agentRole` / `addressUserAs` / `userOccupation` / `userBio`
- **Reply style** (`## 回复风格`): `style` / `headingLists` / `emoji` / `tables` / `replyLength` / `language` / `customInstructions`
- **Workspace overrides**: `workspaceOverridesEnabled` / `workspaceFileDir`
  The override file is written to `<workspace>/.dsh-anima/override.json` by default (the directory name is configurable through `workspaceFileDir`), travels with the directory, can be committed to git, and can be handed to someone else;
  that directory is automatically added to `.gitignore` (with the content `*`), so that private tone settings are not pushed to a remote.
- **Input-box light trail**: `trailEnabled` / `trailColor` (`#RRGGBB`, normalised to uppercase on disk) / `trailSpeed` (`slow|normal|fast`) / `trailWidth` (`thin|normal|thick`)
- **Tool confirmation**: `requireToolConfirmation` — when enabled, the model calling `set_assistant_persona` only **submits a proposal** and does not write the config
- **Long-term memory**: `memory.enabled` / `autoCapture` / `nightlyTriage` / `nightlyHour` / `maxPending` /
  `maxInjected` / `maxInjectedChars` / `notifyOnSessionStart` / `defaultLayer`

### No migrations at all

This plugin **reads no config belonging to another plugin, nor to an earlier version of itself**. It is 1.0.0 and has never been released — there is no such thing as "an existing user's medium" to stay compatible with, so the code carries neither one-shot migrations nor storage-format fallback. Both existed during development and were deleted; the only thing keeping them would achieve is making later readers believe a population of legacy users exists.

If a storage format bump ever becomes necessary: change only `DOMAIN_VERSION` in `lib/store.mjs`, and **decide first what happens to existing users' media** — that decision must not be improvised after release, because by then the media is already on their machines. For the shape of such a solution, see `dsh-checkpoint-rewind` in the same ecosystem (dual-spec serial fallback).

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

**Lazy resolution** (matching `dsh-checkpoint-rewind`'s approach): the service is not resolved during `apply`, but only via `ctx.get('storageDomain')` on first real use.
`dsh-storage-domain`'s `apply` body is `ctx.inject(backendServices, …)` plus `provide('storageDomain', …)` inside the callback,
where `backendServices` comes from `storage.backend.json` (provided by `storage-json`). If this plugin loads before `storage-json`,
that single `ctx.get()` during `apply` is bound to return `undefined` — and this is precisely the root cause of the silent storage-backend degradation on the 2026-10-10 cold start:
the older version degraded to the file backend after a null check, and also **memoised that outcome permanently**, so the user's config sat in the old file and could not be read.

The contract now: a missing service ⇒ throw `StorageUnavailableError('storage-not-composed')`, and **never switch persistence locations**;
failures are **not** memoised (so a later call succeeds once the service becomes ready); only success caches the domain handle.
When `index.mjs`'s `apply` hits it on the first `reload()`, it attaches cordis' native readiness signal
`ctx.inject(['storageDomain'], …)` and retries after the service is provided (while a dependency is not ready the fiber stays PENDING, and the callback fires the moment the service is provided — verified in this repository with a real cordis probe). During that window the three sections return an empty string — better not to inject at all than to impersonate the default level.

**No old-data rescue**: when `storageDomain` becomes available depends on load order, so the same person may have written config to a different landing spot in the early days. But this plugin is 1.0.0 — there are no "early-version users" — so opening the domain imports nothing and archives nothing; it just opens its own domain. If a migration ever does become necessary, the only safe shape is: act **only when the new domain has no `config` record**, and let every failure inside it be a `warn` rather than a throw (this code sits inside the domain-open `try`, so a throw would be wrapped as the *new* domain's `open-failed` and stall a plugin that should work fine).

**The unavailability reason is inspectable**: the `source` section of `GET /api/anima/state` carries `reason` (an error code) and `message` (the raw error),
with values `storage-not-composed` / `vocabulary-unavailable` / `open-failed: <raw error>`;
on the normal storage path both are `null` and `kind === 'storage'`. The settings page turns this into plain language and shows it below "Storage location".
When storage is unavailable that route returns **503 + `code`** rather than an empty 500 shell — the settings page needs it to distinguish "the plugin isn't running" from
"it is running but the storage stack isn't composed": the former calls for a reinstall, the latter is fixed by adding the three lines `storage` / `storage-json` / `storage-domain`.

**A single format stamp, with no fallback**: the `single` layout of `storage-json` **hard-compares** the version stamp when opening —
`unit.version !== descriptor.version` throws `version-mismatch` outright, with no automatic migration whatsoever. This plugin's domain version is **always 1**
(`DOMAIN_VERSION` in `lib/store.mjs`) and declares exactly one spec with no serial fallback: nothing was released before 1.0.0, so there is no such thing as
"an existing user's v2/v3 medium" to read.

During development there was a compatibility fallback (`open()` attempted **serially** over `[v3, v2, v1]`, continuing only on `version-mismatch`);
it was deleted together with the unreleased v2/v3 formats. The lesson from that code is kept here because it will be needed the day the format does change:
**declaring `compatibleVersions` amounts to writing nothing** — it is read only by `acceptedStamps()` of the per-record layout, and the single layout's
`parse()` does not look at it at all. Genuine multi-version support means declaring **two specs** the way `dsh-checkpoint-rewind` does (primary + tolerant),
and the tolerant spec must declare **all four tables** — `DomainImpl.table()` throws outright for an undeclared table, and missing one blows up at the next
`table('audit')` call.

**Two numbering schemes — do not confuse them**: the plugin's own version is the semver in `package.json` (`1.0.0`, the badge in the top-right of the settings page);
the storage format stamp is a single digit (currently 1). The two are unrelated. Wherever the format stamp appears in the UI it is written "storage format vN",
and wherever the plugin version appears it carries a decimal point — mixing them as "this build's v3" leaves the user unable to tell which number means their
installed plugin is out of date. The zero-reference `CONFIG_VERSION = 3` in `lib/config.mjs` was deleted for exactly that reason: to avoid manufacturing a second "v3".

**Two numbering schemes — do not confuse them**: the plugin's own version is the semver in `package.json` (`1.0.0`, the badge in the settings page header), while the storage format stamp is a single digit (1 / 2 / 3). The two are unrelated. Everywhere the format stamp appears the UI says "storage format vN", and everywhere the plugin version appears it carries a decimal point — mixing them as "this build is v3" leaves the user unable to tell which number is telling them their plugin is old. The unreferenced `CONFIG_VERSION = 3` in `lib/config.mjs` was removed precisely so a second "v3" is not manufactured.

## Prompt sections

| section name | order | Content |
|---|---|---|
| `anima:identity` | 10 | The assistant's own name and role (workspace-overridable; evaluated live at assembly time) |
| `anima:memory` | 20 | Adopted long-term memories |
| `anima:pending` | 21 | Notice of how many entries await review (**count only, no content**) |

Deliberately placed before `PLAN_POLICY` (500): persona is "who I am", and it should be established before behavioural policy.

## Commands and tools

- `/anima [show|pending|adopt <id>|discard <id>|triage|name <名字>|enable|disable|set <key>=<value>|confirm|reject|reset]`
- Tool `remember(text, note?, scope?)` — delivers a candidate to the pending buffer
- Tool `set_assistant_persona(...)` — lets the model change the assistant persona; with "tool confirmation" enabled it only records a proposal,
  which takes effect only after the user runs `/anima confirm` or clicks "Confirm" in the settings page

`/anima show` is a read-only diagnostic command: **when the storage stack is not composed, it is precisely the command that most needs to work** — it is how the user learns
"the plugin is here, it's storage that isn't connected", so it tolerates load failure and prints the reason together with the "the above are built-in defaults" notice.

## UI mount points

| Slot | id | order | Content |
|---|---|---|---|
| `settings.section` | `anima-settings` | 51 | The "灵台" settings page |
| `conversation.input.left` | `anima-quick-toggle` | 51 | The "persona on / persona off" quick toggle at the left of the input box |
| `conversation.input.overlay` | `anima-trail` | 51 | The input-box light trail (lights up only while the assistant is running) |

All three ids are kept apart from their `dsh-soul` counterparts: `settings.section`'s documentation states that "reusing an existing id replaces that cell",
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
await svc.getSystemPrompt(workspace)  // the persona text the model actually sees right now (aligned with all three sections)
await svc.listPending()
await svc.runTriage()
```

`getSystemPrompt(workspacePath)` gates exactly like the `anima:identity` / `anima:memory` / `anima:pending`
section functions — otherwise this service would answer with text the **model cannot actually see**, which is worse than not offering it at all.
It deliberately does not reuse `/api/anima/preview`: that is the **settings page's display contract** (drafts, plus fields the UI needs).

## Development

These scripts run **in the source repository** (`scripts/` and `pnpm-lock.yaml` are not part of the npm release —
the published package holds 18 files: `index.mjs` / `lib` (10 `.mjs` files) / `client` / `assets` / `cordis.patch.yml` / `package.json` /
`LICENSE` / `README.md` / `README_EN.md`):

```bash
node scripts/verify-core.mjs        # pure-function regression (136 cases)
node scripts/smoke-host.mjs         # host-side smoke test (77 cases; runs apply for real with a fake ctx)
node scripts/check-client-i18n.mjs  # client dictionary completeness + zh/en symmetry (zh=en=250 keys)
node scripts/smoke-client.mjs       # client render smoke test (41 cases; fake __ModuleLoader__ + the real hooks runtime)
node scripts/check-live.mjs         # live acceptance (requires DSH to be running)
```

The first four run out of process and can only prove "the code is written this way". **What `check-live.mjs` proves is "the copy of the code in the process actually takes effect"** —
there has been a case where the installed copy was stuck on an old version, not one of the newly added routes was registered, and every unit test was still green.
After changing the plugin you must **reinstall** for it to take effect: pnpm's `file:` dependency has **copy** semantics, and re-running `install_bundle` skips the work outright when it decides
`changed:false`; the correct approach is `remove_bundle` followed by `install_bundle` (or comparing the SHA256 of the `node_modules` copy against the source). Host-side changes always require a **full restart**; hot reload will not replace already-cached ESM modules.

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
**400 + `code: "confirmation-required"`**, without touching a single field. The "Restore defaults" button in the settings page first shows a confirmation dialog and only carries that field once it is accepted. The semantics match `dsh-checkpoint-rewind`'s fail-closed behaviour:
without an unambiguous confirmation, do nothing — and explain what would make the request valid.

A reset **preserves user-created persona presets** — behaviour aligned with `dsh-soul`'s `defaultConfigPreservingPersonas(current)`;
presets are assets the user accumulated one by one, and resetting tone settings should not wipe them out as well.

> This safeguard comes from a real incident: to check whether the routes were registered, each write route was probed with `POST {}`, and
> `/config/reset` returned 200 on the spot and cleared `agentName` / `agentRole` / `addressUserAs`.
> There are now three lines of defence: the route demands an explicit confirmation, `smoke-host.mjs` asserts that an empty body must not change any field, and
> `check-live.mjs` probes it at runtime and restores in place if the fields were really cleared.

## Known boundaries

- Configuration writes are **non-atomic** (no tmp+rename); on the `storageDomain` path this is guaranteed by the backend.
- `anima:pending` reports only the count and does not expose candidate content — this is deliberate, to keep unadjudicated content from influencing answers.
- The upward search for the workspace override file is limited to 32 levels.
- The route guard assumes requests pass through the host webserver; if the host later gains a reverse proxy in front, `remoteAddress`
  will become the proxy's address and this guard needs adjusting accordingly.
