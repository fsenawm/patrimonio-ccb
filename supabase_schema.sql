-- Tabela principal de patrimônio da CCB no Supabase
create table if not exists public.patrimonio_items (
  code text primary key,
  desc_item text not null,
  cat text default '',
  loc text default '',
  obs text default '',
  extra jsonb default '{}'::jsonb,
  photo text,
  checked boolean default false,
  at timestamptz,
  by_user text,
  updated_at timestamptz default now()
);

-- Habilita RLS (Row Level Security) com política aberta para uso via chave anon do app
alter table public.patrimonio_items enable row level security;

drop policy if exists "Allow all for anon" on public.patrimonio_items;
create policy "Allow all for anon"
  on public.patrimonio_items
  for all
  using (true)
  with check (true);

