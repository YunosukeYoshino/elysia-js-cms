# CLAUDE.md

**注意**: 本リポジトリのルールセットは `GLOBAL_RULES.md` に集約されています。

作業を開始する前に、必ず **`GLOBAL_RULES.md`** を読み、その内容に従ってください。
特に、**型安全性の厳格なルール**（`any` 禁止、`biome-ignore` 禁止）と **AIエージェントのための自己修正ガイド** を遵守することが必須です。

---
**Note**: The ruleset for this repository is consolidated in `GLOBAL_RULES.md`.

Before starting any work, you MUST read **`GLOBAL_RULES.md`** and follow its instructions.
In particular, you must adhere to the **Strict Type Safety Rules** (No `any`, No `biome-ignore`) and the **Self-Correction Guide for AI Agents**.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
