#!/usr/bin/env python3
"""Conta advisories high/critical no stream JSON do `yarn audit` (stdin).
Durabilidade: sair 1 quando o stream NÃO contém auditSummary (rede/registry
morto ou parse torto) — fail-closed em infra, não só em conteúdo (r3 M2).
Yarn1 sai rc = nº de advisories (todos os níveis) — informativo, ignorado."""
import json
import sys

n = 0
saw_summary = False
for line in sys.stdin:
    try:
        d = json.loads(line)
    except Exception:
        continue
    if d.get("type") == "auditAdvisory":
        if d["data"]["advisory"]["severity"] in ("high", "critical"):
            n += 1
    elif d.get("type") == "auditSummary":
        saw_summary = True
if not saw_summary:
    print("audit-summary-ausente (infra)", file=sys.stderr)
    sys.exit(1)
print(n)
