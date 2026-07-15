# Readiness evaluation design

## Goal

Produce a fresh, evidence-backed readiness report whose applicability and evaluated-criterion count are stable across Claude Code, Codex, and OpenCode. The selected agent should contribute semantic judgment, not decide which parts of the rubric count toward the score.

## Invariants

- Every run rebuilds the repository profile from the current working tree. This release does not cache by commit or file hash.
- Every canonical criterion receives exactly one decision: deterministic result, rule-backed not applicable, or semantic evaluation.
- Only CoDev may mark a criterion not applicable. A semantic evaluator must return pass or fail.
- Every evaluated criterion contributes one equally weighted repository-level vote. Provider-specific application discovery cannot change the denominator.
- Deterministic checks accept documented ecosystem variants rather than one preferred filename.
- Absence is a failure only when a criterion is universally expected or applicability is positively established.

## Evaluation boundary

Deterministic presence checks are limited to criteria whose requirement is the artifact itself:

- coding-agent instructions: `AGENTS.md` or `CLAUDE.md`
- root README
- recognized CODEOWNERS locations
- GitHub/GitLab issue and pull/merge-request templates
- dev-container definitions
- repository-local agent skill directories
- meaningful version-controlled pre-commit hooks
- automation that validates agent-instruction files
- documented VCS/hosting CLI commands
- configured dead-code, complexity, clone, and unused-dependency tooling
- repository-owned setup/bootstrap tasks
- version-controlled branch-protection policy-as-code
- ecosystem-aware `.gitignore` coverage
- documentation with explicit architecture or component-flow signals

Environment templates use both applicability and variant detection. `.env.example`, `.env.local.example`, `.env.sample`, `.env.template`, `.env.dist`, `env.example`, `example.env`, and `sample.env` are recognized. A missing template fails only when source or configuration evidence shows environment-variable consumption; otherwise the criterion is not applicable.

Database-only and API-only checks are not applicable only when the fresh profile finds no corresponding surface. The signals intentionally combine directory conventions, manifests, dependencies, and representative source/configuration content. Positive detection delegates the actual quality judgment to the semantic evaluator.

All remaining criteria are semantic. The agent receives the deterministic profile, a bounded list of relevant files, explicit rubric definitions, and a small command budget. CoDev normalizes any semantic skip or omission to a conservative failure and records a warning.

## Deliberate first-release constraints

- No persistent or cross-run cache.
- No network or hosted-repository metadata checks; branch protection and backlog health are judged only from local evidence and should fail when they cannot be established.
- Component discovery is manifest-based and deterministic. It is report metadata only and does not alter criterion weighting.
- Deterministic rules favor high-confidence applicability. Ambiguous criteria remain semantic rather than being skipped heuristically.

## Validation

- Fixture tests cover environment-template variants, repositories without environment requirements, GitHub/GitLab convention variants, API/database applicability, and denominator parity when an agent skips everything.
- End-to-end parity runs must use the same working tree and rubric version across all three providers. The evaluated count must match exactly; score differences are then semantic disagreements that can be measured and refined.
