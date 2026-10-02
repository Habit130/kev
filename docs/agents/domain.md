# Domain documentation

This is a single-context repository. Start domain exploration with root `CONTEXT.md`,
then read relevant accepted ADRs under `docs/adr/`. The Python package, playground,
Space source, and label-review tool do not establish separate domain ownership contexts.

## Layout

- `CONTEXT.md` owns confirmed repository responsibility, non-goals, related-resource
  ownership, and domain language.
- `docs/adr/README.md` owns ADR format and naming. Add an ADR only after a durable decision
  and its tradeoff are confirmed; initialization invents no architecture decisions.
- `docs/agents/kev-reference.md` retains technical instructions and the migration record.
- `PLAN.md`, model cards, and committed reports own inherited research evidence, not
  habit's present authorization or account resources.

Use the glossary's canonical terms in tickets, hypotheses, tests, and explanations.
In particular, delivery Acceptance and research confirmation are not interchangeable.
Flag conflicts with an accepted ADR or frozen contract instead of silently overriding it.
Unknown non-blocking domain detail stays omitted until it is established.
