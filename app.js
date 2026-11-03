import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { analyzeJump, drawPose } from './pose-analysis.js?v=582005e9c3';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const config = window.BIGJUMP_CONFIG || {};
const hasConfig = Boolean(config.supabaseUrl && config.supabaseKey);
const supabase = hasConfig ? createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
}) : null;
const videoBucket = config.videoBucket || 'class-videos';
const analysisDialog = $('#analysisDialog');
const uploadDialog = $('#uploadDialog');
const joinDialog = $('#joinDialog');
const teacherDialog = $('#teacherDialog');
const localVideo = $('#localAnalysisVideo');
const poseCanvas = $('#poseCanvas');

let authUser = null;
let membership = null;
let classInfo = null;
let groups = [];
let selectedFile = null;
let selectedVideo = null;
let currentAnalysis = null;
let currentSamples = [];
let analysisWorker = null;
let showSkeleton = true;
let playbackSpeed = 0.5;
let videoRows = [];
let realtimeChannel = null;
let realtimeTimer = null;

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 3200);
}
function escaped(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
}
function fileSize(bytes) {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)}KB` : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
function formatTime(value) {
  if (!Number.isFinite(value)) return '00:00';
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
}
function setConnection(text, isOnline = false) {
  $('#connectionState').textContent = text;
  $('#connectionState').classList.toggle('online-state', isOnline);
}
function showJoinError(message) { $('#joinError').textContent = message || ''; }
function showTeacherError(message) { $('#teacherError').textContent = message || ''; }

async function invoke(name, body, headers = {}) {
  const { data, error } = await supabase.functions.invoke(name, { body, headers });
  if (error) {
    let message = error.message || '요청에 실패했습니다.';
    if (error.context?.json) {
      try { const detail = await error.context.json(); if (detail.error) message = detail.error; } catch { /* keep the useful function error */ }
    }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

async function ensureAnonymousSession() {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (session) return session.user;
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return data.user;
}

const isAdminMode = new URLSearchParams(location.search).has('admin');
async function openAdmin() {
  joinDialog.close();
  teacherTab('roster');
  teacherDialog.showModal();
  if ($('#teacherClassCode').textContent === '—') {
    try {
      const data = await invoke('join-class', { action: 'list-roster' });
      $('#teacherClassCode').textContent = data.class_code;
    } catch (error) { showTeacherError(error.message); }
  }
  $('#teacherPin').focus();
}
async function startApp() {
  if (!supabase) {
    setConnection('연결 설정 필요');
    showJoinError('config.js에 Supabase URL과 publishable key를 설정해주세요.');
    joinDialog.showModal();
    return;
  }
  setConnection('Supabase 연결 중…');
  try {
    authUser = await ensureAnonymousSession();
    setConnection('익명 기기 연결됨', true);
    const { data: rows, error } = await supabase.from('class_members')
      .select('class_id,user_id,roster_id,display_name,group_id,role')
      .eq('user_id', authUser.id).order('joined_at', { ascending: false }).limit(1);
    if (error) throw error;
    const data = rows?.[0];
    if (isAdminMode) { if (data) await loadClassroom(data); openAdmin(); return; }
    if (data) await loadClassroom(data);
    else {
      joinDialog.showModal();
      listRoster();
    }
  } catch (error) {
    setConnection('서버 설정 확인 필요');
    showJoinError(`${error.message} · SQL 마이그레이션과 익명 인증 설정을 확인해주세요.`);
    joinDialog.showModal();
  }
}

async function loadClassroom(member) {
  membership = member;
  const [{ data: classroom, error: classError }, { data: groupRows, error: groupError }] = await Promise.all([
    supabase.from('classes').select('id,name,join_code').eq('id', member.class_id).single(),
    supabase.from('groups').select('id,name,sort_order').eq('class_id', member.class_id).order('sort_order'),
  ]);
  if (classError) throw classError;
  if (groupError) throw groupError;
  const {data: participants}=await supabase.from('class_members').select('display_name,role').eq('class_id',member.class_id).order('joined_at').limit(25);
  classInfo = classroom;
  groups = groupRows || [];
  localStorage.setItem('bigjump.classId', member.class_id);
  $('#profileName').textContent = member.display_name;
  $('#profileAvatar').textContent = member.display_name.slice(0, 1);
  setConnection(member.role === 'teacher' ? '교사 · 실시간 연결' : '수업 참여 중', true);
  $('.workspace-meta strong').textContent = classroom.name;
  $('#classHeadingTitle').textContent = classroom.name;
  const memberStack=$('.member-stack');
  memberStack.innerHTML=(participants||[]).slice(0,3).map((person,index)=>`<i class="member-tone-${index%3}">${escaped(person.display_name.slice(0,1))}</i>`).join('')+((participants||[]).length>3?`<span>+${participants.length-3}</span>`:'');
  $('.meta-count').textContent=`${(participants||[]).length}명 참여`;
  joinDialog.close();
  renderGroups();
  updateTopbarMe();
  await Promise.all([loadFeed(), loadChecklist(), loadGroupMembers(), loadBoard()]);
  subscribeToClass();
}

function updateTopbarMe() {
  if (!membership) { $('#topbarMe').textContent = ''; return; }
  if (membership.role === 'teacher') { $('#topbarMe').textContent = '교사'; return; }
  const group = groups.find(item => item.id === membership.group_id);
  $('#topbarMe').innerHTML = `<span>${escaped(group?.name || '모둠 미정')}</span> / <strong>${escaped(membership.display_name)}</strong>`;
}
function subscribeToClass() {
  if(realtimeChannel)supabase.removeChannel(realtimeChannel);
  realtimeChannel=supabase.channel(`big-jump-${membership.class_id}`)
    .on('postgres_changes',{event:'*',schema:'public',table:'videos',filter:`class_id=eq.${membership.class_id}`},scheduleFeedRefresh)
    .on('postgres_changes',{event:'*',schema:'public',table:'feedback'},scheduleFeedRefresh)
    .on('postgres_changes',{event:'*',schema:'public',table:'groups',filter:`class_id=eq.${membership.class_id}`},async()=>{
      const {data}=await supabase.from('groups').select('id,name,sort_order').eq('class_id',membership.class_id).order('sort_order');
      if(data){groups=data;renderGroups();renderFeed();updateTopbarMe();}
    })
    .on('postgres_changes',{event:'*',schema:'public',table:'class_members',filter:`class_id=eq.${membership.class_id}`},()=>{scheduleFeedRefresh();loadGroupMembers();})
    .on('postgres_changes',{event:'*',schema:'public',table:'activity_progress',filter:`class_id=eq.${membership.class_id}`},payload=>{
      const row=payload.new;if(!row?.user_id)return;
      progress.set(progressKey(row.user_id,row.activity_key,row.item_key),{checked:row.checked,record:row.record||null});renderActivities();
    })
    .subscribe(status=>{if(status==='SUBSCRIBED')setConnection(membership.role==='teacher'?'교사 · 실시간 연결':'수업 참여 중',true);});
}
function scheduleFeedRefresh() {
  clearTimeout(realtimeTimer);
  realtimeTimer=setTimeout(()=>loadFeed(),450);
}

async function listRoster() {
  showJoinError('');
  $('#studentNameSelect').innerHTML = '<option value="">명단 확인 중…</option>';
  $('#joinClassName').textContent = '';
  try {
    // No class code: the server returns the most recently created class.
    const data = await invoke('join-class', { action: 'list-roster' });
    $('#joinCode').value = data.class_code;
    $('#joinClassName').textContent = data.class_name;
    classInfo = { id: data.class_id, name: data.class_name, join_code: data.class_code };
    const lastRosterId = localStorage.getItem('bigjump.rosterId');
    const options = ['<option value="">이름을 선택해주세요</option>', ...data.roster.map(row => `<option value="${escaped(row.id)}" ${row.selected || row.id === lastRosterId ? 'selected' : ''}>${escaped(row.name)} · ${escaped(row.group)}</option>`)];
    $('#studentNameSelect').innerHTML = options.join('');
    if (!data.roster.length) showJoinError('명단이 없거나 이미 모든 이름이 연결되어 있습니다. 선생님께 확인해주세요.');
  } catch (error) {
    $('#studentNameSelect').innerHTML = '<option value="">이름을 선택해주세요</option>';
    showJoinError(error.message);
  }
}
$('#joinSubmit').addEventListener('click', async () => {
  const code = $('#joinCode').value.trim().toUpperCase();
  const rosterId = $('#studentNameSelect').value;
  if (!code) { listRoster(); return; }
  if (!rosterId) { showJoinError('내 이름을 선택해주세요.'); return; }
  $('#joinSubmit').disabled = true;
  try {
    const data = await invoke('join-class', { action: 'join', class_code: code, roster_id: rosterId });
    localStorage.setItem('bigjump.rosterId', rosterId);
    await loadClassroom(data.membership);
    toast(`${data.class_name}에 참여했습니다.`);
  } catch (error) { showJoinError(error.message); }
  finally { $('#joinSubmit').disabled = false; }
});
$('#teacherJoinLink').addEventListener('click',()=>{
  joinDialog.close();
  $('#teacherClassCode').textContent=classInfo?.join_code||localStorage.getItem('bigjump.teacherClassCode')||'—';
  teacherDialog.showModal();
});

function renderGroups() {
  const host = $('.sidebar .group-label');
  $$('.sidebar .group-link').forEach(button => button.remove());
  const groupButtons=document.createDocumentFragment();
  groups.forEach((group, index) => {
    const button = document.createElement('button');
    button.className = 'group-link';
    button.dataset.group = group.id;
    button.innerHTML = `<span class="group-avatar ${['ga-blue','ga-orange','ga-purple','ga-green'][index%4]}">${escaped(group.name.slice(0,1))}</span><span>${escaped(group.name)}</span>`;
    button.addEventListener('click', () => applyGroupFilter($('#filterButton').dataset.group === group.id ? '' : group.id));
    groupButtons.append(button);
  });
  host.after(groupButtons);
  applyGroupFilter('');
}

async function loadFeed() {
  if (!membership) return;
  const { data, error } = await supabase.from('videos')
    .select('id,class_id,group_id,user_id,display_name,exercise,storage_path,duration_seconds,body_mass_kg,height_cm,note,analysis,created_at,groups(name),feedback(id,display_name,kind,content,created_at)')
    .eq('class_id', membership.class_id).order('created_at', { ascending: false }).limit(60);
  if (error) { toast(error.message); return; }
  videoRows = data || [];
  await Promise.all(videoRows.map(async row => {
    const { data: signed } = await supabase.storage.from(videoBucket).createSignedUrl(row.storage_path, 3600);
    row.signedUrl = signed?.signedUrl || '';
  }));
  renderFeed();
}

function metricMarkup(label, value, unit) {
  return `<div><span>${label}</span><strong>${value == null ? '—' : Number(value).toLocaleString('ko-KR')} <small>${unit}</small></strong></div>`;
}
function renderFeed() {
  const feed = $('#feedGrid');
  feed.replaceChildren();
  $('#wallCount').textContent = String(videoRows.length);
  if(!videoRows.length){const empty=document.createElement('div');empty.className='feed-placeholder';empty.textContent='아직 공유된 동작이 없어요. 첫 영상을 올려주세요.';feed.append(empty);}
  const groupOrder = id => { const i = groups.findIndex(g=>g.id===id); return i<0 ? groups.length : i; };
  const ordered = [...videoRows].sort((a,b)=>groupOrder(a.group_id)-groupOrder(b.group_id) || new Date(b.created_at)-new Date(a.created_at));
  let lastGroup;
  for (const row of ordered) {
    const group = groups.find(item => item.id === row.group_id);
    if (row.group_id !== lastGroup) {
      lastGroup = row.group_id;
      const heading = document.createElement('div');
      heading.className = 'group-section-title';
      heading.dataset.group = row.group_id || '';
      const count = ordered.filter(item=>item.group_id===row.group_id).length;
      heading.innerHTML = `<strong>${escaped(group?.name || '모둠 없음')}</strong><span>${count}개 영상</span>`;
      feed.append(heading);
    }
    const results = row.analysis || {};
    const card = document.createElement('article');
    card.className = 'post-card';
    card.dataset.group = row.group_id || '';
    card.dataset.video = row.id;
    const feedback = (row.feedback || []).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
    const latest = feedback[0];
    const complete = Number.isFinite(Number(results.jump_height_cm));
    const thumb = row.signedUrl
      ? `<video src="${escaped(row.signedUrl)}" muted playsinline preload="metadata"></video>`
      : `<div class="thumb-placeholder">영상 미리보기를 불러오지 못했습니다</div>`;
    card.innerHTML = `<div class="video-thumb uploaded-thumb ${complete?'video-a':'video-b'}">${thumb}<button class="video-center-play" data-open-video="${escaped(row.id)}" aria-label="분석 보기">▶</button><span class="video-duration">${formatTime(row.duration_seconds)}</span><span class="video-tag ${complete?'':'pending-tag'}">${complete?'동작 분석 완료':'분석 대기'}</span></div><div class="post-body"><div class="post-author"><div class="person-avatar avatar-blue">${escaped(row.display_name.slice(0,1))}</div><div><strong>${escaped(row.display_name)} <span class="group-badge">${escaped(group?.name || '미배정')}</span></strong><small>${new Date(row.created_at).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})} · ${escaped(row.exercise)}</small></div><button class="more-button" data-delete-video="${escaped(row.id)}" aria-label="내 영상 삭제">···</button></div>${row.note?`<div class="peer-note"><span>✎</span> 나의 관찰 메모<p>${escaped(row.note)}</p></div>`:''}<div class="metric-row">${metricMarkup('점프 높이',results.jump_height_cm,'cm')}${metricMarkup('착지 힘',jumpLooksWrong(results)?null:results.landing_force_bw,'×체중')}${metricMarkup('추정 파워',plausiblePower(results),'W')}</div><div class="post-foot"><button class="comment-count" data-comments="${escaped(row.id)}">▱ <span>피드백 ${feedback.length}</span></button><div class="reaction-list"></div><button class="analyze-link" data-open-video="${escaped(row.id)}">분석 보기 <span>↗</span></button></div>${latest?`<div class="inline-comment"><div class="mini-avatar">${escaped(latest.display_name.slice(0,1))}</div><span>${escaped(latest.content)}</span></div>`:''}</div>`;
    feed.append(card);
  }
  const add=document.createElement('button');add.className='add-card';add.id='addCard';add.innerHTML='<span class="add-ring">＋</span><strong>내 동작 영상 올리기</strong><span>영상을 올리고 친구들과 관찰 내용을 나눠요.</span><small>MP4 · MOV · 최대 100MB</small>';add.addEventListener('click',openUpload);feed.append(add);
  $$('[data-open-video]',feed).forEach(button=>button.addEventListener('click',()=>openSavedVideo(button.dataset.openVideo)));
  $$('[data-comments]',feed).forEach(button=>button.addEventListener('click',async()=>{const open=openSavedVideo(button.dataset.comments);setTimeout(()=>$('#commentThread').scrollIntoView({behavior:'smooth',block:'start'}),300);await open;}));
  if(analysisDialog.open)renderComments();
  $$('[data-delete-video]',feed).forEach(button=>button.addEventListener('click',()=>deleteVideo(button.dataset.deleteVideo)));
  applyGroupFilter($('#filterButton').dataset.group||'');
  renderActivities(); // record suggestions read from the analysed videos
}
function applyGroupFilter(groupId) {
  $('#filterButton').dataset.group = groupId;
  const group = groups.find(g=>g.id===groupId);
  $('#filterButton').innerHTML = `${group?escaped(group.name):'모든 모둠'} <span>⌄</span>`;
  $$('.post-card, .group-section-title').forEach(el=>el.classList.toggle('hidden-by-filter',Boolean(groupId)&&el.dataset.group!==groupId));
  $$('.sidebar .group-link').forEach(link=>link.classList.toggle('active',link.dataset.group===groupId));
}

// Each checklist item is a record, not just a tick.
//  video:  value comes from the video analysis (a peer can also type it in)
//  number: a peer counts or times it while watching (hop drills are not filmed)
//  rating: a peer's three-step observation, for movement quality numbers can't show
const V = (field, label, unit, digits, goal) => ({ type:'video', field, label, unit, digits, goal });
const N = (label, unit, goal, extra = {}) => ({ type:'number', label, unit, goal, digits:1, ...extra });
const R = label => ({ type:'rating', label });
const perSecond = count => ({ stopwatch:true, calc:value => value > 0 ? `초당 ${(count/value).toFixed(1)}회` : '' });
const accuracyOf = countKey => ({ calc:(value, get) => { const total = Number(get(countKey)); return total > 0 ? `정확도 ${Math.max(0,Math.round((total-value)/total*100))}% · 성공 ${Math.max(0,total-value)}회` : ''; } });
const ACTIVITIES = [
  { key:'pogo-jump', name:'포고 점프', en:'Pogo Jump', filmed:false, desc:'발목 반동으로 짧고 빠르게 튀어 올라요. 촬영 없이 시간·횟수를 재요.', items:[
    ['pogo_10s','10초 포고 점프','10초 동안 쉬지 않고 최대한 빠르게. 친구가 세어주기',N('10초 동안 횟수','회',{text:'지난 기록보다 많이'},{timer:10})],
    ['pogo_20','20회 빠르게','20회를 하는 데 걸린 시간을 재요',N('20회 걸린 시간','초',{text:'짧을수록 좋아요'},perSecond(20))],
    ['heel_touch','앞꿈치 착지','10초 동안 뒤꿈치가 바닥에 닿은 횟수',N('뒤꿈치 닿은 횟수','회',{max:0,text:'0회'})],
    ['ankle_spring','발목 탄성','무릎은 거의 굽히지 않고 발목 반동으로 튀어 오르기',R('관찰 평가')]]},
  { key:'jump-stick', name:'점프 앤 스틱', en:'Jump & Stick', filmed:true, desc:'폭발적으로 도약한 뒤 균형 있게 착지해요. 옆에서 촬영해 분석해요.', items:[
    ['explosive_takeoff','폭발적인 도약','팔 스윙과 함께 발목·무릎·고관절을 빠르게 펴기',V('jump_height_cm','점프 높이','cm',1,{text:'지난 기록보다 높게'})],
    ['triple_extension','관절 신전 속도','도약 직전 무릎이 펴지는 속도 (발목·고관절은 분석 화면에서)',V('knee_extension_angular_velocity_deg_s','무릎 신전 각속도','°/s',0,{text:'지난 기록보다 빠르게'})],
    ['shock_absorption','부드러운 착지','발목·무릎·고관절을 함께 굽혀 충격 흡수하기',V('landing_force_bw','평균 착지 힘','×체중',1,{max:3,text:'체중의 3배 이하'})],
    ['posture_control','균형 있는 2초 정지','추가 스텝 없이 2초 동안, 몸통이 흔들리지 않게',V('balance_score','착지 균형 점수','점',0,{min:70,text:'70점 이상'})]]},
  { key:'broad-jump-series', name:'브로드 점프 연속동작', en:'Broad Jump Series', filmed:true, desc:'앞으로 멀리 뛰고 리듬 있게 이어가요. 옆에서 촬영해 분석해요.', items:[
    ['full_extension','전신 신전','발목·무릎·고관절을 쭉 펴서 앞쪽 위로 뛰기',V('hip_extension_angular_velocity_deg_s','고관절 신전 각속도','°/s',0,{text:'지난 기록보다 빠르게'})],
    ['distance','3회 연속 거리','출발선부터 세 번째 착지한 뒤꿈치까지 줄자로 재기',N('3회 연속 거리','cm',{text:'지난 기록보다 멀리'})],
    ['stable_landing','부드러운 착지','엉덩이를 뒤로 빼며 양발로 동시에 착지하기',V('landing_force_bw','평균 착지 힘','×체중',1,{max:3,text:'체중의 3배 이하'})],
    ['rhythm_link','리듬 연결','착지 후 멈추지 않고 다음 점프로 이어가기',V('mean_contact_time_s','착지~다음 도약 시간','초',2,{max:0.5,text:'0.5초 이하'})]]},
  { key:'lateral-line-hop', name:'좌우 라인홉', en:'Lateral Line Hop', filmed:false, desc:'선을 사이에 두고 좌우로 빠르게 넘어요. 촬영 없이 시간·횟수를 재요.', items:[
    ['lat_10s','10초 좌우 라인홉','10초 동안 선을 넘은 횟수. 친구가 세어주기',N('10초 동안 넘은 횟수','회',{text:'지난 기록보다 많이'},{timer:10})],
    ['lat_miss','선 밟지 않기','같은 10초 동안 선을 밟은 횟수',N('선 밟은 횟수','회',{max:0,text:'0회'},accuracyOf('lat_10s'))],
    ['lat_20','20회 빠르게','20회를 넘는 데 걸린 시간을 재요',N('20회 걸린 시간','초',{text:'짧을수록 좋아요'},perSecond(20))],
    ['centered_trunk','몸통 중심','상체는 가운데, 다리만 좌우로 움직이기',R('관찰 평가')]]},
  { key:'forward-back-line-hop', name:'앞뒤 라인홉', en:'Forward-Back Line Hop', filmed:false, desc:'선을 사이에 두고 앞뒤로 빠르게 넘어요. 촬영 없이 시간·횟수를 재요.', items:[
    ['fb_10s','10초 앞뒤 라인홉','10초 동안 선을 넘은 횟수. 친구가 세어주기',N('10초 동안 넘은 횟수','회',{text:'지난 기록보다 많이'},{timer:10})],
    ['fb_miss','선 밟지 않기','같은 10초 동안 선을 밟은 횟수',N('선 밟은 횟수','회',{max:0,text:'0회'},accuracyOf('fb_10s'))],
    ['fb_20','20회 빠르게','20회를 넘는 데 걸린 시간을 재요',N('20회 걸린 시간','초',{text:'짧을수록 좋아요'},perSecond(20))],
    ['upright_trunk','상체 유지','상체가 앞뒤로 숙여지지 않게 하기',R('관찰 평가')]]},
];
const FILMED = ACTIVITIES.filter(a=>a.filmed);
const RATINGS = [['good','잘함'],['ok','보통'],['again','다시']];
const progress = new Map(); // `${userId}:${activity}:${item}` -> {checked, record}
const progressKey = (user, activity, item) => `${user}:${activity}:${item}`;
const entryFor = (user, activity, item) => progress.get(progressKey(user, activity, item));
const isDone = entry => Boolean(entry && (entry.record?.value != null || entry.checked));
let groupMembers = []; // students in my 모둠, in a fixed order for the role rotation
let checkTarget = null; // whose checklist is open
const chosenVideo = new Map(); // `${target}:${activity}` -> video id picked for records
let currentActivity = (()=>{ try { return localStorage.getItem('bigjump.activity'); } catch { return null; } })();
if (!ACTIVITIES.some(a=>a.key===currentActivity)) currentActivity = 'jump-stick';
const activityByKey = key => ACTIVITIES.find(a=>a.key===key) || ACTIVITIES[1];
const activityDone = (activity, user = authUser?.id) => activity.items.every(([item])=>isDone(entryFor(user,activity.key,item)));
// Rotation inside a 모둠: while one member exercises, the next films (or times) and the one after gives feedback and records.
function rotationFor(userId) {
  const n = groupMembers.length, i = groupMembers.findIndex(m=>m.user_id===userId);
  if (n < 2 || i < 0) return null;
  return { film: groupMembers[(i+1)%n], feedback: groupMembers[(i+(n>=3?2:1))%n] };
}
async function loadGroupMembers() {
  if (!membership) return;
  const { data, error } = await supabase.from('class_members').select('user_id,display_name,group_id,role').eq('class_id', membership.class_id);
  if (error) return;
  const me = (data||[]).find(m=>m.user_id===authUser.id);
  if (me && me.group_id !== membership.group_id) { membership.group_id = me.group_id; updateTopbarMe(); }
  groupMembers = membership.group_id ? (data||[]).filter(m=>m.role!=='teacher'&&m.group_id===membership.group_id).sort((a,b)=>a.display_name.localeCompare(b.display_name,'ko')) : [];
  if (!groupMembers.some(m=>m.user_id===checkTarget)) checkTarget = authUser.id;
  renderActivities();
}

// Analysed videos of this activity that can feed the target's records:
// the target's own uploads first, then the 모둠's (the filmer may upload from their own phone).
function recordVideos(activity, targetId) {
  const memberIds = new Set([targetId, ...groupMembers.map(m=>m.user_id)]);
  return videoRows
    .filter(row => row.exercise === activity.name && row.analysis && (memberIds.has(row.user_id) || (membership?.group_id && row.group_id === membership.group_id)))
    .sort((a,b) => (b.user_id===targetId) - (a.user_id===targetId) || new Date(b.created_at) - new Date(a.created_at));
}
function formatRecord(value, rec) {
  if (value == null || value === '') return '—';
  if (rec.type === 'rating') return RATINGS.find(([k])=>k===value)?.[1] || value;
  return `${Number(value).toLocaleString('ko-KR',{maximumFractionDigits:rec.digits??1})}${rec.unit?` ${rec.unit}`:''}`;
}
function meetsGoal(value, goal) {
  if (value == null || !goal) return null;
  if (goal.min != null) return Number(value) >= goal.min;
  if (goal.max != null) return Number(value) <= goal.max;
  return null;
}
function recordControl(rec, entry, suggestion, itemKey) {
  const value = entry?.record?.value;
  if (rec.type === 'rating') {
    return `<div class="rating-row">${RATINGS.map(([k,label])=>`<button type="button" data-rate="${k}" class="${value===k?'selected':''}">${label}</button>`).join('')}</div>`;
  }
  const fill = rec.type === 'video'
    ? (suggestion != null
      ? `<button type="button" class="fill-button" data-fill="${suggestion}">📹 영상값 ${escaped(formatRecord(suggestion,rec))}</button>`
      : '<span class="fill-empty">📹 영상값 없음 · 영상을 올리면 채워져요</span>')
    : '';
  const tool = rec.timer ? `<button type="button" class="timer-button" data-timer="${rec.timer}" data-timer-key="${itemKey}">⏱ ${rec.timer}초 타이머</button>`
    : rec.stopwatch ? `<button type="button" class="timer-button" data-stopwatch data-timer-key="${itemKey}">⏱ 스톱워치</button>` : '';
  return `<div class="record-row"><input type="number" inputmode="decimal" step="any" min="0" value="${value ?? ''}" placeholder="${rec.type==='video'?'영상값 또는 직접 입력':rec.unit==='초'?'걸린 시간':'세어서 입력'}"><em>${escaped(rec.unit||'')}</em><button type="button" class="save-record">기록</button></div>${fill}${tool}`;
}

function renderActivities() {
  const typing = document.activeElement?.closest?.('.record-item');
  const typed = typing ? { key: typing.dataset.checkKey, value: document.activeElement.value } : null;
  const activity = activityByKey(currentActivity);
  const card = $('.check-card');
  let tabs = $('#activityTabs');
  if (!tabs) { tabs = document.createElement('div'); tabs.id = 'activityTabs'; tabs.className = 'activity-tabs'; card.prepend(tabs); }
  tabs.innerHTML = ACTIVITIES.map((a,i)=>`<button type="button" data-activity="${a.key}" class="${a.key===activity.key?'selected':''} ${activityDone(a)?'done':''}">${a.filmed?'📹':'⏱'} ${escaped(a.name)}${activityDone(a)?' ✓':''}</button>`).join('');
  let who = $('#checkWho');
  if (!who) { who = document.createElement('div'); who.id = 'checkWho'; who.className = 'check-who'; tabs.after(who); }
  const me = { user_id: authUser?.id, display_name: membership?.display_name || '나' };
  const target = groupMembers.find(m=>m.user_id===checkTarget) || me;
  const roles = rotationFor(target.user_id);
  who.innerHTML = groupMembers.length > 1
    ? `<div class="check-who-label">운동하는 모둠원을 고르고 서로 기록해줘요</div><div class="member-chips">${groupMembers.map(m=>`<button type="button" data-check-target="${escaped(m.user_id)}" class="${m.user_id===target.user_id?'selected':''}">${escaped(m.display_name)}${m.user_id===me.user_id?' (나)':''}</button>`).join('')}</div>`
      + (roles ? `<div class="role-line"><span>🏃 운동 <b>${escaped(target.display_name)}</b></span><span>${activity.filmed?'🎥 촬영':'⏱ 시간·횟수'} <b>${escaped(roles.film.display_name)}</b></span><span>💬 피드백·기록 <b>${escaped(roles.feedback.display_name)}</b></span></div>` : '')
    : (membership ? '<div class="check-who-label">같은 모둠 친구가 참여하면 서로 기록해줄 수 있어요.</div>' : '');
  // Which analysed video the records read from (filmed activities only).
  const videos = activity.filmed ? recordVideos(activity, target.user_id) : [];
  const pickKey = `${target.user_id}:${activity.key}`;
  const video = videos.find(v=>v.id===chosenVideo.get(pickKey)) || videos[0];
  let source = $('#recordSource');
  if (!source) { source = document.createElement('div'); source.id = 'recordSource'; source.className = 'record-source'; $('.check-progress', card).after(source); }
  source.innerHTML = !activity.filmed
    ? '<p>⏱ 촬영 없이 친구가 시간과 횟수를 재서 기록해요. 2번 해서 더 좋은 기록을 적어요.</p>'
    : videos.length
      ? `<label>📹 기록할 영상 <select id="recordVideoSelect">${videos.map(v=>`<option value="${escaped(v.id)}" ${v.id===video?.id?'selected':''}>${escaped(v.display_name)} · ${new Date(v.created_at).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})}</option>`).join('')}</select></label>`
      : `<p>📹 ${escaped(activity.name)} 영상을 옆에서 찍어 올리면 분석값을 바로 가져올 수 있어요.</p>`;
  $('.check-head strong', card).textContent = activity.name;
  $('.check-head small', card).textContent = target.user_id === me.user_id ? '나의 움직임 기록지' : `${target.display_name}의 움직임 기록지`;
  const get = key => entryFor(target.user_id, activity.key, key)?.record?.value;
  $('.check-list', card).innerHTML = activity.items.map(([item,title,hint,rec])=>{
    const entry = entryFor(target.user_id,activity.key,item);
    const done = isDone(entry);
    const suggestion = rec.field ? video?.analysis?.[rec.field] ?? null : null;
    const value = entry?.record?.value;
    const goalHit = meetsGoal(value, rec.goal);
    const calc = value != null && rec.calc ? rec.calc(Number(value), get) : '';
    const meta = [rec.goal?.text ? `목표 ${rec.goal.text}` : '', entry?.record?.by ? `기록 ${entry.record.by}` : ''].filter(Boolean).join(' · ');
    return `<div class="record-item ${done?'checked':''}" data-check-key="${item}"><div class="record-head"><i></i><span><strong>${escaped(title)}</strong><small>${escaped(hint)}</small></span>${done?`<b class="record-value ${goalHit===true?'hit':''}">${escaped(formatRecord(value,rec))}${goalHit===true?' ✓':''}</b>`:''}</div><div class="record-body"><span class="record-label">기록: ${escaped(rec.label)}</span>${recordControl(rec, entry, suggestion, item)}${calc?`<small class="record-calc">${escaped(calc)}</small>`:''}${meta?`<small class="record-meta">${escaped(meta)}</small>`:''}</div></div>`;
  }).join('');
  const count = activity.items.filter(([item])=>isDone(entryFor(target.user_id,activity.key,item))).length;
  $('.check-count', card).textContent = `${count}/${activity.items.length}`;
  $('.check-progress span', card).style.width = `${count/activity.items.length*100}%`;
  let post = $('#postRecordBox');
  if (!post) {
    post = document.createElement('div'); post.id = 'postRecordBox'; post.className = 'post-record';
    post.innerHTML = '<input id="recordMemo" maxlength="200" placeholder="한 줄 소감 (선택)"/><button type="button" id="postRecord">📋 기록 게시판에 올리기</button>';
    $('.check-list', card).after(post);
  }
  $('#postRecord').disabled = !count;
  // Today's movement strip: selected activity + overall achievement.
  const done = ACTIVITIES.filter(a=>activityDone(a)).length;
  $('.session-copy strong').innerHTML = `${escaped(activity.name)} <span>${escaped(activity.en)}</span>`;
  $('.session-copy small').textContent = activity.desc;
  $('.progress-top span').textContent = '나의 활동 달성도';
  $('.progress-top strong').innerHTML = `${done} / ${ACTIVITIES.length} <small>활동</small>`;
  $('.progress-track span').style.width = `${done/ACTIVITIES.length*100}%`;
  $('.progress-labels').innerHTML = '<span>기록 4개를 모두 채우면 활동 완료</span>';
  if (typed) { const input = $(`.record-item[data-check-key="${typed.key}"] .record-row input`, card); if (input) { input.value = typed.value; input.focus(); } }
  paintTimer();
}
let recordColumn = true; // false until the teacher runs the record migration
async function loadChecklist() {
  if (!membership) return;
  let { data, error } = await supabase.from('activity_progress').select('user_id,activity_key,item_key,checked,record').eq('class_id',membership.class_id);
  if (error) { recordColumn = false; ({ data, error } = await supabase.from('activity_progress').select('user_id,activity_key,item_key,checked').eq('class_id',membership.class_id)); }
  if (error) return;
  progress.clear();
  for (const row of data||[]) progress.set(progressKey(row.user_id,row.activity_key,row.item_key), { checked: row.checked, record: row.record || null });
  renderActivities();
}
const SQL_NEEDED = '기록 저장은 선생님이 서버 설정(SQL)을 마친 뒤 사용할 수 있어요.';
async function saveRecord(itemKey, value, extra = {}) {
  const activity = activityByKey(currentActivity);
  if (!membership) { toast('먼저 내 이름을 선택해 수업에 참여해주세요.'); return; }
  const target = checkTarget || authUser.id, key = progressKey(target, activity.key, itemKey);
  const before = progress.get(key);
  const record = value == null ? null : { value, by: membership.display_name, at: new Date().toISOString(), ...extra };
  progress.set(key, { checked: value != null, record });
  renderActivities();
  if (!recordColumn) { progress.set(key, before); renderActivities(); toast(SQL_NEEDED); return; }
  const { error } = await supabase.from('activity_progress').upsert({ class_id:membership.class_id, user_id:target, activity_key:activity.key, item_key:itemKey, checked:value != null, record, updated_at:new Date().toISOString() }, { onConflict:'class_id,user_id,activity_key,item_key' });
  if (error) {
    progress.set(key, before); renderActivities();
    toast(/record/.test(error.message) || target !== authUser.id ? SQL_NEEDED : `기록을 저장하지 못했습니다: ${error.message}`);
  }
}

// ⏱ Countdown timer (fixed-time count) and stopwatch (fixed-count time) for the hop drills.
let timer = null; // {key, mode:'timer'|'stopwatch', phase, start, seconds, raf}
function beep(freq = 880, ms = 160) {
  try { const ctx = beep.ctx ||= new (window.AudioContext||window.webkitAudioContext)(); const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = freq; o.connect(g); g.connect(ctx.destination); g.gain.value = 0.15; o.start(); o.stop(ctx.currentTime + ms/1000); } catch {}
}
function paintTimer() {
  if (!timer) return;
  const button = $(`.timer-button[data-timer-key="${timer.key}"]`);
  if (!button) return;
  const elapsed = (performance.now() - timer.start) / 1000;
  button.classList.add('running');
  if (timer.mode === 'stopwatch') { button.textContent = `⏹ ${elapsed.toFixed(1)}초 · 눌러서 멈춤`; return; }
  if (timer.phase === 'ready') { button.textContent = `준비… ${Math.max(1, Math.ceil(3 - elapsed))}`; return; }
  button.textContent = `⏱ ${Math.max(0, timer.seconds - elapsed).toFixed(1)}초 남음`;
}
function stopTimer(message) {
  if (!timer) return;
  cancelAnimationFrame(timer.raf);
  const key = timer.key; timer = null;
  renderActivities();
  if (message) { toast(message); $(`.record-item[data-check-key="${key}"] .record-row input`)?.focus(); }
}
function tickTimer() {
  if (!timer) return;
  const elapsed = (performance.now() - timer.start) / 1000;
  if (timer.mode === 'timer' && timer.phase === 'ready' && elapsed >= 3) { timer.phase = 'go'; timer.start = performance.now(); beep(1200, 300); navigator.vibrate?.(200); }
  else if (timer.mode === 'timer' && timer.phase === 'go' && elapsed >= timer.seconds) { beep(600, 600); navigator.vibrate?.([300,100,300]); stopTimer('끝! 센 횟수를 입력하고 기록을 눌러주세요.'); return; }
  paintTimer();
  timer.raf = requestAnimationFrame(tickTimer);
}
function toggleTimer(button) {
  const key = button.dataset.timerKey;
  if (timer?.key === key) {
    if (timer.mode === 'stopwatch') {
      const seconds = Number(((performance.now() - timer.start) / 1000).toFixed(1));
      stopTimer(); const input = $(`.record-item[data-check-key="${key}"] .record-row input`);
      if (input) { input.value = seconds; input.focus(); }
      toast(`${seconds}초. 맞으면 기록을 눌러주세요.`);
    } else stopTimer('타이머를 멈췄어요.');
    return;
  }
  if (timer) stopTimer();
  timer = button.dataset.stopwatch != null
    ? { key, mode:'stopwatch', start: performance.now() }
    : { key, mode:'timer', phase:'ready', seconds:Number(button.dataset.timer), start: performance.now() };
  beep(timer.mode === 'stopwatch' ? 1200 : 880);
  tickTimer();
}

$('.check-card').addEventListener('click', event => {
  const member = event.target.closest('[data-check-target]');
  if (member) { checkTarget = member.dataset.checkTarget; renderActivities(); return; }
  const tab = event.target.closest('[data-activity]');
  if (tab) {
    if (timer) stopTimer();
    currentActivity = tab.dataset.activity;
    try { localStorage.setItem('bigjump.activity', currentActivity); } catch {}
    renderActivities(); renderBoard(); return;
  }
  if (event.target.closest('#postRecord')) { postRecord(); return; }
  const timerButton = event.target.closest('.timer-button');
  if (timerButton) { toggleTimer(timerButton); return; }
  const item = event.target.closest('.record-item');
  if (!item) return;
  const target = checkTarget || authUser?.id;
  const current = entryFor(target, currentActivity, item.dataset.checkKey)?.record?.value;
  const rate = event.target.closest('[data-rate]');
  if (rate) { saveRecord(item.dataset.checkKey, current === rate.dataset.rate ? null : rate.dataset.rate); return; }
  const fill = event.target.closest('[data-fill]');
  if (fill) {
    const video = $('#recordVideoSelect')?.value;
    saveRecord(item.dataset.checkKey, Number(fill.dataset.fill), { source:'video', video_id: video || null }); return;
  }
  if (event.target.closest('.save-record')) {
    const raw = $('.record-row input', item).value.trim();
    const value = raw === '' ? null : Number(raw);
    if (value != null && !(value >= 0)) { toast('0 이상의 숫자를 입력해주세요.'); return; }
    saveRecord(item.dataset.checkKey, value, { source:'peer' });
  }
});
$('.check-card').addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target.matches('.record-row input')) { event.preventDefault(); event.target.closest('.record-row').querySelector('.save-record').click(); }
  if (event.key === 'Enter' && event.target.id === 'recordMemo') { event.preventDefault(); postRecord(); }
});
$('.check-card').addEventListener('change', event => {
  if (event.target.id !== 'recordVideoSelect') return;
  chosenVideo.set(`${checkTarget || authUser.id}:${currentActivity}`, event.target.value);
  renderActivities();
});

// 📋 Record board: students post a snapshot of their record sheet for the class to see.
let boardRows = [], boardReady = true, boardFilter = 'all', boardChannel = null, boardTimer = null;
async function loadBoard() {
  if (!membership) return;
  const { data, error } = await supabase.from('record_posts').select('id,user_id,display_name,group_id,activity_key,items,memo,posted_by,posted_by_name,created_at').eq('class_id', membership.class_id).order('created_at', { ascending:false }).limit(150);
  boardReady = !error;
  boardRows = data || [];
  // Own channel, opened only once the table exists, so a missing table can't break the main realtime channel.
  if (boardReady && boardChannel?.topic !== `realtime:board-${membership.class_id}`) {
    if (boardChannel) supabase.removeChannel(boardChannel);
    boardChannel = supabase.channel(`board-${membership.class_id}`)
      .on('postgres_changes',{event:'*',schema:'public',table:'record_posts',filter:`class_id=eq.${membership.class_id}`},()=>{clearTimeout(boardTimer);boardTimer=setTimeout(loadBoard,400);})
      .subscribe();
  }
  renderBoard();
}
function renderBoard() {
  const host = $('#recordBoard');
  if (!host) return;
  const chips = [['all','전체'], ...ACTIVITIES.map(a=>[a.key,a.name])];
  const rows = boardRows.filter(r => boardFilter === 'all' || r.activity_key === boardFilter);
  const body = !membership ? '<div class="feed-placeholder">내 이름을 선택하면 기록 게시판이 열립니다.</div>'
    : !boardReady ? '<div class="feed-placeholder">기록 게시판은 선생님이 서버 설정(SQL)을 마치면 열려요.</div>'
    : !rows.length ? '<div class="feed-placeholder">아직 올라온 기록이 없어요. 오른쪽 기록지에서 ‘기록 게시판에 올리기’를 눌러보세요.</div>'
    : rows.map(r => {
      const activity = ACTIVITIES.find(a=>a.key===r.activity_key);
      const group = groups.find(g=>g.id===r.group_id);
      const mine = r.user_id === authUser?.id || r.posted_by === authUser?.id;
      const items = (r.items||[]).map(i=>`<li><span>${escaped(i.title)}</span><b>${escaped(i.text||'—')}</b>${i.calc?`<small>${escaped(i.calc)}</small>`:''}</li>`).join('');
      return `<article class="record-post"><header><div class="person-avatar avatar-blue">${escaped(r.display_name.slice(0,1))}</div><div><strong>${escaped(r.display_name)} <span class="group-badge">${escaped(group?.name||'미배정')}</span></strong><small>${activity?`${activity.filmed?'📹':'⏱'} ${escaped(activity.name)}`:''} · ${new Date(r.created_at).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}${r.posted_by_name&&r.posted_by_name!==r.display_name?` · 기록 ${escaped(r.posted_by_name)}`:''}</small></div>${mine?`<button class="more-button" data-delete-post="${escaped(r.id)}" aria-label="기록 삭제">✕</button>`:''}</header><ul>${items}</ul>${r.memo?`<p class="record-memo">“${escaped(r.memo)}”</p>`:''}</article>`;
    }).join('');
  host.innerHTML = `<div class="board-chips">${chips.map(([k,label])=>`<button type="button" data-board-filter="${k}" class="${boardFilter===k?'selected':''}">${escaped(label)}</button>`).join('')}</div><div class="record-posts">${body}</div>`;
}
async function postRecord() {
  if (!membership) { toast('먼저 내 이름을 선택해 수업에 참여해주세요.'); return; }
  const activity = activityByKey(currentActivity);
  const me = { user_id: authUser.id, display_name: membership.display_name, group_id: membership.group_id };
  const target = groupMembers.find(m=>m.user_id===checkTarget) || me;
  const get = key => entryFor(target.user_id, activity.key, key)?.record?.value;
  const items = activity.items.map(([key,title,,rec]) => {
    const value = get(key);
    return { key, title, label: rec.label, value: value ?? null, text: formatRecord(value, rec), calc: value != null && rec.calc ? rec.calc(Number(value), get) : '' };
  });
  if (!items.some(i=>i.value != null)) { toast('기록을 하나 이상 채운 뒤 올려주세요.'); return; }
  const button = $('#postRecord'); button.disabled = true;
  const { error } = await supabase.from('record_posts').insert({ class_id: membership.class_id, user_id: target.user_id, display_name: target.display_name, group_id: target.group_id ?? membership.group_id, activity_key: activity.key, items, memo: $('#recordMemo').value.trim(), posted_by: authUser.id, posted_by_name: membership.display_name });
  button.disabled = false;
  if (error) { toast(/record_posts|relation|schema cache/.test(error.message) ? '기록 게시판은 선생님이 서버 설정(SQL)을 마치면 열려요.' : `게시하지 못했습니다: ${error.message}`); return; }
  $('#recordMemo').value = '';
  toast('기록 게시판에 올렸어요.');
  boardFilter = activity.key; showBoard('records'); loadBoard();
}
function showBoard(name) {
  $$('[data-board]').forEach(b=>b.classList.toggle('selected', b.dataset.board===name));
  $('#feedGrid').classList.toggle('hidden-by-filter', name !== 'wall');
  $('#recordBoard').classList.toggle('hidden-by-filter', name !== 'records');
  $('.section-head .head-actions').classList.toggle('records-mode', name === 'records');
  $('.section-head h2').textContent = name === 'records' ? '기록 게시판' : '우리의 움직임';
  $('.section-head p').textContent = name === 'records' ? '활동 기록지를 올리고 친구들의 기록을 함께 봐요.' : '서로의 동작을 보고, 발견한 점을 나눠보세요.';
  if (name === 'records') renderBoard();
}
$$('[data-board]').forEach(b=>b.addEventListener('click',()=>showBoard(b.dataset.board)));
$('#recordBoard').addEventListener('click', async event => {
  const chip = event.target.closest('[data-board-filter]');
  if (chip) { boardFilter = chip.dataset.boardFilter; renderBoard(); return; }
  const del = event.target.closest('[data-delete-post]');
  if (del && confirm('이 기록 게시물을 삭제할까요?')) {
    const { error } = await supabase.from('record_posts').delete().eq('id', del.dataset.deletePost);
    if (error) toast(error.message); else { boardRows = boardRows.filter(r=>r.id!==del.dataset.deletePost); renderBoard(); }
  }
});
$('#exerciseInput').innerHTML = FILMED.map(a=>`<option value="${escaped(a.name)}">${escaped(a.name)}</option>`).join('');
renderActivities();

function openUpload() {
  if(!membership){joinDialog.showModal();listRoster();return;}
  const groupSelect=$('#uploadGroupInput');
  groupSelect.innerHTML=groups.map(group=>`<option value="${escaped(group.id)}">${escaped(group.name)}</option>`).join('')+'<option value="">모둠 없음</option>';
  groupSelect.value=membership.group_id||'';
  $('#exerciseInput').value=(activityByKey(currentActivity).filmed?activityByKey(currentActivity):FILMED[0]).name;
  // Height and weight stay on this phone only, so students don't retype them every time.
  try{$('#weightInput').value=localStorage.getItem('bigjump.mass')||'';$('#heightInput').value=localStorage.getItem('bigjump.height')||'';}catch{}
  selectedFile=null;$('#galleryInput').value='';$('#cameraInput').value='';$('#fileLabel').textContent='영상을 선택하거나 바로 촬영해주세요';$('#submitUpload').disabled=true;
  uploadDialog.showModal();
}
$('#uploadButton').addEventListener('click',openUpload);
$('#addCard').addEventListener('click',openUpload);
$('#closeUpload').addEventListener('click',()=>uploadDialog.close());
$('#cancelUpload').addEventListener('click',()=>uploadDialog.close());
// Some Android galleries hand over files with an empty MIME type, so also accept by extension.
function isVideoFile(file) { return file.type.startsWith('video/') || (!file.type && /\.(mp4|mov|m4v|3gp|webm)$/i.test(file.name)); }
function chooseVideo(file) {
  if(!file)return;
  if(!isVideoFile(file)){toast('영상 파일을 선택해주세요.');return;}
  if(file.size>100*1024*1024){toast('영상은 100MB 이하로 올려주세요. 짧게 잘라서 올려주세요.');return;}
  selectedFile=file;$('#fileLabel').textContent=`✓ ${file.name} · ${fileSize(file.size)}`;$('#submitUpload').disabled=false;
}
for(const id of ['galleryInput','cameraInput'])$(`#${id}`).addEventListener('change',event=>chooseVideo(event.target.files[0]));
$$('.pick-button').forEach(label=>label.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();$(`#${label.htmlFor}`).click();}}));
for(const eventName of ['dragenter','dragover'])$('#dropZone').addEventListener(eventName,event=>{event.preventDefault();$('#dropZone').classList.add('dragover');});
for(const eventName of ['dragleave','drop'])$('#dropZone').addEventListener(eventName,event=>{event.preventDefault();$('#dropZone').classList.remove('dragover');});
$('#dropZone').addEventListener('drop',event=>{
  chooseVideo(event.dataTransfer.files[0]);
});

function resetAnalysis() {
  localVideo.pause();clearInterval(analysisWorker);analysisWorker=null;
  localVideo.onloadedmetadata=null;localVideo.ontimeupdate=null;localVideo.onplay=null;localVideo.onpause=null;
  currentAnalysis=null;currentSamples=[];selectedVideo=null;renderComments();
  drawPose(poseCanvas,localVideo,null,false);
  $('#analysisProgress').classList.add('hidden-by-filter');
  $('#analysisIdle').classList.remove('hidden-by-filter');
}
function setMetric(id,value,unit,digits=1) {
  $(`#${id}`).innerHTML=value===null||value===undefined||!Number.isFinite(Number(value))?`— <small>${unit}</small>`:`${Number(value).toLocaleString('ko-KR',{maximumFractionDigits:digits,minimumFractionDigits:digits&&unit!=='W'?digits:0})} <small>${unit}</small>`;
}
// Student CMJ heights above ~75 cm (or power above ~5000 W) mean the take-off/landing detection went wrong.
const MAX_PLAUSIBLE_JUMP_CM=75, MAX_PLAUSIBLE_POWER_W=5000;
const jumpLooksWrong=analysis=>Number(analysis?.jump_height_cm)>MAX_PLAUSIBLE_JUMP_CM;
function plausiblePower(analysis){
  const power=Number(analysis?.peak_power_w);
  return analysis?.peak_power_w!=null&&power>0&&power<=MAX_PLAUSIBLE_POWER_W&&!jumpLooksWrong(analysis)?power:null;
}
function renderAnalysisMetrics(analysis,{mass,height}={}) {
  if(!analysis)return;
  setMetric('metricJumpHeight',analysis.jump_height_cm,'cm',1);
  setMetric('metricFlightTime',analysis.flight_time_s,'초',2);
  const power=plausiblePower(analysis);
  setMetric('metricPower',power,'W',0);
  $('#metricHeightMethod').textContent=jumpLooksWrong(analysis)?'비정상적으로 높아요 · 다시 촬영 권장':(Number(height)>0?'체공 시간 기반 · 신장 비교':'체공 시간 기반 추정');
  $('#metricPowerMethod').textContent=power?'참고 추정치 · 오차 큼'
    :jumpLooksWrong(analysis)?'점프 측정이 비정상이라 생략'
    :analysis.power_note?.includes('점프 앤 스틱')?'점프 앤 스틱에서만 추정'
    :'체중을 입력하면 추정';
  const deg=(id,v)=>{$(`#${id}`).innerHTML=v==null?'— <small>°/s</small>':`${Math.round(v)} <small>°/s</small>`;};
  deg('metricAnkleVelocity',analysis.ankle_extension_angular_velocity_deg_s);
  deg('metricKneeVelocity',analysis.knee_extension_angular_velocity_deg_s);
  deg('metricHipVelocity',analysis.hip_extension_angular_velocity_deg_s);
  const wrong=jumpLooksWrong(analysis);
  setMetric('metricLandingSpeed',wrong?null:analysis.landing_speed_m_s,'m/s',2);
  setMetric('metricImpulse',wrong?null:analysis.landing_impulse_ns,'N·s',0);
  $('#metricImpulseNote').textContent=analysis.landing_impulse_ns!=null?'체중 × 착지 속도':'체중을 입력하면 계산';
  setMetric('metricLandingForce',wrong?null:analysis.landing_force_bw,'×체중',1);
  $('#metricAbsorbTime').textContent=analysis.landing_absorb_time_s!=null?`흡수 시간 ${analysis.landing_absorb_time_s}초`:'흡수 시간 —';
  setMetric('metricTrunkSway',analysis.trunk_sway_deg,'°',1);
  setMetric('metricHipSway',analysis.hip_sway_cm,'cm',1);
  $('#metricHipSwayNote').textContent=analysis.stature_assumed?'키 160cm 가정':'착지 후 1초';
  setMetric('metricHold',analysis.stick_hold_s,'초',1);
  const score=analysis.balance_score;
  $('#metricBalance').textContent=score==null?'측정 불가':`${score}점`;
  $('#balanceBar').style.width=score==null?'0%':`${Math.max(4,score)}%`;
  $('#analysisQuality').textContent='포즈 감지 · 참고값';
  $('#analysisDisclaimer').textContent='착지 균형 점수 = 100 − 몸통 흔들림×1.5 − 엉덩이 흔들림(cm)×2.5 − 2초 미만 정지 감점. 평균 착지 힘 = 1 + 착지 속도 ÷ (중력가속도 × 흡수 시간). 점프 높이는 체공 시간으로 추정하며 도약·착지 높이가 같다고 가정합니다. 추정 파워는 Sayers 식(51.9×점프높이cm + 48.9×체중kg − 2007)으로 계산한 참고값으로, 힘판 측정이 아니며 오차가 수백 W에 이를 수 있습니다.';
}
async function waitMetadata(video) {
  if(video.readyState>=1)return;
  await new Promise((resolve,reject)=>{
    video.addEventListener('loadedmetadata',resolve,{once:true});
    video.addEventListener('error',()=>reject(new Error('이 영상 형식을 브라우저가 읽지 못합니다.')),{once:true});
  });
}
async function runPoseAnalysis(video,{mass,height,exercise}={}) {
  $('#analysisProgress').classList.remove('hidden-by-filter');$('#analysisIdle').classList.add('hidden-by-filter');
  $('#analysisQuality').textContent='AI 모델 불러오는 중';
  $('#analysisProgress b').textContent='기기에서 포즈 모델을 불러오는 중…';
  currentSamples=[];
  try {
    const analysis=await analyzeJump(video,{
      bodyMassKg:mass,heightCm:height,exercise,
      onProgress:value=>{const percent=Math.round(value*100);$('#analysisProgress b').textContent=`프레임 분석 중 · ${percent}%`;$('#analysisProgress span').style.width=`${percent}%`;},
      onFrame:frame=>{currentSamples.push(frame);drawPose(poseCanvas,video,frame.landmarks,showSkeleton);},
    });
    currentAnalysis=analysis;renderAnalysisMetrics(analysis,{mass,height});
    $('#analysisProgress').classList.add('hidden-by-filter');
    localVideo.currentTime=analysis.takeoff_s;
    return analysis;
  } catch(error) {
    $('#analysisProgress').classList.add('hidden-by-filter');
    $('#analysisIdle').classList.remove('hidden-by-filter');
    $('#analysisIdle small').textContent=error.message;
    $('#analysisQuality').textContent='분석 필요';
    throw error;
  }
}
function nearestPose(time) {
  if(!currentSamples.length)return null;
  let best=currentSamples[0];
  for(const sample of currentSamples){if(Math.abs(sample.time-time)<Math.abs(best.time-time))best=sample;}
  return best;
}
function connectVideoControls(video) {
  video.onloadedmetadata=()=>{
    $('#scrubber').value='0';$('#timecode').textContent=`${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
    drawPose(poseCanvas,video,null,false);
  };
  video.ontimeupdate=()=>{
    $('#timecode').textContent=`${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
    $('#scrubber').value=video.duration?String(video.currentTime/video.duration*100):'0';
    const pose=nearestPose(video.currentTime);
    if(pose)drawPose(poseCanvas,video,pose.landmarks,showSkeleton);
  };
  video.onplay=()=>{$('#playToggle').textContent='Ⅱ';$('#playSmall').textContent='Ⅱ';};
  video.onpause=()=>{$('#playToggle').textContent='▶';$('#playSmall').textContent='▶';};
  video.playbackRate=playbackSpeed;
}

$('#submitUpload').addEventListener('click',async()=>{
  if(!selectedFile||!membership)return;
  const file=selectedFile;selectedFile=null;uploadDialog.close();resetAnalysis();
  const objectUrl=URL.createObjectURL(file);
  localVideo.src=objectUrl;localVideo.classList.remove('hidden-by-filter');connectVideoControls(localVideo);
  $('#analysisName').textContent=membership.display_name;
  analysisDialog.showModal();
  $('#analysisQuality').textContent='측정 준비 중';
  try {
    await waitMetadata(localVideo);
    if(localVideo.duration>30)throw new Error('분석은 30초 이하 영상에서 지원합니다. 짧은 클립으로 잘라 다시 올려주세요.');
    const mass=Number($('#weightInput').value)||null;
    const height=Number($('#heightInput').value)||null;
    try{if(mass)localStorage.setItem('bigjump.mass',String(mass));if(height)localStorage.setItem('bigjump.height',String(height));}catch{}
    const exercise=$('#exerciseInput').value;
    const chosenGroup=$('#uploadGroupInput').value||null;
    const analysis=await runPoseAnalysis(localVideo,{mass,height,exercise});
    $('#analysisQuality').textContent='저장·공유 중';
    const ext=(file.name.split('.').pop()||'mp4').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,6)||'mp4';
    const path=`${membership.class_id}/${authUser.id}/${crypto.randomUUID()}.${ext}`;
    const {error:uploadError}=await supabase.storage.from(videoBucket).upload(path,file,{contentType:file.type||'video/mp4',upsert:false,cacheControl:'3600'});
    if(uploadError)throw uploadError;
    const record={...analysis};delete record.samples;
    const videoRow={
      class_id:membership.class_id,group_id:chosenGroup,user_id:authUser.id,display_name:membership.display_name,
      exercise,duration_seconds:Number(localVideo.duration.toFixed(3)),body_mass_kg:mass,height_cm:height,
      note:$('#noteInput').value.trim(),storage_path:path,analysis:record,
    };
    let {data,error}=await supabase.from('videos').insert(videoRow).select('id').single();
    // Until the group-tag SQL is applied, the database only accepts the student's own group.
    if(error&&chosenGroup!==membership.group_id&&/row-level security/i.test(error.message)){
      ({data,error}=await supabase.from('videos').insert({...videoRow,group_id:membership.group_id}).select('id').single());
      if(!error)toast('선택한 모둠으로 저장하지 못해 내 모둠으로 올렸어요.');
    }
    if(error){await supabase.storage.from(videoBucket).remove([path]);throw error;}
    selectedVideo={id:data.id,display_name:membership.display_name,exercise,analysis:record,storage_path:path,user_id:authUser.id,body_mass_kg:mass,height_cm:height,feedback:[]};
    renderComments();
    toast('분석을 마치고 수업 담벼락에 공유했습니다.');
    await loadFeed();
    $('#analysisQuality').textContent='저장 완료 · 참고값';
    URL.revokeObjectURL(objectUrl);
  } catch(error) {
    toast(error.message||'분석 또는 업로드에 실패했습니다.');
    $('#analysisQuality').textContent='완료하지 못함';
  }
});

async function openSavedVideo(id) {
  const row=videoRows.find(item=>item.id===id);if(!row)return;
  resetAnalysis();selectedVideo=row;currentAnalysis=row.analysis||null;renderComments();
  $('#analysisName').textContent=row.display_name;renderAnalysisMetrics(currentAnalysis,{mass:row.body_mass_kg,height:row.height_cm});
  localVideo.src=row.signedUrl;localVideo.classList.remove('hidden-by-filter');connectVideoControls(localVideo);analysisDialog.showModal();
  try {
    await waitMetadata(localVideo);
    await runPoseAnalysis(localVideo,{mass:row.body_mass_kg,height:row.height_cm,exercise:row.exercise});
  } catch(error) { $('#analysisIdle').classList.remove('hidden-by-filter');$('#analysisIdle small').textContent=error.message; }
}

$('#playToggle').addEventListener('click',()=>localVideo.paused?localVideo.play():localVideo.pause());
$('#playSmall').addEventListener('click',()=>localVideo.paused?localVideo.play():localVideo.pause());
$('#scrubber').addEventListener('input',event=>{if(Number.isFinite(localVideo.duration))localVideo.currentTime=localVideo.duration*Number(event.target.value)/100;});
$('#speedButton').addEventListener('click',()=>{
  playbackSpeed=playbackSpeed===0.5?0.25:playbackSpeed===0.25?1:0.5;
  localVideo.playbackRate=playbackSpeed;$('#speedButton').textContent=`${playbackSpeed}×`;
});
$('#fullscreenButton').addEventListener('click',()=>{
  const target=$('.analysis-video-wrap');
  if(document.fullscreenElement)document.exitFullscreen?.();else target.requestFullscreen?.();
});
$('#skeletonToggle').addEventListener('click',event=>{
  showSkeleton=!showSkeleton;event.currentTarget.classList.toggle('active',showSkeleton);
  const pose=nearestPose(localVideo.currentTime);if(pose)drawPose(poseCanvas,localVideo,pose.landmarks,showSkeleton);
});
$('#closeDialog').addEventListener('click',()=>analysisDialog.close());
analysisDialog.addEventListener('close',()=>{
  localVideo.pause();
  if(localVideo.src.startsWith('blob:'))URL.revokeObjectURL(localVideo.src);
  localVideo.removeAttribute('src');localVideo.load();
  currentSamples=[];currentAnalysis=null;selectedVideo=null;
  $('#analysisIdle').classList.remove('hidden-by-filter');
  drawPose(poseCanvas,localVideo,null,false);
});

let commentKind = 'observation';
function renderComments() {
  const row = selectedVideo && (videoRows.find(item=>item.id===selectedVideo.id) || selectedVideo);
  $('#commentThread').classList.toggle('hidden-by-filter', !row?.id);
  if (!row?.id) return;
  const list = [...(row.feedback||[])].sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
  const label = {strength:'👏 잘한 점',next_try:'💡 다음 시도',balance:'⚖️ 균형 관찰',observation:'💬'};
  $('#commentCount').textContent = `${list.length}개`;
  $('#commentList').innerHTML = list.length
    ? list.map(c=>`<div class="comment"><div class="mini-avatar">${escaped(c.display_name.slice(0,1))}</div><div><strong>${escaped(c.display_name)}</strong> <em>${label[c.kind]||''}</em><p>${escaped(c.content)}</p></div></div>`).join('')
    : '<p class="comment-empty">아직 피드백이 없어요.</p>';
  const mine = row.user_id === authUser?.id;
  $('#commentCompose').classList.toggle('hidden-by-filter', mine || !membership);
  $('#commentOwnNote').classList.toggle('hidden-by-filter', !mine);
}
$$('#commentCompose [data-kind]').forEach(button=>button.addEventListener('click',()=>{
  commentKind = button.dataset.kind;
  $$('#commentCompose [data-kind]').forEach(item=>item.classList.toggle('selected', item===button));
  $('#commentInput').focus();
}));
$('#sendComment').addEventListener('click',async()=>{
  const content=$('#commentInput').value.trim();
  if(!content||!selectedVideo?.id||!membership)return;
  const button=$('#sendComment');button.disabled=true;
  const {data,error}=await supabase.from('feedback').insert({video_id:selectedVideo.id,user_id:authUser.id,display_name:membership.display_name,kind:commentKind,content}).select('id,display_name,kind,content,created_at').single();
  button.disabled=false;
  if(error){toast(`피드백 저장 실패: ${error.message}`);return;}
  const row=videoRows.find(item=>item.id===selectedVideo.id);
  if(row){row.feedback=[...(row.feedback||[]),data];}
  $('#commentInput').value='';commentKind='observation';
  $$('#commentCompose [data-kind]').forEach(item=>item.classList.remove('selected'));
  renderComments();renderFeed();toast('피드백을 남겼어요.');
});

$('#downloadButton').addEventListener('click',()=>{
  const result=currentAnalysis||selectedVideo?.analysis;if(!result){toast('저장된 분석 결과가 없습니다.');return;}
  const cleanResult={...result};delete cleanResult.samples;
  const blob=new Blob([JSON.stringify({student:membership?.display_name,exercise:selectedVideo?.exercise,analysis:cleanResult},null,2)],{type:'application/json'});
  const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='big-jump-analysis.json';link.click();URL.revokeObjectURL(link.href);
});

async function deleteVideo(id) {
  const row=videoRows.find(item=>item.id===id);
  if(!row||row.user_id!==authUser.id){toast('본인이 올린 영상만 삭제할 수 있습니다.');return;}
  if(!confirm('이 영상과 분석 기록을 삭제할까요?'))return;
  const {error}=await supabase.from('videos').delete().eq('id',id);
  if(error){toast(error.message);return;}
  await supabase.storage.from(videoBucket).remove([row.storage_path]);
  toast('영상을 삭제했습니다.');await loadFeed();
}

$('#filterButton').addEventListener('click',()=>{
  const ids=['',...groups.map(group=>group.id)];
  applyGroupFilter(ids[(ids.indexOf($('#filterButton').dataset.group||'')+1)%ids.length]);
});
$$('.view-toggle button').forEach((button,index)=>button.addEventListener('click',()=>{
  $$('.view-toggle button').forEach(item=>item.classList.remove('selected'));button.classList.add('selected');$('#feedGrid').classList.toggle('list-view',index===1);
}));
$$('.nav-item').forEach(button=>button.addEventListener('click',()=>{
  $$('.nav-item').forEach(item=>item.classList.toggle('active',item===button));
  if(button.dataset.view==='analysis')openUpload();
  else if(button.dataset.view==='missions')document.querySelector('.right-rail')?.scrollIntoView({behavior:'smooth',block:'center'});
}));
$('.worksheet-button').addEventListener('click',()=>document.querySelector('.check-card')?.scrollIntoView({behavior:'smooth',block:'center'}));

function teacherHeaders() { return { 'x-teacher-code': $('#teacherPin').value.trim() }; }
function teacherTab(name) {
  $$('.teacher-tabs button').forEach(button=>button.classList.toggle('selected',button.dataset.teacherTab===name));
  $$('.teacher-panel').forEach(panel=>panel.classList.toggle('active',panel.id===(name==='class'?'teacherClassPanel':'teacherRosterPanel')));
}
$('#teacherModeButton').addEventListener('click',()=>{
  $('#teacherClassCode').textContent=classInfo?.join_code||localStorage.getItem('bigjump.teacherClassCode')||'—';
  teacherDialog.showModal();
});
$('#closeTeacher').addEventListener('click',()=>teacherDialog.close());
$$('.teacher-tabs button').forEach(button=>button.addEventListener('click',()=>teacherTab(button.dataset.teacherTab)));
async function teacherRequest(body) {
  if(!/^\d{4}$/.test($('#teacherPin').value.trim())) throw new Error('교사 PIN은 숫자 4자리입니다.');
  return invoke('teacher-admin',body,teacherHeaders());
}
$('#createClassButton').addEventListener('click',async()=>{
  showTeacherError('');
  const name=$('#classNameInput').value.trim();
  const groups=$('#groupNamesInput').value.split(',').map(value=>value.trim()).filter(Boolean);
  const students=$('#rosterNamesInput').value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
  try {
    const data=await teacherRequest({action:'create-class',name,groups,students});
    $('#generatedCode').innerHTML=`학생은 사이트에서 이름만 고르면 이 수업에 참여해요. 수업 코드 <strong>${escaped(data.classroom.join_code)}</strong><button id="copyJoinCode" class="outline-button">복사</button>`;
    $('#teacherClassCode').textContent=data.classroom.join_code;localStorage.setItem('bigjump.teacherClassCode',data.classroom.join_code);
    $('#joinCode').value=data.classroom.join_code;
    $('#copyJoinCode').addEventListener('click',()=>navigator.clipboard.writeText(data.classroom.join_code).then(()=>toast('코드를 복사했어요.')));
    const {data:member,error}=await supabase.from('class_members').select('class_id,user_id,roster_id,display_name,group_id,role').eq('user_id',authUser.id).eq('class_id',data.classroom.id).single();
    if(error)throw error;
    await loadClassroom(member);teacherDialog.close();toast('수업, 모둠, 학생 명단을 만들었습니다.');
  } catch(error){showTeacherError(error.message);}
});
let rosterState = []; // [{name, group, joined}]
const editorGroups = () => $('#editGroupNamesInput').value.split(',').map(value=>value.trim()).filter(Boolean);
function renderRosterEditor() {
  const names = editorGroups();
  $('#rosterEditor').innerHTML = rosterState.length ? rosterState.map((row,index)=>`<div class="roster-row"><span>${escaped(row.name)} <small class="${row.joined?'joined':''}">${row.joined?'참여 중':'미참여'}</small></span><select data-roster-index="${index}">${['',...names].map(name=>`<option value="${escaped(name)}" ${name===row.group?'selected':''}>${name?escaped(name):'모둠 없음'}</option>`).join('')}</select></div>`).join('')
    : '<p class="roster-empty">아직 학생이 없어요. 아래에 추가해주세요.</p>';
}
$('#rosterEditor').addEventListener('change',event=>{const select=event.target.closest('[data-roster-index]');if(select)rosterState[Number(select.dataset.rosterIndex)].group=select.value;});
$('#editGroupNamesInput').addEventListener('input',renderRosterEditor);
async function teacherLoadClass() {
  showTeacherError('');
  let code=($('#teacherClassCode').textContent==='—'?$('#joinCode').value:$('#teacherClassCode').textContent).trim().toUpperCase();
  if(!code){try{code=(await invoke('join-class',{action:'list-roster'})).class_code;}catch{}}
  if(!code){showTeacherError('수업이 없습니다. 먼저 ‘수업 만들기’에서 수업을 만들어주세요.');return;}
  try {
    const data=await teacherRequest({action:'load-class',class_code:code});
    $('#teacherClassCode').textContent=data.classroom.join_code;$('#editGroupNamesInput').value=data.groups.map(group=>group.name).join(', ');
    rosterState=data.roster.map(row=>({name:row.student_name,group:row.groups?.name||'',joined:Boolean(row.auth_user_id)}));
    renderRosterEditor();teacherTab('roster');
    toast(`${data.roster.length}명의 학생 명단을 불러왔어요.`);
  } catch(error){showTeacherError(error.message);}
}
$('#teacherLoad').addEventListener('click',teacherLoadClass);
$('#teacherPin').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();teacherLoadClass();}});
$('#saveRosterButton').addEventListener('click',async()=>{
  showTeacherError('');
  const code=$('#teacherClassCode').textContent.trim();
  if(code==='—'){showTeacherError('먼저 ‘수업 불러오기’를 눌러주세요.');return;}
  const groups=editorGroups();
  const added=$('#newStudentsInput').value.split(/\r?\n/).map(line=>{
    const [name,...rest]=line.split(',');return {name:name.trim(),group:rest.join(',').trim()};
  }).filter(row=>row.name&&!rosterState.some(item=>item.name===row.name));
  const students=[...rosterState.map(row=>({name:row.name,group:row.group})),...added];
  try {
    const data=await teacherRequest({action:'save-roster',class_code:code,groups,students});
    $('#newStudentsInput').value='';
    toast(`${data.student_count}명의 모둠 배정을 저장했어요.`);
    await teacherLoadClass();
    if(membership)await loadClassroom(membership);
  } catch(error){showTeacherError(error.message);}
});
teacherDialog.addEventListener('close',()=>$('#teacherPin').value='');

for(const dialog of [analysisDialog,uploadDialog,joinDialog,teacherDialog])dialog.addEventListener('click',event=>{
  if(event.target!==dialog||!event.isTrusted)return;
  const rect=dialog.getBoundingClientRect();
  if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();
});

startApp();
