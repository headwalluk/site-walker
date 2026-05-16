# Publishing to a public repository

site-walker currently lives on a private git server (`headgit.net:7652/headwall/site-walker.git`). If/when this repo is published to GitHub or another public host, run through this checklist before flipping it public.

## Known historical leaks

| Commit | What | Status |
|--------|------|--------|
| `532acf8` | `DB_PASSWORD='REDACTED-DEV-DB-PASSWORD'` accidentally pasted into `.env.example` (intended for the gitignored `.env`). | **Dead** — credential rotated immediately on detection (2026-05-16). Value is non-functional anywhere. |

Add new rows here whenever the pre-publish scan turns something up — even if it's been rotated. The table is the record.

## Pre-publish checklist

### 1. Sweep for credentials

Quick first pass over the full history:

```bash
git log -p | grep -iE '(password|secret|api[_-]?key|token|sk-ant|sk-or)' | head -50
```

For a thorough scan use a real tool:

- [`gitleaks`](https://github.com/gitleaks/gitleaks) — fast, opinionated rules, suitable for a one-shot scan or CI.
- [`trufflehog`](https://github.com/trufflesecurity/trufflehog) — broader, finds high-entropy strings (catches things that aren't obviously a "password=").

Anything new gets a row in the table above, with its rotation status.

### 2. Decide how to handle dead credentials in history

Two viable approaches:

1. **Leave history intact + document.** Add a `SECURITY.md` (or top-level README note) stating: *"Any credentials, tokens, or secrets present in this repository's pre-public history have been rotated and are non-functional. Do not attempt to use them, and please don't report them as a vulnerability."* Lowest cost; relies on someone actually reading.
2. **Rewrite history with `git filter-repo`** to scrub the offending values from the relevant commits. Produces clean history; requires force-pushing and breaks any existing clones. Worth doing if there's *any* doubt about whether a value is truly dead, or if the project will attract an audience that won't see the disclaimer.

Default recommendation: **(2) if it's cheap; (1) otherwise.** A rewrite over a handful of dev-history commits is cheap on a one-person repo. The cost (and coordination overhead) rises with collaborators.

### 3. Other public-repo prep

- [ ] README polished for outside readers — no in-jokes, no references that only make sense to the current dev.
- [ ] `LICENSE` (AGPLv3) double-checked — copyright holder name, year range.
- [ ] No private hostnames or URLs in code that wouldn't make sense to a third party. *Note:* `rpi.local`, `laptop.local`, etc. in example TOML are fine — they're documented as example hostnames.
- [ ] `dev-notes/` either kept (it's a legitimate record of how the project was built) or moved out. Either way, scrub internal-only context (operator names, customer names, anything you wouldn't say in front of a stranger).
- [ ] Issue and PR templates added if external contributions are expected.
- [ ] CI configured *before* going public so the first external visitor doesn't see a red build badge.
- [ ] Branch protection on `main` if external contributions are expected.
- [ ] `CODE_OF_CONDUCT.md` if expected by the community / platform.

### What's NOT in this checklist

- Squashing or reorganising commit history beyond credential scrubbing. The dev-history conversation is a legitimate record of how the project was built. Keep it.
- Renaming, splitting, or any structural rework of the repo — out of scope for "publish what we have" cutover. Do those separately if you want them.
