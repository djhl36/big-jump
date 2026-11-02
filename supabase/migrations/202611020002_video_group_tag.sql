-- Let students tag an upload with any 모둠 of their own class (not only the one they were assigned).
drop policy if exists "Students add own videos to their class" on public.videos;
create policy "Students add own videos to their class" on public.videos for insert to authenticated
with check (
  user_id = (select auth.uid())
  and public.is_class_member(class_id)
  and (
    group_id is null
    or exists (select 1 from public.groups g where g.id = videos.group_id and g.class_id = videos.class_id)
  )
);
