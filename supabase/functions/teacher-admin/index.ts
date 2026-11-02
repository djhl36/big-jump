import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("BIGJUMP_ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-teacher-code",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, "Content-Type": "application/json" },
});
function equalSecret(a: string, b: string) {
  const left = new TextEncoder().encode(a), right = new TextEncoder().encode(b);
  let mismatch = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) mismatch |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return mismatch === 0;
}
function newClassCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `BJ-${Array.from(bytes, (byte) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[byte % 32]).join("")}`;
}
const clean = (value: unknown, max = 60) => String(value ?? "").trim().slice(0, max);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return reply({ error: "POST required" }, 405);
  try {
    const pin = request.headers.get("x-teacher-code") ?? "";
    const expected = Deno.env.get("BIGJUMP_TEACHER_CODE") ?? "";
    if (!/^\d{4}$/.test(expected) || !equalSecret(pin, expected)) return reply({ error: "교사 PIN을 확인해주세요." }, 403);
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const authClient = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
    const { data: { user }, error: authError } = await authClient.auth.getUser(token);
    if (authError || !user || !user.is_anonymous) return reply({ error: "익명 교사 세션이 필요합니다." }, 401);
    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const body = await request.json();
    if (body.action === "create-class") {
      const className = clean(body.name, 100);
      const groupNames = [...new Set((body.groups ?? []).map((name: unknown) => clean(name, 40)).filter(Boolean))].slice(0, 12);
      const students = (body.students ?? []).map((name: unknown) => clean(name, 60)).filter(Boolean).slice(0, 60);
      if (!className || groupNames.length < 1 || groupNames.length > 12 || students.length > 60) return reply({ error: "수업 이름과 모둠을 입력해주세요. 학생은 최대 60명까지 등록할 수 있습니다." }, 400);
      let code = newClassCode();
      for (let attempt = 0; attempt < 4; attempt++) {
        const { data: found } = await admin.from("classes").select("id").eq("join_code", code).maybeSingle();
        if (!found) break;
        code = newClassCode();
      }
      const { data: classroom, error: classError } = await admin.from("classes").insert({ name: className, join_code: code }).select("id,name,join_code").single();
      if (classError) throw classError;
      const groupRows = groupNames.map((name: string, sort_order: number) => ({ class_id: classroom.id, name, sort_order }));
      const { data: groups, error: groupError } = await admin.from("groups").insert(groupRows).select("id,name,sort_order");
      if (groupError) throw groupError;
      if (students.length) {
        const roster = students.map((student_name: string, index: number) => ({ class_id: classroom.id, student_name, group_id: groups[index % groups.length].id }));
        const { error } = await admin.from("roster").insert(roster);
        if (error) throw error;
      }
      const { error: teacherMemberError } = await admin.from("class_members").insert({ class_id: classroom.id, user_id: user.id, display_name: "교사", role: "teacher" });
      if (teacherMemberError) throw teacherMemberError;
      return reply({ classroom, groups, student_count: students.length });
    }

    const code = clean(body.class_code, 16).toUpperCase();
    const { data: classroom, error: classError } = await admin.from("classes").select("id,name,join_code").eq("join_code", code).maybeSingle();
    if (classError || !classroom) return reply({ error: "수업 코드를 찾을 수 없습니다." }, 404);

    if (body.action === "load-class") {
      const [{ data: groups, error: groupError }, { data: roster, error: rosterError }] = await Promise.all([
        admin.from("groups").select("id,name,sort_order").eq("class_id", classroom.id).order("sort_order"),
        admin.from("roster").select("id,student_name,group_id,auth_user_id,groups(name)").eq("class_id", classroom.id).order("student_name"),
      ]);
      if (groupError) throw groupError;
      if (rosterError) throw rosterError;
      return reply({ classroom, groups, roster });
    }
    if (body.action !== "save-roster") return reply({ error: "Unknown action" }, 400);

    const groupNames = [...new Set((body.groups ?? []).map((name: unknown) => clean(name, 40)).filter(Boolean))].slice(0, 12);
    const students = (body.students ?? []).map((item: { name?: unknown; group?: unknown }) => ({
      name: clean(item.name, 60), group: clean(item.group, 40),
    })).filter((item: { name: string }) => item.name).slice(0, 60);
    if (!groupNames.length) return reply({ error: "모둠을 하나 이상 입력해주세요." }, 400);
    const { error: groupUpsertError } = await admin.from("groups").upsert(groupNames.map((name: string, sort_order: number) => ({ class_id: classroom.id, name, sort_order })), { onConflict: "class_id,name" });
    if (groupUpsertError) throw groupUpsertError;
    const { data: groups, error: groupFetchError } = await admin.from("groups").select("id,name").eq("class_id", classroom.id);
    if (groupFetchError) throw groupFetchError;
    const groupMap = new Map(groups.map((group: { id: string; name: string }) => [group.name, group.id]));
    const rosterRows = students.map((student: { name: string; group: string }) => ({
      class_id: classroom.id, student_name: student.name, group_id: groupMap.get(student.group) ?? null,
    }));
    if (rosterRows.length) {
      const { error } = await admin.from("roster").upsert(rosterRows, { onConflict: "class_id,student_name" });
      if (error) throw error;
    }
    const names = new Set(students.map((student: { name: string }) => student.name));
    const { data: existingRoster, error: existingError } = await admin.from("roster").select("id,student_name,auth_user_id,group_id").eq("class_id", classroom.id);
    if (existingError) throw existingError;
    for (const row of existingRoster ?? []) {
      if (!names.has(row.student_name) && !row.auth_user_id) await admin.from("roster").delete().eq("id", row.id).is("auth_user_id", null);
      if (row.auth_user_id && names.has(row.student_name)) {
        const updated = rosterRows.find((item: { student_name: string }) => item.student_name === row.student_name);
        if (updated) await admin.from("class_members").update({ group_id: updated.group_id }).eq("class_id", classroom.id).eq("user_id", row.auth_user_id);
      }
    }
    return reply({ saved: true, student_count: rosterRows.length, groups: groups.map((group: { name: string }) => group.name) });
  } catch (error) {
    console.error("teacher-admin", error);
    return reply({ error: error instanceof Error ? error.message : "교사 작업을 완료하지 못했습니다." }, 500);
  }
});
