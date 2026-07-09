# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Riadh Ben Abdelhamid
#
# slang_check.py — full-recovery SystemVerilog diagnostics as JSON.
#
# Why this exists (measured, nemotron e2e runs 6 & 8): Verilator stops at the
# first syntax error, so a fix loop only ever sees one defect per iteration —
# run 6's TB burned its whole fix budget on a string-decl syntax error and the
# fixer never learned the bench also forgot to declare clk/rst_n/en. slang
# parses with error recovery and reports EVERYTHING in one ~1 ms pass, in
# plain English ("declaration must come before all statements in the block").
#
# Usage: python slang_check.py file1.sv [file2.sv ...]
# Output: one JSON object on stdout:
#   { "ok": true, "errors": [{ "file", "line", "col", "code", "msg" }, ...] }
# Exit code is always 0 when the check RAN (defects are data, not failures);
# nonzero only when pyslang itself is unusable, so callers can tell
# "clean code" from "checker unavailable".

import json
import sys


def main() -> int:
    try:
        import pyslang
        from pyslang.syntax import SyntaxTree
        from pyslang.ast import Compilation
    except Exception as e:  # pyslang missing/broken → caller falls back
        print(json.dumps({"ok": False, "reason": "pyslang unavailable: %s" % e}))
        return 2

    comp = Compilation()
    sources = {}
    for path in sys.argv[1:]:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                sources[path] = f.read()
        except OSError as e:
            print(json.dumps({"ok": False, "reason": "read failed: %s" % e}))
            return 2
        comp.addSyntaxTree(SyntaxTree.fromText(sources[path], path))

    sm = comp.sourceManager
    engine = pyslang.DiagnosticEngine(sm)
    errors = []
    for d in comp.getAllDiagnostics():
        if not d.isError():
            continue
        errors.append({
            "file": sm.getFileName(d.location) or "",
            "line": sm.getLineNumber(d.location) or 0,
            "col": sm.getColumnNumber(d.location) or 0,
            "code": str(d.code),
            "msg": engine.formatMessage(d),
        })

    print(json.dumps({"ok": True, "errors": errors}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
