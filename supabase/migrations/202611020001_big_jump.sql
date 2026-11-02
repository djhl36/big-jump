create extension if not exists pgcrypto;

create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 100),
  join_code text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (class_id, name),
  unique (class_id, id)
);

create table if not exists public.roster (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  student_name text not null check (char_length(student_name) between 1 and 60),
  group_id uuid,
  auth_user_id uuid unique,
  created_at timestamptz not null default now(),
  unique (class_id, student_name),
  foreign key (group_id) references public.groups(id) on delete set null
);

create table if not exists public.class_members (
  class_id uuid not null references public.classes(id) on delete cascade,
  user_id uuid not null,
  roster_id uuid unique references public.roster(id) on delete cascade,
  display_name text not null,
  group_id uuid,
  role text not null default 'student' check (role in ('student','teacher')),
  joined_at timestamptz not null default now(),
  primary key (class_id, user_id),
  foreign key (group_id) references public.groups(id) on delete set null
);

create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  group_id uuid,
  user_id uuid not null,
  display_name text not null,
  exercise text not null,
  storage_path text not null unique,
  duration_seconds numeric(7,3),
  body_mass_kg numeric(5,2),
  height_cm numeric(5,1),
  note text not null default '',
  analysis jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (group_id) references public.groups(id) on delete set null
);

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos(id) on delete cascade,
  user_id uuid not null,
  display_name text not null,
  kind text not null default 'observation' check (kind in ('strength','next_try','balance','observation')),
  content text not null check (char_length(content) between 1 and 600),
  created_at timestamptz not null default now()
);

create table if not exists public.activity_progress (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  user_id uuid not null,
  activity_key text not null,
  item_key text not null,
  checked boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (class_id, user_id, activity_key, item_key)
);

create index if not exists videos_class_created_idx on public.videos(class_id, created_at desc);
create index if not exists feedback_video_created_idx on public.feedback(video_id, created_at);
create index if not exists roster_class_name_idx on public.roster(class_id, student_name);

create or replace function public.is_class_member(target_class uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.class_members cm where cm.class_id = target_class and cm.user_id = (select auth.uid())) $$;

alter table public.classes enable row level security;
alter table public.groups enable row level security;
alter table public.roster enable row level security;
alter table public.class_members enable row level security;
alter table public.videos enable row level security;
alter table public.feedback enable row level security;
alter table public.activity_progress enable row level security;

create policy "Class members read their class" on public.classes for select to authenticated using (public.is_class_member(id));
create policy "Class members read groups" on public.groups for select to authenticated using (public.is_class_member(class_id));
create policy "Class members read roster" on public.roster for select to authenticated using (public.is_class_member(class_id));
create policy "Class members read membership" on public.class_members for select to authenticated using (public.is_class_member(class_id));

create policy "Class members read class videos" on public.videos for select to authenticated using (public.is_class_member(class_id));
create policy "Students add own videos to their class" on public.videos for insert to authenticated
with check (user_id = (select auth.uid()) and public.is_class_member(class_id)
  and exists (select 1 from public.class_members cm where cm.class_id = videos.class_id and cm.user_id = (select auth.uid()) and cm.group_id is not distinct from videos.group_id));
create policy "Owners delete own videos" on public.videos for delete to authenticated using (user_id = (select auth.uid()));

create policy "Class members read video feedback" on public.feedback for select to authenticated
using (exists (select 1 from public.videos v where v.id = feedback.video_id and public.is_class_member(v.class_id)));
create policy "Members post their own feedback" on public.feedback for insert to authenticated
with check (user_id = (select auth.uid()) and exists (select 1 from public.videos v where v.id = feedback.video_id and public.is_class_member(v.class_id)));
create policy "Authors delete their feedback" on public.feedback for delete to authenticated using (user_id = (select auth.uid()));

create policy "Students read own activity progress" on public.activity_progress for select to authenticated using (user_id = (select auth.uid()) and public.is_class_member(class_id));
create policy "Students insert own activity progress" on public.activity_progress for insert to authenticated with check (user_id = (select auth.uid()) and public.is_class_member(class_id));
create policy "Students update own activity progress" on public.activity_progress for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()) and public.is_class_member(class_id));

grant usage on schema public to authenticated;
grant select on public.classes, public.groups, public.roster, public.class_members, public.videos, public.feedback, public.activity_progress to authenticated;
grant insert, delete on public.videos, public.feedback to authenticated;
grant insert, update on public.activity_progress to authenticated;
grant execute on function public.is_class_member(uuid) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('class-videos', 'class-videos', false, 104857600, array['video/mp4','video/quicktime','video/webm'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "Class members watch class videos" on storage.objects for select to authenticated
using (bucket_id = 'class-videos' and (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
  and public.is_class_member(((storage.foldername(name))[1])::uuid));
create policy "Students upload into own class folder" on storage.objects for insert to authenticated
with check (bucket_id = 'class-videos' and (storage.foldername(name))[2] = (select auth.uid())::text
  and (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
  and public.is_class_member(((storage.foldername(name))[1])::uuid));
create policy "Students delete own uploaded videos" on storage.objects for delete to authenticated
using (bucket_id = 'class-videos' and (storage.foldername(name))[2] = (select auth.uid())::text);

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'videos') then
    alter publication supabase_realtime add table public.videos;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'feedback') then
    alter publication supabase_realtime add table public.feedback;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'groups') then
    alter publication supabase_realtime add table public.groups;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'class_members') then
    alter publication supabase_realtime add table public.class_members;
  end if;
end $$;
