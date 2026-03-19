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
  listProjects,
} from "./supabase.js";
import { embedQuery } from "./embeddings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

const server = new McpServer({
  name: "claude-memory",
  version: "1.0.0",
});

// Tool: list_projects
server.tool(
  "list_projects",
  "List all indexed codebases available for search",
  {},
  async () => {
    const projects = await listProjects();
    if (projects.length === 0) {
      return { content: [{ type: "text", text: "No projects indexed yet." }] };
    }
    return {
      content: [
        {
          type: "text",
          text: `Indexed projects:\n${projects.map((p) => `- ${p}`).join("\n")}`,
        },
      ],
    };
  }
);

// Tool: get_codebase_map
server.tool(
  "get_codebase_map",
  "Get the full directory structure of an indexed project. Call this at the start of a session to understand the codebase layout.",
  { project: z.string().describe("Project name (e.g. 'smithstack')") },
  async ({ project }) => {
    const map = await getCodebaseMap(project);
    if (!map) {
      return {
        content: [
          {
            type: "text",
            text: `No codebase map found for project "${project}". Run the indexer first.`,
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
  "Semantic search across an indexed codebase. Returns matching code chunks with file paths and line numbers. Use this instead of reading files to find functions, components, or patterns.",
  {
    project: z.string().describe("Project name"),
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
  async ({ project, query, limit }) => {
    const queryEmbedding = await embedQuery(query);
    const results = await searchChunks(project, queryEmbedding, limit);

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No results found for "${query}" in project "${project}".`,
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
    project: z.string().describe("Project name"),
    file_path: z
      .string()
      .describe("Relative file path (e.g. 'src/lib/supabase-server.js')"),
  },
  async ({ project, file_path }) => {
    const summary = await getFileSummary(project, file_path);
    if (!summary) {
      return {
        content: [
          {
            type: "text",
            text: `No summary found for "${file_path}" in project "${project}".`,
          },
        ],
      };
    }
    return { content: [{ type: "text", text: summary }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Claude Memory MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
