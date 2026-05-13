# Codex Native Subagents

This rollout adds native Codex subagents behind an explicit opt-in flag. AIF Handoff keeps the isolated `$aif-*` skill-session path as the default until operators enable the rollout and the selected runtime is `codex` over the SDK transport with the required AI Factory-managed `.codex` assets present on disk.

## Dependency

Minimum AI Factory version:

- `ai-factory` `2.11.0` or later, which includes PR `#70` ("materialize managed agent assets")

Do not rely on earlier `2.9.x` or `2.10.x` packages for this rollout. If your project was bootstrapped with an older AI Factory release, upgrade to `2.11.0` or later, then re-run:

```bash
ai-factory init --agents claude,codex
```

This must materialize:

- `.codex/agents/*.toml`
- `.codex/config.toml`

The runtime readiness guard in AIF Handoff intentionally keeps an explicit list of
required `.codex/agents/*.toml` files. Treat that list as a contract with the AI
Factory-managed assets from PR `#70`: if AI Factory adds, removes, or renames a
managed Codex agent file, update the Handoff readiness list in the same release
train so projects do not falsely downgrade to isolated mode.

## Runtime Behavior

Default behavior after this change:

- `AIF_RUNTIME_CODEX_NATIVE_SUBAGENTS_ENABLED=false` (default) → isolated skill-session mode, even when native assets are present
- `AIF_RUNTIME_CODEX_NATIVE_SUBAGENTS_ENABLED=true` + `codex` + `sdk` + `useSubagents=true` + native assets present → native Codex subagents
- `codex` + `sdk` + `useSubagents=true` + native assets missing → automatic fallback to isolated skill-session mode until the project is reinitialized with AI Factory `2.11.0` or later
- `codexSubagentStrategy: "isolated"` → explicit escape hatch to legacy isolated skill-session flow
- `codexSubagentStrategy: "native"` → profile-level opt-in that still requires the global env flag above
- Claude remains unchanged and continues using `.claude/agents/*`

`projectInit()` still bootstraps only fresh projects. Existing projects with `.ai-factory/` already present are not reinitialized automatically; the rollout safety comes from the runtime readiness guard and fallback path above.

## Handoff-Aware Contract

The Codex agents materialized by AI Factory are no longer generic role prompts only. They now encode the Handoff contract directly:

- top-level coordinators understand explicit `HANDOFF_MODE`, `HANDOFF_TASK_ID`, and `HANDOFF_SKIP_REVIEW` context from the parent runtime
- autonomous Handoff runs stay non-interactive and do not attempt Handoff MCP sync from inside the Codex agent
- manual Codex sessions may preserve Handoff task linkage when a plan annotation already exists
- worker and sidecar agents explicitly keep Handoff sync coordinator-owned

What still comes from `aif-handoff` at runtime:

- exact task title/description/attachments
- exact plan path for the current run
- final runtime capability negotiation (`native` vs `isolated`)

## Verification Checklist

1. Install or upgrade AI Factory to `2.11.0` or later.
2. In the target project, run `ai-factory init --agents claude,codex`.
3. Confirm the project contains `.codex/agents/` and `.codex/config.toml`.
4. Start AIF Handoff with `AIF_RUNTIME_CODEX_NATIVE_SUBAGENTS_ENABLED=true`.
5. Select a Codex SDK runtime profile.
6. Move a task with `useSubagents=true` into planning or implementing.
7. Confirm logs show `usedNativeSubagentWorkflow: true` when assets are present.
8. For an older bootstrap without `.codex/agents/*.toml` or `.codex/config.toml`, confirm the prompt path downgrades safely to `$aif-*` / isolated mode instead of attempting a broken native run.

## Enablement

Set the global feature flag only after the AI Factory-managed Codex assets are materialized in the target projects:

```bash
AIF_RUNTIME_CODEX_NATIVE_SUBAGENTS_ENABLED=true
```

You may also set a profile option to make the intent explicit:

```json
{
  "codexSubagentStrategy": "native"
}
```

The profile option alone is not enough; the env flag is the rollout gate.

## Rollback

The global kill switch is the default:

```bash
AIF_RUNTIME_CODEX_NATIVE_SUBAGENTS_ENABLED=false
```

If native Codex agents need to be bypassed for a single project or profile while the global flag remains enabled, set:

```json
{
  "codexSubagentStrategy": "isolated"
}
```

This preserves the previous fresh-session skill-command behavior without changing Claude or non-Codex runtimes.
