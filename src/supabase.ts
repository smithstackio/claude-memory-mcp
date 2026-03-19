import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env");
}

const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

export async function clearProject(project: string): Promise<void> {
  await supabase.from("code_chunks").delete().eq("project", project);
  await supabase.from("file_summaries").delete().eq("project", project);
  await supabase.from("codebase_maps").delete().eq("project", project);
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
  // Batch insert in groups of 500
  for (let i = 0; i < chunks.length; i += 500) {
    const batch = chunks.slice(i, i + 500);
    const { error } = await supabase.from("code_chunks").insert(batch);
    if (error) throw new Error(`Failed to insert chunks: ${error.message}`);
  }
}

export async function deleteFileChunks(
  project: string,
  filePath: string
): Promise<void> {
  await supabase
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
  const { error } = await supabase.from("file_summaries").upsert(
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
  const { error } = await supabase.from("codebase_maps").upsert(
    {
      project,
      map_json: mapJson,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "project" }
  );
  if (error) throw new Error(`Failed to upsert map: ${error.message}`);
}

export async function searchChunks(
  project: string,
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
  const { data, error } = await supabase.rpc("match_code_chunks", {
    query_embedding: JSON.stringify(queryEmbedding),
    match_project: project,
    match_count: limit,
  });
  if (error) throw new Error(`Search failed: ${error.message}`);
  return data ?? [];
}

export async function getCodebaseMap(
  project: string
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from("codebase_maps")
    .select("map_json")
    .eq("project", project)
    .single();
  if (error) return null;
  return data?.map_json ?? null;
}

export async function getFileSummary(
  project: string,
  filePath: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("file_summaries")
    .select("summary")
    .eq("project", project)
    .eq("file_path", filePath)
    .single();
  if (error) return null;
  return data?.summary ?? null;
}

export async function listProjects(): Promise<string[]> {
  const { data, error } = await supabase
    .from("code_chunks")
    .select("project")
    .limit(1000);
  if (error) throw new Error(`Failed to list projects: ${error.message}`);
  const unique = [...new Set((data ?? []).map((r: { project: string }) => r.project))];
  return unique.sort();
}
