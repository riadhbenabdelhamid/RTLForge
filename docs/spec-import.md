# Importing an existing specification

The pipeline normally asks a model for the formal spec. When you already have
one, it can be read instead: the spec stage extracts the same fields it would
have generated, and **everything after that stage is unchanged**.

```
rtlforge run --spec-file my_fifo.spec.yaml
```

In the GUI, the Spec stage carries an **Import spec file** button that does the
same thing.

Importing skips the elicit stage — an existing spec is the elicitation's
answer — and the spec stage synthesises the small elicit object later stages
read (`modName`, `domain`), so nothing downstream notices the difference.

No model is called, and nothing is spent.

## Formats

Chosen by file extension. All three carry the same fields and produce an
**identical** spec object.

| extension | format |
|---|---|
| `.json` | the stage's exact shape — round-trips with export |
| `.yaml` / `.yml` | the same fields, in a strict subset of YAML |
| `.md` / `.markdown` | a documented template of headings and tables |

### JSON

```json
{
  "modName": "sync_fifo",
  "domain": "Synchronous FIFO",
  "requirements": [
    { "id": "REQ-FUNC-001", "cat": "Functionality", "pri": "Must",
      "desc": "The module shall store a word on wr_en with full low.",
      "rat": "[derived from the description]" }
  ],
  "iface": [
    { "name": "clk",  "dir": "input",  "width": "1", "desc": "System clock" },
    { "name": "full", "dir": "output", "width": "1", "desc": "FIFO is full", "reset": "0" }
  ],
  "params": [
    { "name": "DEPTH", "type": "parameter", "def": 4, "range": "[2:1024]", "desc": "Depth" }
  ]
}
```

### YAML

A deliberately small subset: `key: value` scalars, `key:` followed by a block
sequence of mappings, `key: []`, quoted or bare scalars, `#` comments.

**Anchors and aliases, flow mappings (`{…}`) and multi-line scalar blocks
(`|`, `>`) are refused with a line number.** The project carries no YAML
dependency, and a reader that silently mis-parsed a construct it did not
understand would be far worse than one that says which line it cannot read.

```yaml
modName: sync_fifo
domain: Synchronous FIFO
requirements:
  - id: REQ-FUNC-001
    cat: Functionality
    pri: Must
    desc: The module shall store a word on wr_en with full low.
iface:
  - name: clk
    dir: input
    width: "1"
    desc: System clock
  - name: full
    dir: output
    width: "1"
    reset: "0"
    desc: FIFO is full
params:
  - name: DEPTH
    type: parameter
    def: 4
    range: "[2:1024]"
    desc: Depth
```

### Markdown

A level-1 heading names the module. `## Requirements`, `## Interface` (or
`## Ports`) and `## Parameters` each hold a table. Column order does not
matter, and common header spellings are accepted (`Cat`/`Category`,
`Pri`/`Priority`, `Dir`/`Direction`, `Default`/`Def`, `Desc`/`Description`).
A column that is not read produces a warning rather than being dropped
silently. A literal `|` inside a cell is written `\|`.

```markdown
# sync_fifo
Domain: Synchronous FIFO

## Requirements
| ID | Cat | Pri | Description |
|----|-----|-----|-------------|
| REQ-FUNC-001 | Functionality | Must | The module shall store a word on wr_en with full low. |

## Interface
| Name | Dir | Width | Reset | Description |
|------|-----|-------|-------|-------------|
| clk  | input | 1 | | System clock |
| full | output | 1 | 0 | FIFO is full |

## Parameters
| Name | Type | Default | Range | Description |
|------|------|---------|-------|-------------|
| DEPTH | parameter | 4 | [2:1024] | Depth |
```

## What the file must contain

- **`modName`** — a valid SystemVerilog identifier. Every later stage names
  its files and its module after it.
- **At least one requirement**, each with:
  - `id` of the form `REQ-<CAT>-<NNN>`, where `<CAT>` is one of `INTF`,
    `FUNC`, `TIME`, `ERR`, `VERIF`. Ids must be unique.
  - `pri` — `Must`, `Should` or `May`.
  - `desc` — what a test will actually check.
- **At least one port**, each with a `name` (a valid identifier), a `dir`
  (`input`, `output` or `inout`) and a `width` (`"1"`, or a parameter
  expression).
- **Parameters are optional**, but each needs a `name` when present.

## When it fails

A problem in your file **stops the run**. Nothing is generated, and every
problem is reported against the line and field at fault:

```
error: cannot import the specification from my_fifo.spec.json
✗ my_fifo.spec.json:4 (requirements[0].pri) — requirement REQ-FUNC-001 has priority "Urgent" — expected Must, Should or May
✗ my_fifo.spec.json:9 (iface[0].dir) — port "clk" has direction "in" — expected input, output or inout

Nothing was generated — correct the file and run again.
```

The file is yours, so guessing at what you meant is exactly what importing a
spec is supposed to avoid.

Two things are **warnings** rather than failures, because the pipeline handles
them itself:

- a `cat` that disagrees with its id prefix — the id wins, and the category is
  corrected, the same way it is for a generated spec;
- an output with no stated `reset` behaviour — allowed, but the RTL and the
  testbench will each assume one, and any disagreement is an irreducible test
  failure.

## Exporting

`rtlforge export <projectId>` writes the spec alongside the RTL, in all three
formats:

```
<module>.spec.json
<module>.spec.yaml
<module>.spec.md
```

The GUI's regression bundle carries them under `spec/`. Whether the spec was
imported or generated, an exported one can be edited and fed straight back in
with `--spec-file` — the round trip is pinned by tests in
`tests/specExport.test.js`.
