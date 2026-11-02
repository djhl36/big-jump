-- Members of the same 모둠 can see and check each other's activity checklist.
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

-- Live updates so the exercising student sees checks appear.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'activity_progress') then
    alter publication supabase_realtime add table public.activity_progress;
  end if;
end $$;
