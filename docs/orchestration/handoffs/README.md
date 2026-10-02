# Orchestration handoffs

This README and naming contract are tracked. Frozen handoff bodies are local,
gitignored owner-machine artifacts, not a second acceptance-contract body.

```text
AC-<issue>-v<contract>-a<attempt>-execution.md
AC-<issue>-v<contract>-a<attempt>-acceptance.md
ORCH-<scope>-<timestamp>.md
```

After freezing a file, record its repository-relative path, contract version, role,
attempt, and SHA-256 on the issue. A published digest makes the file immutable; create
a new version or attempt rather than overwrite it. Acceptance verifies the digest and
exact delivery head. Only habit starts that fresh session.

Handoffs are not transferred by Git. On another machine, habit must supply the exact
artifact; verify its published digest before starting. Never publish credentials or
private data in handoffs or GitHub records.
