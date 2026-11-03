-- Clear test activity before a real class.
-- KEEPS: classes (class codes), 모둠, student roster names, teacher accounts.
-- REMOVES: videos and their analyses, feedback, checklist records, record board posts,
--          and student device links (so every student can pick their own name again).
-- Video files themselves are removed in the dashboard: Storage > class-videos (SQL can't delete stored files).

-- 1) Preview: what will be removed, per class
select c.name as class_name, c.join_code,
  (select count(*) from public.videos v where v.class_id = c.id) as videos,
  (select count(*) from public.feedback f join public.videos v on v.id = f.video_id where v.class_id = c.id) as feedback,
  (select count(*) from public.activity_progress p where p.class_id = c.id) as checklist_records,
  (select count(*) from public.class_members m where m.class_id = c.id and m.role <> 'teacher') as joined_students,
  (select count(*) from public.roster r where r.class_id = c.id) as roster_names_kept
from public.classes c order by c.created_at;

-- 2) Clear (all in one transaction)
do $$ begin
  delete from public.feedback;
  delete from public.videos;
  delete from public.activity_progress;
  if to_regclass('public.record_posts') is not null then execute 'delete from public.record_posts'; end if;
  delete from public.class_members where role <> 'teacher';
  update public.roster set auth_user_id = null where auth_user_id is not null;
end $$;

-- 3) Check: every count should now be 0
select (select count(*) from public.videos) as videos,
       (select count(*) from public.activity_progress) as checklist_records,
       (select count(*) from public.class_members where role <> 'teacher') as joined_students,
       (select count(*) from public.roster where auth_user_id is not null) as linked_names;
