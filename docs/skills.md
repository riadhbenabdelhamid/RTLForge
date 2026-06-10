# Skills

A **skill** is a small Markdown file that tells the pipeline how to bias an
LLM call. Think of skills as the user's house rules — "always use
`always_ff`", "prefer single-edge resets", "wrap testbenches in a class" —
applied automatically wherever the matching stage runs.

## Mental model

```
User writes a skill (markdown file)
   ↓
Pipeline node makes an LLM call for a stage
   ↓
Skill bridge looks up skills targeting that stage
   ↓
Composes the matching skills into the system prompt
   ↓
LLM produces output shaped by the skill's guidance
```

A skill never *replaces* the prompt; it *augments* it. The pipeline still
asks for "RTL code that implements this spec." The skill adds "and follow
these style rules."

## File format

```markdown
---
id: prefer-always-ff
stage: rtl_generate
workflow: rtl
when: always
---

## Style rule

Use `always_ff @(posedge clk or negedge rst_n)` for all sequential logic.
Reset is asynchronous active-low (rst_n) unless the spec says otherwise.
Combinational logic uses `always_comb`. Avoid `always` without a sensitivity
list specifier — pick one of `_ff` or `_comb`.

## Why

Keeps simulation/synthesis intent unambiguous and matches our team's
linter config.
```

YAML frontmatter is required; everything below it is the skill body that
gets appended to the system prompt at LLM call time.

### Frontmatter fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Globally unique slug. Pipeline logs reference skills by id. |
| `stage` | yes | Stage key the skill applies to. See [stage keys](#stage-keys) below. |
| `workflow` | yes | Which workflow this skill belongs to (today: `rtl`). |
| `when` | no | `always` (default), `if_failing`, or `manual`. |
| `priority` | no | Integer; higher fires first when multiple skills apply. |

## Stage keys

Skills target the artifact being generated, not the node doing the work.
That's the key design decision (V22). A user's skill for "how RTL code
should look" applies to *every* LLM call that generates RTL — whether
that's:

- the baseline RTL generation in `rtl_generate`
- the fix call inside the `lint` loop when fixing lint errors
- the fix call inside the `verify` loop when fixing test failures
- the fix call inside the `rtl_review` loop
- the regen call inside the `judge` loop when triage routes to RTL

All of these use the skill stage key `rtl_generate`, not their node name.

| Skill stage key | What it shapes |
|---|---|
| `elicit` | Question/assumption phrasing in elicit stage |
| `spec` | JSON spec format — interface/params/requirements style |
| `architect` | Architecture text + Mermaid diagram conventions |
| `rtl_generate` | All SystemVerilog RTL code, anywhere it's generated |
| `test_generate` | All testbench code, anywhere it's generated |
| `formal_props` | Assertion and cover-property style |
| `lint` | Classification of RTL lint issues |
| `lint_test` | Classification of TB lint issues |
| `verify` | LLM-based verify and test-result classification |
| `rtl_review` | RTL code-review rubric and tone |
| `test_review` | TB code-review rubric and tone |

**Triage prompts in `verify` and `judge` intentionally don't get skill
overlays** — they're structural classifiers ("which target should we fix
next?"), not creative work. User style rules would just be noise there.

## Storage

Two surfaces, same format:

- **CLI:** files on disk. Path resolution rules:
  - First match wins from:
    - `$cwd/.rtlforge/skills/<workflow>/<stage>/*.md`
    - `$XDG_CONFIG_HOME/rtlforge/skills/<workflow>/<stage>/*.md`
    - `~/.config/rtlforge/skills/<workflow>/<stage>/*.md`
- **GUI:** browser IndexedDB (per origin). The Skills tab in Settings
  edits these. Users can also upload `.md` files to seed the browser
  store.

## CLI

```bash
# List all skills, grouped by workflow + stage
rtlforge skills list

# Show one skill's parsed frontmatter + body
rtlforge skills show prefer-always-ff

# Validate a skill (frontmatter shape, body presence, no broken refs)
rtlforge skills validate path/to/skill.md

# List skills currently composed for one stage (with current config)
rtlforge skills compose-for rtl_generate

# List available workflows
rtlforge skills workflows
```

## GUI

**Settings → Skills tab.** Per-workflow listing with per-stage filter.
Click a skill to edit its frontmatter and body inline. Validate button
runs the same checks as the CLI. Save persists to IndexedDB; download
exports the .md file.

## Disabling

Set `config.skillsDisabled = true` to skip the skill bridge entirely
without removing skill files. Useful for A/B testing whether a skill
helped.

## Internal API

```js
import { createSkillBridge } from "src/skills/index.js";

const bridge = createSkillBridge({ config, workflow: "rtl", cwd });
const newPrompt = await bridge.applyOverlay(promptObj, "rtl_generate");
```

The bridge is built once per stage run by `runStage.js` (CLI side) or
`useProject.jsx` (GUI side) and threaded through `accState._skillBridge`.
Nodes that opt in call `applySkillsToPrompt(p, st, stageKey)` immediately
before each `callLLM`.
