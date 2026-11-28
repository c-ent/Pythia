# Pythia

Private, read-only personal knowledge server (PWA + MCP server). It indexes Obsidian notes, personal GitHub repos and Google Keep exports into PostgreSQL + pgvector for hybrid search and cited answers.

## Setup

```sh
pnpm install
cp .env.example .env   # then set POSTGRES_PASSWORD
docker compose up -d --build
pnpm --filter server migrate
pnpm dev
```

Commands, conventions and the agent workflow are in [AGENTS.md](AGENTS.md).

## Agent skills

Third-party agent skills are not committed. Their sources and pinned commits are in [skills-lock.json](skills-lock.json). Restore them with the [skills CLI](https://skills.sh/):

```sh
npx skills experimental_install             # restore everything in skills-lock.json
npx skills experimental_install --dry-run   # preview first
```

This installs into `.agents/skills/` and links the skills into each detected agent's folder (for example `.claude/skills/`).

To add a new skill, run `npx skills add <owner/repo>` and commit the updated `skills-lock.json`.

`.agents/skills/add-sql-migration/` is written for this repo and is committed directly.

| Skill | Source |
| --- | --- |
| design-taste-frontend | Leonxlnx/taste-skill |
| docker-compose-patterns | docker/skills |
| find-skills | vercel-labs/skills |
| image-to-code | Leonxlnx/imagegen-skills |
| mcp-builder | anthropics/skills |
| nodejs-backend-patterns | wshobson/agents |
| pgvector-semantic-search | timescale/pg-aiguide |
| postgresql-optimization | github/awesome-copilot |
| vercel-react-best-practices | vercel-labs/agent-skills |
| vitest | antfu/skills |
| web-design-guidelines | vercel-labs/agent-skills |


Building the App on Oracle
```sh
git pull origin dev && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build app
```