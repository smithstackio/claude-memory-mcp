#!/usr/bin/env node

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  searchChunks,
  getCodebaseMap,
  getFileSummary,
  getProjectInfo,
} from "./supabase.js";
import { embedQuery } from "./embeddings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

const server = new McpServer({
  name: "claude-memory",
  version: "1.1.0",
});

// Tool: get_project_info
server.tool(
  "get_project_info",
  "Show which project this memory server is connected to",
  {},
  async () => {
    const project = await getProjectInfo();
    if (!project) {
      return { content: [{ type: "text", text: "No project data found for this token." }] };
    }
    return {
      content: [{ type: "text", text: `Connected to project: ${project}` }],
    };
  }
);

// Tool: get_codebase_map
server.tool(
  "get_codebase_map",
  "Get the full directory structure of this project's indexed codebase. Call this at the start of a session to understand the layout.",
  {},
  async () => {
    const map = await getCodebaseMap();
    if (!map) {
      return {
        content: [
          {
            type: "text",
            text: "No codebase map found. Run the indexer first.",
          },
        ],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(map, null, 2) }],
    };
  }
);

// Tool: search_code
server.tool(
  "search_code",
  "Semantic search across the indexed codebase. Returns matching code chunks with file paths and line numbers. Use this instead of reading files to find functions, components, or patterns.",
  {
    query: z
      .string()
      .describe(
        "Natural language or code search query (e.g. 'Stripe webhook handler', 'authentication middleware')"
      ),
    limit: z
      .number()
      .optional()
      .default(10)
      .describe("Max results to return (default 10)"),
  },
  async ({ query, limit }) => {
    const queryEmbedding = await embedQuery(query);
    const results = await searchChunks(queryEmbedding, limit);

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No results found for "${query}".`,
          },
        ],
      };
    }

    const formatted = results
      .map((r) => {
        const ext = r.file_path.split(".").pop() ?? "";
        const score = (r.similarity * 100).toFixed(1);
        return `## ${r.file_path} (lines ${r.start_line}-${r.end_line}) [${score}% match]\n\`\`\`${ext}\n${r.content}\n\`\`\``;
      })
      .join("\n\n");

    return { content: [{ type: "text", text: formatted }] };
  }
);

// Tool: get_file_summary
server.tool(
  "get_file_summary",
  "Get a brief summary of what a file does without reading the full file",
  {
    file_path: z
      .string()
      .describe("Relative file path (e.g. 'src/lib/supabase-server.js')"),
  },
  async ({ file_path }) => {
    const summary = await getFileSummary(file_path);
    if (!summary) {
      return {
        content: [
          {
            type: "text",
            text: `No summary found for "${file_path}".`,
          },
        ],
      };
    }
    return { content: [{ type: "text", text: summary }] };
  }
);

async function main() {
  // Validate token on startup
  const project = await getProjectInfo();
  if (!project) {
    console.error("WARNING: PROJECT_TOKEN is invalid or project has no indexed data");
  } else {
    console.error(`Claude Memory MCP server running for project: ${project}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
