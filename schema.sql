-- Run this in your Supabase SQL Editor

-- Enable pgvector
create extension if not exists vector;

-- Code chunks with embeddings
create table code_chunks (
  id bigint generated always as identity primary key,
  project text not null,
  file_path text not null,
  chunk_index int not null,
  content text not null,
  start_line int not null,
  end_line int not null,
  embedding vector(1536),
  created_at timestamptz default now()
);

-- File summaries (first comment block or first lines)
create table file_summaries (
  id bigint generated always as identity primary key,
  project text not null,
  file_path text not null,
  summary text not null,
  updated_at timestamptz default now(),
  unique(project, file_path)
);

-- Codebase directory maps
create table codebase_maps (
  id bigint generated always as identity primary key,
  project text not null unique,
  map_json jsonb not null,
  updated_at timestamptz default now()
);

-- Indexes
create index idx_chunks_project_file on code_chunks(project, file_path);
create index idx_chunks_embedding on code_chunks
  using hnsw (embedding vector_cosine_ops);
create index idx_summaries_project_file on file_summaries(project, file_path);

-- RLS enabled with no policies = only service key can access
alter table code_chunks enable row level security;
alter table file_summaries enable row level security;
alter table codebase_maps enable row level security;

-- Vector similarity search function
create or replace function match_code_chunks(
  query_embedding vector(1536),
  match_project text,
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
as $$
begin
  return query
  select
    c.id,
    c.project,
    c.file_path,
    c.chunk_index,
    c.content,
    c.start_line,
    c.end_line,
    1 - (c.embedding <=> query_embedding) as similarity
  from code_chunks c
  where c.project = match_project
  order by c.embedding <=> query_embedding
  limit match_count;
end;
$$;
