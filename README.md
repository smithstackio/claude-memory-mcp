# Claude Memory MCP

Semantic code search for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), backed by [Supabase](https://supabase.com) (pgvector) and [Mistral](https://mistral.ai) embeddings.

**What this does:** Instead of spending time exploring your project with file reads and grep, Claude queries your indexed codebase and jumps directly to the right file and line number.

## How It Works

```
Your codebase
     |
     v
[Indexer CLI]
  - Walks files, respects .gitignore
  - Chunks into 80-line segments (10-line overlap)
  - Embeds with Mistral codestral-embed
  - Stores in Supabase pgvector
  - Builds directory map

Claude Code session
     |
     v
[MCP Server] exposes 4 tools:
  - get_codebase_map   -> full project structure
  - search_code        -> semantic vector search
  - get_file_summary   -> understand a file without reading it
  - list_projects      -> see what's indexed
```

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- A [Supabase](https://supabase.com) project (free tier works)
- A [Mistral](https://console.mistral.ai) API key
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI

## Setup

### 1. Clone and install

```bash
git clone https://github.com/smithstackio/claude-memory-mcp.git
cd claude-memory-mcp
npm install
npm run build
```

### 2. Create the database schema

Create a new Supabase project (or use an existing one). Go to **SQL Editor** and run the entire contents of [`schema.sql`](schema.sql).

This creates:
- `code_chunks` table with pgvector embeddings (HNSW index)
- `file_summaries` table
- `codebase_maps` table
- `match_code_chunks` RPC function for vector similarity search
- Row Level Security enabled (service key access only)

Verify the vector extension is active:

```sql
select extname from pg_extension where extname = 'vector';
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJ...your-service-role-key...
MISTRAL_API_KEY=your-mistral-api-key
```

**Important:** Use the `service_role` key (not the anon/publishable key). Find it in Supabase under **Project Settings > API > service_role**.

### 4. Index your project

```bash
# Index a project
node dist/indexer.js index --project myapp --path /path/to/your/project

# Specify file extensions (optional)
node dist/indexer.js index \
  --project myapp \
  --path /path/to/your/project \
  --extensions ts,tsx,js,jsx,py,rs,go

# Re-index from scratch
node dist/indexer.js index --project myapp --path /path/to/your/project --clear

# List indexed projects
node dist/indexer.js list
```

**Default extensions:** `ts, tsx, js, jsx, py, rs, go, java, md, json, yaml, yml, toml, sql, sh, css, html, svelte, vue, mjs`

Files larger than 100KB are automatically skipped (generated/bundled files).

Example output:

```
Indexing project: myapp
  Path: /path/to/your/project
  Found 76 files

Building codebase map...
  Codebase map stored

Chunking files...
  [76/76] files chunked

  Total chunks: 167

Embedding chunks...
  Embedding batch 1/9...
  ...
  Embedding batch 9/9...

Storing chunks in Supabase...
  Chunks stored
Storing file summaries...
  Summaries stored

Done! Indexed 76 files, 167 chunks for project "myapp".
```

### 5. Register with Claude Code

```bash
claude mcp add claude-memory -- node /path/to/claude-memory-mcp/dist/server.js
```

Verify it's registered:

```bash
claude mcp list
```

The server loads its `.env` file relative to its own location, so env vars don't need to be passed via `--env` flags.

### 6. Update your project's CLAUDE.md

Add this to your project's `CLAUDE.md` so Claude knows to use the MCP tools:

```markdown
## Memory MCP Available

Before exploring files, use these tools to orient yourself:

1. **get_codebase_map** -- call with project: "myapp" to get the full directory structure
2. **search_code** -- use with project: "myapp" to find functions, components, or patterns semantically
3. **get_file_summary** -- understand what a file does before opening it
```

Without this, Claude will default to its normal file-reading workflow instead of the MCP tools.

## Usage

Once registered, Claude Code will have access to the tools automatically. You can also prompt directly:

```
> Find the authentication middleware

[Claude calls search_code("myapp", "authentication middleware")]
-> Returns: src/middleware/auth.ts, lines 12-45, 93.2% match
[Claude reads only that section]
```

```
> Give me an overview of this project

[Claude calls get_codebase_map("myapp")]
-> Returns: full directory structure with file listings
[Claude understands the layout without reading files]
```

## Multiple Projects

Index as many projects as you want -- they all share the same Supabase instance:

```bash
node dist/indexer.js index --project frontend --path ./apps/web
node dist/indexer.js index --project api --path ./apps/api
node dist/indexer.js index --project shared --path ./packages/shared
```

Search is scoped by project name, so there's no cross-contamination.

## Re-indexing

Run the indexer whenever you make significant changes. Some options:

**Manual:**

```bash
node /path/to/claude-memory-mcp/dist/indexer.js index --project myapp --path . --clear
```

**As an npm script** (add to your project's `package.json`):

```json
{
  "scripts": {
    "index:claude": "node /path/to/claude-memory-mcp/dist/indexer.js index --project myapp --path . --clear"
  }
}
```

**As a git hook** (`.git/hooks/post-merge`):

```bash
#!/bin/bash
npm run index:claude
```

## Architecture

| Component | Details |
|-----------|---------|
| **Chunking** | 80-line chunks with 10-line overlap. Overlap ensures functions spanning chunk boundaries are still findable. |
| **Embeddings** | Mistral `codestral-embed` (1536 dimensions). Purpose-built for code. Supports matryoshka dimensions and binary quantization. |
| **Vector index** | HNSW (cosine similarity). No minimum row requirement, good recall, works well for any dataset size. |
| **File summaries** | Extracted from the first block comment or first 5 lines of each file. No LLM call -- zero cost. |
| **Transport** | MCP stdio (JSON-RPC over stdin/stdout). Fully local, no network listeners. |
| **Security** | Uses Supabase service key (bypasses RLS). Never expose this key client-side. The MCP server runs locally on your machine. |

## Project Structure

```
claude-memory-mcp/
├── src/
│   ├── server.ts        # MCP stdio server (4 tools)
│   ├── indexer.ts        # CLI: index + list commands
│   ├── embeddings.ts     # Mistral codestral-embed via fetch
│   ├── supabase.ts       # DB client + query helpers
│   └── chunker.ts        # File chunking + summary extraction
├── schema.sql            # Supabase schema (pgvector tables + RPC)
├── .env.example          # Environment variable template
├── package.json
└── tsconfig.json
```

## Costs

| Item | Cost |
|------|------|
| Mistral codestral-embed | ~$0.02 per 1M tokens |
| Indexing a 50k-line codebase | ~$0.03 total |
| Supabase free tier | 500MB storage, 2GB bandwidth |
| Per-query embedding | Fractions of a cent |

A typical project costs pennies to index and stays within Supabase free tier easily.

## Troubleshooting

**"vector extension not found"**
Go to Supabase Dashboard > Database > Extensions > enable `vector`.

**"No results from search_code"**
Check the project name matches exactly: `node dist/indexer.js list`

**MCP server not connecting**
Check registration: `claude mcp list` and look for errors.
Test the server directly:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/server.js
```

**Embeddings timing out**
Reduce `BATCH_SIZE` in `src/embeddings.ts` from 20 to 10.

**"Missing SUPABASE_URL or SUPABASE_SERVICE_KEY"**
The server resolves `.env` relative to its own directory. Make sure `.env` exists at the root of the claude-memory-mcp project, not in your working directory.

## License

MIT
