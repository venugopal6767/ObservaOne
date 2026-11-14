# Third-party skills — provenance & licenses

All skills under `.claude/skills/` (except any ObservaOne-authored ones) are vendored
copies of upstream open-source skills, pinned to the commit shown below. License texts
are in `.claude/skills/licenses/`. To update a skill, re-copy from upstream at a newer
commit and update this file.

Installed on: 2026-11-14 · Installed into branch: chore/claude-code-toolkit

| Skill folder | Source repo | Commit | License |
|---|---|---|---|
| brainstorming | obra/superpowers-skills | cdcd624 | MIT |
| writing-plans | obra/superpowers-skills | cdcd624 | MIT |
| executing-plans | obra/superpowers-skills | cdcd624 | MIT |
| test-driven-development | obra/superpowers-skills | cdcd624 | MIT |
| systematic-debugging | obra/superpowers-skills | cdcd624 | MIT |
| root-cause-tracing | obra/superpowers-skills | cdcd624 | MIT |
| requesting-code-review | obra/superpowers-skills | cdcd624 | MIT |
| receiving-code-review | obra/superpowers-skills | cdcd624 | MIT |
| verification-before-completion | obra/superpowers-skills | cdcd624 | MIT |
| frontend-design | anthropics/skills | 2c5958e | see anthropics-LICENSE.txt |
| webapp-testing | anthropics/skills | 2c5958e | see anthropics-LICENSE.txt |
| skill-creator | anthropics/skills | 2c5958e | see anthropics-LICENSE.txt |
| react-best-practices | vercel-labs/agent-skills | 1a2c79d | MIT (see vercel note) |
| web-design-guidelines | vercel-labs/agent-skills | 1a2c79d | MIT (see vercel note) |
| composition-patterns | vercel-labs/agent-skills | 1a2c79d | MIT (see vercel note) |
| ui-ux-pro-max | nextlevelbuilder/ui-ux-pro-max-skill | 6ae86f6 | MIT |
| supply-chain-risk-auditor | trailofbits/skills | 149d7b2 | CC-BY-SA-4.0 |
| semgrep | trailofbits/skills | 149d7b2 | CC-BY-SA-4.0 |
| codeql | trailofbits/skills | 149d7b2 | CC-BY-SA-4.0 |
| sarif-parsing | trailofbits/skills | 149d7b2 | CC-BY-SA-4.0 |
| differential-review | trailofbits/skills | 149d7b2 | CC-BY-SA-4.0 |
| variant-analysis | trailofbits/skills | 149d7b2 | CC-BY-SA-4.0 |
| cvss-scoring | trailofbits/skills | 149d7b2 | CC-BY-SA-4.0 |

## Deliberately NOT installed (and why)
- **mcp-builder** (anthropics/skills): ObservaOne is not building an MCP server. Add later if that changes.
- **Vercel deploy-to-vercel / vercel-optimize / react-native-skills / react-view-transitions**:
  ObservaOne uses **Vite** (not Next.js) and is self-hosted via Docker (not deployed to Vercel);
  no React Native. Only the stack-general React/design skills were taken.
- **Trail of Bits blockchain/smart-contract/fuzzing skills** (building-secure-contracts/*, testing-handbook-skills/*, trailmark/*, language reviews for c/cpp/rust, etc.): not applicable to a TS/Node/Go web app.
- **Everything Claude Code (ECC)** full bundle: it ships its own 48 agents + 180+ skills that would
  duplicate the agents in `.claude/agents/` and bloat context. Left as an opt-in marketplace —
  see README "Optional: ECC". 

## External tools some security skills expect (install only if/when you run them)
- semgrep (`pipx install semgrep`), CodeQL CLI, SARIF tooling. The skills degrade to guidance without them.

## External tools UI/UX Pro Max expects
- Python 3 (for its `scripts/*.py` search over `data/`). Already present in your dev env.
