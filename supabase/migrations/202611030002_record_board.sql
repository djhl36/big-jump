-- Big Jump: record sheet + record board. This one file includes everything from
-- 202611020003_peer_checklist.sql and 202611030001_activity_records.sql. Safe to run more than once.

-- 1) Each checklist item can hold a record: {value, by, at, source, video_id}.
alter table public.activity_progress add column if not exists record jsonb;

-- 2) Members of the same 모둠 can see and fill in each other's records.
create or replace function public.same_group(target_class uuid, target_user uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.class_members me
    join public.class_members them on them.class_id = me.class_id
    where me.class_id = target_class and me.user_id = (select auth.uid()) and them.user_id = target_user
      and (me.role = 'teacher' or (me.group_id is not null and me.group_id = them.group_id))
  )
$$;
grant execute on function public.same_group(uuid, uuid) to authenticated;

drop policy if exists "Students read own activity progress" on public.activity_progress;
drop policy if exists "Students insert own activity progress" on public.activity_progress;
drop policy if exists "Students update own activity progress" on public.activity_progress;
drop policy if exists "Class members read activity progress" on public.activity_progress;
drop policy if exists "Group members insert activity progress" on public.activity_progress;
drop policy if exists "Group members update activity progress" on public.activity_progress;
create policy "Class members read activity progress" on public.activity_progress for select to authenticated
using (public.is_class_member(class_id));
create policy "Group members insert activity progress" on public.activity_progress for insert to authenticated
with check (public.is_class_member(class_id) and (user_id = (select auth.uid()) or public.same_group(class_id, user_id)));
create policy "Group members update activity progress" on public.activity_progress for update to authenticated
using (user_id = (select auth.uid()) or public.same_group(class_id, user_id))
with check (public.is_class_member(class_id) and (user_id = (select auth.uid()) or public.same_group(class_id, user_id)));

-- 3) Record board: a snapshot of a student's record sheet, posted for the class.
create table if not exists public.record_posts (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  user_id uuid not null,
  display_name text not null check (char_length(display_name) between 1 and 60),
  group_id uuid references public.groups(id) on delete set null,
  activity_key text not null check (char_length(activity_key) between 1 and 60),
  items jsonb not null default '[]'::jsonb,
  memo text not null default '' check (char_length(memo) <= 200),
  posted_by uuid not null default auth.uid(),
  posted_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists record_posts_class_created on public.record_posts (class_id, created_at desc);
alter table public.record_posts enable row level security;
drop policy if exists "Class members read record posts" on public.record_posts;
drop policy if exists "Members post own or group records" on public.record_posts;
drop policy if exists "Authors delete record posts" on public.record_posts;
create policy "Class members read record posts" on public.record_posts for select to authenticated
using (public.is_class_member(class_id));
create policy "Members post own or group records" on public.record_posts for insert to authenticated
with check (posted_by = (select auth.uid()) and public.is_class_member(class_id)
  and (user_id = (select auth.uid()) or public.same_group(class_id, user_id)));
create policy "Authors delete record posts" on public.record_posts for delete to authenticated
using (posted_by = (select auth.uid()) or user_id = (select auth.uid()));
grant select, insert, delete on public.record_posts to authenticated;

-- 4) Live updates.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'activity_progress') then
    alter publication supabase_realtime add table public.activity_progress;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'record_posts') then
    alter publication supabase_realtime add table public.record_posts;
  end if;
end $$;
