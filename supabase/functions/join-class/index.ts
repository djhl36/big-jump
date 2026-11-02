import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("BIGJUMP_ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, "Content-Type": "application/json" },
});

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return reply({ error: "POST required" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authorization = request.headers.get("Authorization") ?? "";
    const token = authorization.replace(/^Bearer\s+/i, "");
    if (!token) return reply({ error: "Anonymous classroom session required" }, 401);

    const authClient = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
    const { data: { user }, error: authError } = await authClient.auth.getUser(token);
    if (authError || !user || !user.is_anonymous) return reply({ error: "Valid anonymous session required" }, 401);

    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const body = await request.json();
    // Without a class code, students join the most recently created class.
    const classCode = String(body.class_code ?? "").trim().toUpperCase();
    if (classCode && !/^BJ-[A-Z0-9]{5,8}$/.test(classCode)) return reply({ error: "수업 코드를 확인해주세요." }, 400);
    const classQuery = admin.from("classes").select("id,name,join_code");
    const { data: classroom, error: classError } = classCode
      ? await classQuery.eq("join_code", classCode).maybeSingle()
      : await classQuery.order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (classError || !classroom) return reply({ error: "아직 열린 수업이 없습니다. 선생님이 수업을 만들 때까지 기다려주세요." }, 404);

    if (body.action === "list-roster") {
      const { data: roster, error } = await admin.from("roster").select("id,student_name,group_id,groups(name),auth_user_id").eq("class_id", classroom.id).order("student_name");
      if (error) throw error;
      const { data: current } = await admin.from("class_members").select("roster_id").eq("class_id", classroom.id).eq("user_id", user.id).maybeSingle();
      const choices = (roster ?? []).filter((row) => !row.auth_user_id || row.auth_user_id === user.id).map((row) => ({
        id: row.id, name: row.student_name, group: (row.groups as { name?: string } | null)?.name ?? "미배정", selected: row.id === current?.roster_id,
      }));
      return reply({ class_id: classroom.id, class_name: classroom.name, class_code: classroom.join_code, roster: choices });
    }

    if (body.action !== "join") return reply({ error: "Unknown action" }, 400);
    const rosterId = String(body.roster_id ?? "");
    const { data: existing } = await admin.from("class_members").select("class_id,user_id,roster_id,display_name,group_id").eq("class_id", classroom.id).eq("user_id", user.id).maybeSingle();
    if (existing) return reply({ membership: existing, class_name: classroom.name });
    const { data: row, error: rowError } = await admin.from("roster").select("id,student_name,group_id,auth_user_id").eq("id", rosterId).eq("class_id", classroom.id).maybeSingle();
    if (rowError || !row) return reply({ error: "학생 명단을 찾을 수 없습니다." }, 404);
    if (row.auth_user_id && row.auth_user_id !== user.id) return reply({ error: "이미 다른 기기에서 연결된 이름입니다. 선생님께 기기 연결을 초기화해달라고 요청하세요." }, 409);
    const { data: claimed, error: claimError } = await admin.from("roster").update({ auth_user_id: user.id }).eq("id", rosterId).or(`auth_user_id.is.null,auth_user_id.eq.${user.id}`).select("id").maybeSingle();
    if (claimError || !claimed) return reply({ error: "이 이름은 다른 기기에서 먼저 연결했습니다." }, 409);
    const { data: membership, error: memberError } = await admin.from("class_members").insert({
      class_id: classroom.id, user_id: user.id, roster_id: row.id, display_name: row.student_name, group_id: row.group_id,
    }).select("class_id,user_id,roster_id,display_name,group_id").single();
    if (memberError) throw memberError;
    return reply({ membership, class_name: classroom.name });
  } catch (error) {
    console.error("join-class", error);
    return reply({ error: error instanceof Error ? error.message : "수업 연결에 실패했습니다." }, 500);
  }
});
