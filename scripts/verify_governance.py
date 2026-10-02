#!/usr/bin/env python3
"""Check this fork's governance artifacts without importing Kev or downloading inputs."""
import argparse
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HEADINGS = ["Repository boundary", "Session roles", "Git remotes and workflow",
            "Code Review Rules", "Agent skills", "Shared-state gate"]
BASE = ["EVIDENCE", "VERIFY", "SEVERITY", "SCOPE", "DOCS", "PR"]
FILES = ["AGENTS.md", "README.md", "CONTEXT.md", ".local/README.md",
         "docs/adr/README.md", "docs/orchestration/handoffs/README.md",
         ".github/ISSUE_TEMPLATE/delivery.md", ".github/PULL_REQUEST_TEMPLATE.md",
         "docs/agents/issue-tracker.md", "docs/agents/triage-labels.md",
         "docs/agents/domain.md", "docs/agents/build.md", "docs/agents/delivery.md",
         "docs/agents/kev-reference.md"]
SKILLS = ["kev-verify", "kev-knowledge", "kev-modal-study", "kev-pr-description",
          "thermonuclear-code-review"]
ALLOWED = set(FILES + [".gitignore", "docs/autoresearch.md", "scripts/verify_governance.py"]
              + [f".agents/skills/{name}/SKILL.md" for name in SKILLS])


def git(*args, **kwargs):
    return subprocess.run(["git", *args], cwd=ROOT, text=True, capture_output=True,
                          check=True, **kwargs).stdout


def section(text, heading):
    return text.split(f"## {heading}\n", 1)[1].split("\n## ", 1)[0].strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="origin/main", help="governance-only diff base")
    args = parser.parse_args()
    failures = []

    def check(condition, message):
        if not condition:
            failures.append(message)

    for name in sorted(ALLOWED):
        check((ROOT / name).is_file(), f"missing {name}")
    if failures:
        raise SystemExit("\n".join(failures))
    texts = {name: (ROOT / name).read_text(encoding="utf-8") for name in FILES}
    agents = texts["AGENTS.md"]
    headings = re.findall(r"^## (.+)$", agents, re.M)
    check(headings == HEADINGS, "root AGENTS must have the six ordered sections")
    lines, size = len(agents.splitlines()), len(agents.encode("utf-8"))
    check(lines <= 110 and size < 12 * 1024, "root AGENTS exceeds its line/byte budget")
    if headings == HEADINGS:
        check(len(re.findall(r"^- ", section(agents, "Code Review Rules"), re.M)) == 3,
              "expected three confirmed review rules")
        router = section(agents, "Agent skills")
        check(router.count("| Task | Required context |") == 1, "expected one skill router")
        for path in re.findall(r"`((?:docs|\.agents|skills|playground)/[^`]+)`", agents):
            check((ROOT / path).exists(), f"missing root context route {path}")
    check(git("remote", "get-url", "--push", "origin").strip() ==
          "https://github.com/Habit130/kev.git", "unexpected write remote")
    check("PRs as a request surface: no." in texts["docs/agents/issue-tracker.md"],
          "tracker triage mode changed")

    for name in [".github/ISSUE_TEMPLATE/delivery.md", "docs/agents/delivery.md"]:
        for criterion in BASE:
            check(f"**BASE-{criterion}**:" in texts[name], f"missing expanded BASE-{criterion} in {name}")
        for term in ["**P0**", "**P1**", "**P2/P3**", "no acceptable workaround"]:
            check(term in texts[name], f"missing narrow severity definition {term} in {name}")
    for heading in ["Goal", "Scope", "Dependencies", "Independent Acceptance",
                    "Ticket Criteria", "Verification Commands", "Contract Changes"]:
        check(f"## {heading}" in texts[".github/ISSUE_TEMPLATE/delivery.md"],
              f"missing issue field {heading}")
    for heading in ["Motivation", "Changes", "Verification"]:
        check(f"## {heading}" in texts[".github/PULL_REQUEST_TEMPLATE.md"],
              f"missing PR field {heading}")
    check("Closes #" in texts[".github/PULL_REQUEST_TEMPLATE.md"], "missing PR issue link")
    for label in ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"]:
        check(f"`{label}`" in texts["docs/agents/triage-labels.md"], f"missing label {label}")

    reference = texts["docs/agents/kev-reference.md"]
    check("## Instruction migration record" in reference, "missing instruction dispositions")
    baseline = re.search(r"The initialization baseline is commit `([0-9a-f]{40})`", reference)
    check(baseline is not None, "missing instruction migration baseline")
    if baseline:
        old = git("show", f"{baseline[1]}:AGENTS.md")
        migration = section(reference, "Instruction migration record")
        sources = [row.split("|")[1].strip() for row in migration.splitlines()
                   if row.startswith("| ")]
        for heading in re.findall(r"^## (.+)$", old, re.M):
            check(any(source.startswith(heading) for source in sources),
                  f"missing disposition for original {heading} section")
        for heading in ["Layout", "Notes", "Calibration Research", "Writing"]:
            check(section(old, heading) == section(reference, heading),
                  f"technical {heading} instructions were not retained intact")

    changed = set(git("diff", "--name-only", args.base).splitlines())
    changed.update(git("ls-files", "--others", "--exclude-standard").splitlines())
    check(not changed - ALLOWED, f"outside governance scope: {sorted(changed - ALLOWED)}")
    tracked = set(git("ls-files").splitlines())
    readmes = [".local/README.md", "docs/orchestration/handoffs/README.md"]
    for name in readmes:
        check(name in tracked, f"README contract is not tracked/staged: {name}")
    probes = [".local/agent-context.md", "docs/orchestration/handoffs/AC-1-v1-a1-execution.md",
              "docs/orchestration/handoffs/AC-1-v1-a1-acceptance.md"]
    ignored = set(git("check-ignore", "--no-index", "--stdin",
                      input="\n".join(probes + readmes) + "\n").splitlines())
    check(ignored == set(probes), "instances must be ignored and README contracts unignored")
    check(not any(name.startswith(".local/") and name not in readmes or
                  name.startswith("docs/orchestration/handoffs/") and name not in readmes
                  for name in tracked), "local context or handoff body is tracked")

    for name in sorted(ALLOWED):
        text = (ROOT / name).read_text(encoding="utf-8")
        if name.endswith(".md"):
            check(not re.search(r"\{\{[^\n]*\}\}", text), f"unrendered placeholder in {name}")
            check(not re.search(r"/Users/|~/dev/", text), f"machine instance in {name}")
            for link in re.findall(r"\[[^\]]+\]\(([^)]+)\)", text):
                if "://" not in link and not link.startswith("#"):
                    target = link.split("#", 1)[0]
                    check((ROOT / name).parent.joinpath(target).exists(), f"broken link in {name}: {link}")
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}")
        raise SystemExit(1)
    print(f"PASS: root AGENTS {lines} lines / {size} bytes; six sections, three rules, one router")
    print("PASS: governance artifacts, contracts, routes, migration, and ignore boundaries")
    print(f"PASS: {len(changed)} changed paths are within governance scope; product/research artifacts untouched")
    print("Host settings, credentials/privacy, Codex, and Acceptance require separate primary evidence.")


if __name__ == "__main__":
    main()
