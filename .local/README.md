# Local agent context

`.local/agent-context.md` stores machine-specific hosts, absolute paths, model locations,
and resource instances used by local sessions. It is never committed. Other local
verification output may live here too; only this README is tracked.

Committed AGENTS and docs contain stable policy and path semantics. Credentials do not
belong in either location. An external knowledge path needs explicit authorization;
recording a path alone does not grant access.

Issue and handoff records allocate resource ownership. Local context identifies the
actual GPU/Metal device, processes, ports, environments, apps, volume paths, and cache
locations when established. Do not copy another author's resource instances here.
