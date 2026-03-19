#!/usr/bin/env node

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join, resolve, sep } from "path";
import { readFileSync } from "fs";
import { Command } from "commander";
import fg from "fast-glob";
import ignore from "ignore";
import { chunkFile, extractSummary } from "./chunker.js";
import { embedBatch } from "./embeddings.js";
import {
  clearProject,
  upsertChunks,
  upsertFileSummary,
  upsertCodebaseMap,
  deleteFileChunks,
  listProjects,
} from "./supabase.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

const DEFAULT_EXTENSIONS =
  "ts,tsx,js,jsx,py,rs,go,java,md,json,yaml,yml,toml,sql,sh,css,html,svelte,vue,mjs";
const MAX_FILE_SIZE = 100 * 1024; // 100KB

function normalizePath(p: string): string {
  return p.split(sep).join("/");
}

function buildExtensionGlob(extensions: string): string {
  const exts = extensions.split(",").map((e) => e.trim());
  if (exts.length === 1) return `**/*.${exts[0]}`;
  return `**/*.{${exts.join(",")}}`;
}

function loadGitignore(projectPath: string): ReturnType<typeof ignore> {
  const ig = ignore();
  try {
    const gitignoreContent = readFileSync(
      join(projectPath, ".gitignore"),
      "utf-8"
    );
    ig.add(gitignoreContent);
  } catch {
    // No .gitignore, that's fine
  }
  // Always ignore these
  ig.add(["node_modules", ".git", "dist", "build", ".next", "__pycache__"]);
  return ig;
}

function buildCodebaseMap(
  files: string[]
): Record<string, { files: string[]; dirs: string[] }> {
  const map: Record<string, Set<string>> = {};
  const dirSet: Record<string, Set<string>> = {};

  for (const file of files) {
    const parts = file.split("/");
    const fileName = parts.pop()!;
    const dir = parts.length > 0 ? parts.join("/") + "/" : "/";

    if (!map[dir]) {
      map[dir] = new Set();
      dirSet[dir] = new Set();
    }
    map[dir].add(fileName);

    // Register parent directories
    for (let i = 1; i <= parts.length; i++) {
      const parentDir = i === parts.length ? "/" : parts.slice(0, i - 1).join("/") + "/";
      const childDir = parts.slice(0, i).join("/") + "/";
      if (parentDir === childDir) continue;
      if (!dirSet[parentDir]) dirSet[parentDir] = new Set();
      dirSet[parentDir].add(childDir);
    }
  }

  // Also register root
  if (!map["/"]) map["/"] = new Set();
  if (!dirSet["/"]) dirSet["/"] = new Set();

  // Find top-level files and dirs
  for (const file of files) {
    if (!file.includes("/")) {
      map["/"].add(file);
    } else {
      const topDir = file.split("/")[0] + "/";
      dirSet["/"].add(topDir);
    }
  }

  const result: Record<string, { files: string[]; dirs: string[] }> = {};
  const allDirs = new Set([...Object.keys(map), ...Object.keys(dirSet)]);
  for (const dir of allDirs) {
    result[dir] = {
      files: [...(map[dir] ?? [])].sort(),
      dirs: [...(dirSet[dir] ?? [])].sort(),
    };
  }
  return result;
}

const program = new Command();

program
  .name("claude-memory-index")
  .description("Index codebases for semantic search via Claude Memory MCP");

program
  .command("index")
  .requiredOption("-p, --project <name>", "Project name")
  .requiredOption("--path <dir>", "Path to project root")
  .option(
    "-e, --extensions <exts>",
    "Comma-separated file extensions",
    DEFAULT_EXTENSIONS
  )
  .option("--clear", "Clear existing data before indexing")
  .action(async (opts) => {
    const projectName: string = opts.project;
    const projectPath: string = resolve(opts.path).replace(/\\/g, "/");
    const extensions: string = opts.extensions;
    const shouldClear: boolean = opts.clear ?? false;

    console.error(`\nIndexing project: ${projectName}`);
    console.error(`  Path: ${projectPath}`);

    if (shouldClear) {
      console.error("  Clearing existing data...");
      await clearProject(projectName);
    }

    // Find files
    const glob = buildExtensionGlob(extensions);
    const rawFiles = await fg(glob, {
      cwd: projectPath,
      dot: false,
      absolute: false,
    });

    // Filter with .gitignore
    const ig = loadGitignore(projectPath);
    const files = rawFiles
      .map((f) => normalizePath(f))
      .filter((f) => !ig.ignores(f));

    console.error(`  Found ${files.length} files\n`);

    if (files.length === 0) {
      console.error("No files to index.");
      return;
    }

    // Build codebase map
    console.error("Building codebase map...");
    const codebaseMap = buildCodebaseMap(files);
    await upsertCodebaseMap(projectName, codebaseMap);
    console.error("  Codebase map stored\n");

    // Chunk all files
    console.error("Chunking files...");
    const allChunks: Array<{
      project: string;
      file_path: string;
      chunk_index: number;
      content: string;
      start_line: number;
      end_line: number;
    }> = [];
    const summaries: Array<{ filePath: string; summary: string }> = [];

    for (let i = 0; i < files.length; i++) {
      const filePath = files[i];
      const fullPath = join(projectPath, filePath);

      let content: string;
      try {
        content = readFileSync(fullPath, "utf-8");
      } catch {
        console.error(`  [${i + 1}/${files.length}] Skipped ${filePath} (read error)`);
        continue;
      }

      if (content.length > MAX_FILE_SIZE) {
        console.error(`  [${i + 1}/${files.length}] Skipped ${filePath} (>100KB)`);
        continue;
      }

      const chunks = chunkFile(content);
      for (const chunk of chunks) {
        allChunks.push({
          project: projectName,
          file_path: filePath,
          chunk_index: chunk.chunkIndex,
          content: chunk.content,
          start_line: chunk.startLine,
          end_line: chunk.endLine,
        });
      }

      const summary = extractSummary(content, filePath);
      summaries.push({ filePath, summary });

      if ((i + 1) % 50 === 0 || i === files.length - 1) {
        console.error(`  [${i + 1}/${files.length}] files chunked`);
      }
    }

    console.error(`\n  Total chunks: ${allChunks.length}\n`);

    // Embed all chunks
    console.error("Embedding chunks...");
    const texts = allChunks.map((c) => c.content);
    const totalBatches = Math.ceil(texts.length / 20);
    const embeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += 20) {
      const batch = texts.slice(i, i + 20);
      const batchNum = Math.floor(i / 20) + 1;
      console.error(`  Embedding batch ${batchNum}/${totalBatches}...`);
      const batchEmbeddings = await embedBatch(batch);
      embeddings.push(...batchEmbeddings);
    }

    // Attach embeddings and store
    console.error("\nStoring chunks in Supabase...");
    const chunksWithEmbeddings = allChunks.map((chunk, idx) => ({
      ...chunk,
      embedding: embeddings[idx],
    }));

    // Delete existing chunks for files we're re-indexing
    if (!shouldClear) {
      const uniqueFiles = [...new Set(allChunks.map((c) => c.file_path))];
      for (const fp of uniqueFiles) {
        await deleteFileChunks(projectName, fp);
      }
    }

    await upsertChunks(chunksWithEmbeddings);
    console.error("  Chunks stored");

    // Store summaries
    console.error("Storing file summaries...");
    for (const { filePath, summary } of summaries) {
      await upsertFileSummary(projectName, filePath, summary);
    }
    console.error("  Summaries stored");

    console.error(
      `\nDone! Indexed ${files.length} files, ${allChunks.length} chunks for project "${projectName}".`
    );
  });

program
  .command("list")
  .description("List all indexed projects")
  .action(async () => {
    const projects = await listProjects();
    if (projects.length === 0) {
      console.error("No projects indexed yet.");
    } else {
      console.error("Indexed projects:");
      for (const p of projects) {
        console.error(`  - ${p}`);
      }
    }
  });

program.parse();
