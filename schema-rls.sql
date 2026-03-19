-- Run this in your Supabase SQL Editor for project fzmetpkiuefybrgygyfy
-- This adds project-scoped access tokens and RLS policies

-- Project access tokens
create table project_tokens (
  id bigint generated always as identity primary key,
  project text not null unique,
  token uuid not null default gen_random_uuid(),
  created_at timestamptz default now()
);

alter table project_tokens enable row level security;

-- Deny all direct anon access to data tables
create policy "deny_anon_select_code_chunks" on code_chunks for select to anon using (false);
create policy "deny_anon_insert_code_chunks" on code_chunks for insert to anon with check (false);
create policy "deny_anon_delete_code_chunks" on code_chunks for delete to anon using (false);

create policy "deny_anon_select_file_summaries" on file_summaries for select to anon using (false);
create policy "deny_anon_insert_file_summaries" on file_summaries for insert to anon with check (false);
create policy "deny_anon_delete_file_summaries" on file_summaries for delete to anon using (false);

create policy "deny_anon_select_codebase_maps" on codebase_maps for select to anon using (false);
create policy "deny_anon_insert_codebase_maps" on codebase_maps for insert to anon with check (false);
create policy "deny_anon_delete_codebase_maps" on codebase_maps for delete to anon using (false);

-- Secure RPC: search code chunks
create or replace function search_code_chunks(
  project_token uuid,
  query_embedding vector(1536),
  match_count int default 10
)
returns table (
  id bigint,
  project text,
  file_path text,
  chunk_index int,
  content text,
  start_line int,
  end_line int,
  similarity float
)
language plpgsql
security definer
set search_path = public
as $$
declare
  _project text;
begin
  select pt.project into _project from project_tokens pt where pt.token = project_token;
  if _project is null then raise exception 'Invalid project token'; end if;

  return query
  select c.id, c.project, c.file_path, c.chunk_index, c.content, c.start_line, c.end_line,
    1 - (c.embedding <=> query_embedding) as similarity
  from code_chunks c
  where c.project = _project
  order by c.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- Secure RPC: get codebase map
create or replace function get_codebase_map_secure(project_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _project text;
  _map jsonb;
begin
  select pt.project into _project from project_tokens pt where pt.token = project_token;
  if _project is null then raise exception 'Invalid project token'; end if;

  select cm.map_json into _map from codebase_maps cm where cm.project = _project;
  return _map;
end;
$$;

-- Secure RPC: get file summary
create or replace function get_file_summary_secure(project_token uuid, target_file_path text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  _project text;
  _summary text;
begin
  select pt.project into _project from project_tokens pt where pt.token = project_token;
  if _project is null then raise exception 'Invalid project token'; end if;

  select fs.summary into _summary from file_summaries fs
  where fs.project = _project and fs.file_path = target_file_path;
  return _summary;
end;
$$;

-- Secure RPC: get project info (returns only the token's own project)
create or replace function get_project_info(project_token uuid)
returns table (project text)
language plpgsql
security definer
set search_path = public
as $$
declare
  _project text;
begin
  select pt.project into _project from project_tokens pt where pt.token = project_token;
  if _project is null then raise exception 'Invalid project token'; end if;

  return query select distinct c.project from code_chunks c where c.project = _project;
end;
$$;

-- Grant execute to anon role
grant execute on function search_code_chunks(uuid, vector, int) to anon;
grant execute on function get_codebase_map_secure(uuid) to anon;
grant execute on function get_file_summary_secure(uuid, text) to anon;
grant execute on function get_project_info(uuid) to anon;

-- Seed tokens for existing projects
insert into project_tokens (project) values ('smithstack');
insert into project_tokens (project) values ('partnerfully');
insert into project_tokens (project) values ('tgpc-quote');

-- After running, get your tokens:
-- select project, token from project_tokens;
