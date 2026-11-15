# ObservaOne — Claude Code toolkit

Installed 2026-11-14. This folder configures Claude Code for ObservaOne. Nothing here
changes application code. See `../CLAUDE.md` for the project guide.

## Layout
- `agents/` — 8 specialized subagents, one owner per concern (see CLAUDE.md).
- `skills/` — 23 vendored skills (progressive-disclosure). Provenance + licenses: `skills/THIRD_PARTY_SKILLS.md`, `skills/licenses/`.
- `commands/` — workflow slash commands: `/analyze-requirements /plan-feature /tdd /debug /review /security-review /regression`.
- `hooks/guard.sh` — PreToolUse guard: blocks writing secrets and destructive ops.
- `settings.json` — permissions (safe-allow / secret+destructive-deny) and the hook wiring.

## Updating a vendored skill
Re-copy the folder from upstream at a newer commit and update the commit in
`skills/THIRD_PARTY_SKILLS.md`. Sources are listed there.

## Optional: Everything Claude Code (ECC)
**Update (2026-11-15):** a curated subset of 33 ECC skills (stack-relevant: React/TS/Vite,
Node/Express/Postgres, Go, Docker/K8s, security) is now vendored directly under `skills/` —
see `skills/ECC_VENDORED.md`. The rest of the full bundle is still left out, for the reasons below.

Not installed, on purpose: ECC bundles its own ~48 agents + 180+ skills that would
duplicate the agents in `agents/` and enlarge every session's context — which conflicts
with this project's "avoid duplicates / don't load irrelevant skills / token economy"
goals. If you want it anyway, add it as a self-updating plugin instead of vendoring:

```
# inside Claude Code
/plugin marketplace add affaan-m/everything-claude-code
/plugin install ecc@ecc
```
Then disable the local agents that overlap to avoid two owners for the same concern.
ECC "rules" need a manual `./install.sh <lang>` from its repo (plugins can't ship rules).

## Optional: upstream marketplaces (self-updating alternative to vendored skills)
```
/plugin marketplace add obra/superpowers-marketplace   # Superpowers
/plugin marketplace add trailofbits/skills             # Trail of Bits security
```
If you adopt a marketplace version of a skill, remove the vendored copy under `skills/`
so there's only one source.
