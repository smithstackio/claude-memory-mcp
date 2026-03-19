import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const projectToken = process.env.PROJECT_TOKEN;

if (!supabaseUrl) {
  throw new Error("Missing SUPABASE_URL");
}

// Service client for indexer (full access, bypasses RLS)
const serviceClient: SupabaseClient | null = serviceKey
  ? createClient(supabaseUrl, serviceKey)
  : null;

// Anon client for MCP server (scoped via RPC + token)
const anonClient: SupabaseClient | null = anonKey
  ? createClient(supabaseUrl, anonKey)
  : null;

function getServiceClient(): SupabaseClient {
  if (!serviceClient) throw new Error("Missing SUPABASE_SERVICE_KEY (required for indexer)");
  return serviceClient;
}

function getAnonClient(): SupabaseClient {
  if (!anonClient) throw new Error("Missing SUPABASE_ANON_KEY (required for MCP server)");
  return anonClient;
}

function getProjectToken(): string {
  if (!projectToken) throw new Error("Missing PROJECT_TOKEN (required for MCP server)");
  return projectToken;
}

// --- Write functions (indexer, uses service_role) ---

export async function clearProject(project: string): Promise<void> {
  const db = getServiceClient();
  await db.from("code_chunks").delete().eq("project", project);
  await db.from("file_summaries").delete().eq("project", project);
  await db.from("codebase_maps").delete().eq("project", project);
}

export async function upsertChunks(
  chunks: Array<{
    project: string;
    file_path: string;
    chunk_index: number;
    content: string;
    start_line: number;
    end_line: number;
    embedding: number[];
  }>
): Promise<void> {
  const db = getServiceClient();
  for (let i = 0; i < chunks.length; i += 500) {
    const batch = chunks.slice(i, i + 500);
    const { error } = await db.from("code_chunks").insert(batch);
    if (error) throw new Error(`Failed to insert chunks: ${error.message}`);
  }
}

export async function deleteFileChunks(
  project: string,
  filePath: string
): Promise<void> {
  const db = getServiceClient();
  await db
    .from("code_chunks")
    .delete()
    .eq("project", project)
    .eq("file_path", filePath);
}

export async function upsertFileSummary(
  project: string,
  filePath: string,
  summary: string
): Promise<void> {
  const db = getServiceClient();
  const { error } = await db.from("file_summaries").upsert(
    {
      project,
      file_path: filePath,
      summary,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "project,file_path" }
  );
  if (error) throw new Error(`Failed to upsert summary: ${error.message}`);
}

export async function upsertCodebaseMap(
  project: string,
  mapJson: Record<string, unknown>
): Promise<void> {
  const db = getServiceClient();
  const { error } = await db.from("codebase_maps").upsert(
    {
      project,
      map_json: mapJson,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "project" }
  );
  if (error) throw new Error(`Failed to upsert map: ${error.message}`);
}

// --- Read functions (MCP server, uses anon + project token) ---

export async function searchChunks(
  queryEmbedding: number[],
  limit: number = 10
): Promise<
  Array<{
    id: number;
    project: string;
    file_path: string;
    chunk_index: number;
    content: string;
    start_line: number;
    end_line: number;
    similarity: number;
  }>
> {
  const db = getAnonClient();
  const { data, error } = await db.rpc("search_code_chunks", {
    project_token: getProjectToken(),
    query_embedding: JSON.stringify(queryEmbedding),
    match_count: limit,
  });
  if (error) throw new Error(`Search failed: ${error.message}`);
  return data ?? [];
}

export async function getCodebaseMap(): Promise<Record<string, unknown> | null> {
  const db = getAnonClient();
  const { data, error } = await db.rpc("get_codebase_map_secure", {
    project_token: getProjectToken(),
  });
  if (error) return null;
  return data ?? null;
}

export async function getFileSummary(
  filePath: string
): Promise<string | null> {
  const db = getAnonClient();
  const { data, error } = await db.rpc("get_file_summary_secure", {
    project_token: getProjectToken(),
    target_file_path: filePath,
  });
  if (error) return null;
  return data ?? null;
}

export async function getProjectInfo(): Promise<string | null> {
  const db = getAnonClient();
  const { data, error } = await db.rpc("get_project_info", {
    project_token: getProjectToken(),
  });
  if (error) throw new Error(`Failed to get project info: ${error.message}`);
  if (!data || data.length === 0) return null;
  return data[0].project;
}

// --- Indexer-only: list all projects (service_role) ---

export async function listProjects(): Promise<string[]> {
  const db = getServiceClient();
  const { data, error } = await db
    .from("code_chunks")
    .select("project")
    .limit(1000);
  if (error) throw new Error(`Failed to list projects: ${error.message}`);
  const unique = [...new Set((data ?? []).map((r: { project: string }) => r.project))];
  return unique.sort();
}
