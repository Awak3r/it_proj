# LabTurn agent instructions

- Read `docs/LOCAL-AGENT-HANDOFF.md` before continuing work after migration.
- Develop and run Go/Node/Docker builds, seed and UI tests on the owner's PC/WSL or
  GitHub-hosted runners, never on the production VPS.
- The trusted working/deploy branch is `codex/labturn-mvp`. Do not merge into main,
  force-push or create branches without explicit permission.
- Production releases run only through `.github/workflows/deploy.yml`. The VPS
  receives a prebuilt image; do not use manual PC-to-VPS release scripts.
- Before local Docker operations verify the endpoint is local Docker Desktop,
  not an SSH context or DOCKER_HOST pointing at production.
- Never copy production `.env`, bot tokens, private keys or database dumps to the
  PC, Git, artifacts or chat. Local dev uses a separate DB, empty BOT_TOKEN and
  DEV_AUTH=true only on localhost. Production DEV_AUTH must stay false.
- Real Telegram login/SSE verification requires genuine owner initData. Never
  fabricate it or enable development authentication on production.
- Keep backup and rollback safeguards. Image rollback does not roll back schema.
  Do not delete volumes or run data-changing UI tests on production.
- Production URL: https://labturn.awak3r.ru; owner/root Telegram ID: 1297278646.
- Deployment and one-time CI access setup: `docs/DEPLOYMENT-GITHUB.md`.
- Do not terminate the owner's remote Zed/SSH session during migration; ask them
  to close it once the local checkout has been confirmed.
