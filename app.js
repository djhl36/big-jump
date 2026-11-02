import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { analyzeJump, drawPose } from './pose-analysis.js?v=dd86b523ec';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const config = window.BIGJUMP_CONFIG || {};
const hasConfig = Boolean(config.supabaseUrl && config.supabaseKey);
const supabase = hasConfig ? createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
}) : null;
const videoBucket = config.videoBucket || 'class-videos';
const analysisDialog = $('#analysisDialog');
const feedbackDialog = $('#feedbackDialog');
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
let activeFeedbackVideo = null;
let feedbackKind = 'observation';
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
  await Promise.all([loadFeed(), loadChecklist()]);
  subscribeToClass();
}

function subscribeToClass() {
  if(realtimeChannel)supabase.removeChannel(realtimeChannel);
  realtimeChannel=supabase.channel(`big-jump-${membership.class_id}`)
    .on('postgres_changes',{event:'*',schema:'public',table:'videos',filter:`class_id=eq.${membership.class_id}`},scheduleFeedRefresh)
    .on('postgres_changes',{event:'*',schema:'public',table:'feedback'},scheduleFeedRefresh)
    .on('postgres_changes',{event:'*',schema:'public',table:'groups',filter:`class_id=eq.${membership.class_id}`},async()=>{
      const {data}=await supabase.from('groups').select('id,name,sort_order').eq('class_id',membership.class_id).order('sort_order');
      if(data){groups=data;renderGroups();renderFeed();}
    })
    .on('postgres_changes',{event:'*',schema:'public',table:'class_members',filter:`class_id=eq.${membership.class_id}`},scheduleFeedRefresh)
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
    card.innerHTML = `<div class="video-thumb uploaded-thumb ${complete?'video-a':'video-b'}">${thumb}<button class="video-center-play" data-open-video="${escaped(row.id)}" aria-label="분석 보기">▶</button><span class="video-duration">${formatTime(row.duration_seconds)}</span><span class="video-tag ${complete?'':'pending-tag'}">${complete?'동작 분석 완료':'분석 대기'}</span></div><div class="post-body"><div class="post-author"><div class="person-avatar avatar-blue">${escaped(row.display_name.slice(0,1))}</div><div><strong>${escaped(row.display_name)} <span class="group-badge">${escaped(group?.name || '미배정')}</span></strong><small>${new Date(row.created_at).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})} · ${escaped(row.exercise)}</small></div><button class="more-button" data-delete-video="${escaped(row.id)}" aria-label="내 영상 삭제">···</button></div>${row.note?`<div class="peer-note"><span>✎</span> 나의 관찰 메모<p>${escaped(row.note)}</p></div>`:''}<div class="metric-row">${metricMarkup('점프 높이',results.jump_height_cm,'cm')}${metricMarkup('체공 시간',results.flight_time_s,'초')}${metricMarkup('추정 파워',results.peak_power_w,'W')}</div><div class="post-foot"><button class="comment-count" data-comments="${escaped(row.id)}">▱ <span>피드백 ${feedback.length}</span></button><div class="reaction-list"></div><button class="analyze-link" data-open-video="${escaped(row.id)}">분석 보기 <span>↗</span></button></div>${latest?`<div class="inline-comment"><div class="mini-avatar">${escaped(latest.display_name.slice(0,1))}</div><span>${escaped(latest.content)}</span></div>`:''}</div>`;
    feed.append(card);
  }
  const add=document.createElement('button');add.className='add-card';add.id='addCard';add.innerHTML='<span class="add-ring">＋</span><strong>내 동작 영상 올리기</strong><span>영상을 올리고 친구들과 관찰 내용을 나눠요.</span><small>MP4 · MOV · 최대 100MB</small>';add.addEventListener('click',openUpload);feed.append(add);
  $$('[data-open-video]',feed).forEach(button=>button.addEventListener('click',()=>openSavedVideo(button.dataset.openVideo)));
  $$('[data-comments]',feed).forEach(button=>button.addEventListener('click',()=>openFeedback(videoRows.find(row=>row.id===button.dataset.comments))));
  $$('[data-delete-video]',feed).forEach(button=>button.addEventListener('click',()=>deleteVideo(button.dataset.deleteVideo)));
  applyGroupFilter($('#filterButton').dataset.group||'');
}
function applyGroupFilter(groupId) {
  $('#filterButton').dataset.group = groupId;
  const group = groups.find(g=>g.id===groupId);
  $('#filterButton').innerHTML = `${group?escaped(group.name):'모든 모둠'} <span>⌄</span>`;
  $$('.post-card, .group-section-title').forEach(el=>el.classList.toggle('hidden-by-filter',Boolean(groupId)&&el.dataset.group!==groupId));
  $$('.sidebar .group-link').forEach(link=>link.classList.toggle('active',link.dataset.group===groupId));
}

const ACTIVITIES = [
  { key:'pogo-jump', name:'포고 점프', en:'Pogo Jump', desc:'발목 반동으로 짧고 빠르게 튀어 올라요.', items:[
    ['ankle_spring','발목 탄성','무릎은 살짝만 굽히고 발목 반동으로 튀어 오르기'],
    ['short_contact','짧은 접지','발이 닿자마자 바로 다시 뛰어오르기'],
    ['forefoot_landing','앞꿈치 착지','뒤꿈치가 바닥에 닿지 않게 하기'],
    ['tall_posture','곧은 몸통','시선은 앞, 몸통이 앞뒤로 흔들리지 않기']]},
  { key:'jump-stick', name:'점프 앤 스틱', en:'Jump & Stick', desc:'폭발적으로 도약한 뒤 균형 있게 착지해요.', items:[
    ['explosive_takeoff','폭발적인 도약','팔 스윙과 하체 신전을 연결하기'],
    ['shock_absorption','부드러운 착지','발목·무릎·고관절을 함께 굽혀 충격 흡수하기'],
    ['knee_alignment','무릎 정렬','착지할 때 무릎이 안쪽으로 모이지 않기'],
    ['posture_control','2초 정지','추가 스텝 없이 2초 동안 균형 유지하기']]},
  { key:'broad-jump-series', name:'브로드 점프 연속동작', en:'Broad Jump Series', desc:'앞으로 멀리 뛰고 리듬 있게 이어가요.', items:[
    ['arm_swing','팔 스윙','팔을 뒤에서 앞으로 크게 휘두르며 도약하기'],
    ['full_extension','전신 신전','발목·무릎·고관절을 쭉 펴서 앞쪽 위로 뛰기'],
    ['stable_landing','안정된 착지','엉덩이를 뒤로 빼며 양발로 동시에 착지하기'],
    ['rhythm_link','리듬 연결','착지 후 멈추지 않고 다음 점프로 이어가기']]},
  { key:'lateral-line-hop', name:'좌우 라인홉', en:'Lateral Line Hop', desc:'선을 사이에 두고 좌우로 빠르게 넘어요.', items:[
    ['light_feet','가벼운 발','앞꿈치로 가볍게 선을 넘기'],
    ['clear_line','선 밟지 않기','매번 선을 정확히 넘어 착지하기'],
    ['centered_trunk','몸통 중심','상체는 가운데, 다리만 좌우로 움직이기'],
    ['steady_rhythm','일정한 리듬','처음부터 끝까지 같은 속도 유지하기']]},
  { key:'forward-back-line-hop', name:'앞뒤 라인홉', en:'Forward-Back Line Hop', desc:'선을 사이에 두고 앞뒤로 빠르게 넘어요.', items:[
    ['quick_rebound','빠른 반동','발이 닿자마자 바로 튀어 오르기'],
    ['clear_line','선 밟지 않기','앞뒤 모두 선을 정확히 넘기'],
    ['upright_trunk','상체 유지','상체가 앞뒤로 숙여지지 않게 하기'],
    ['soft_knees','부드러운 무릎','무릎·발목을 살짝 굽혀 충격 흡수하기']]},
];
const progress = new Map(); // `${activity}:${item}` -> checked
let currentActivity = (()=>{ try { return localStorage.getItem('bigjump.activity'); } catch { return null; } })();
if (!ACTIVITIES.some(a=>a.key===currentActivity)) currentActivity = 'jump-stick';
const activityByKey = key => ACTIVITIES.find(a=>a.key===key) || ACTIVITIES[1];
const activityDone = activity => activity.items.every(([item])=>progress.get(`${activity.key}:${item}`));

function renderActivities() {
  const activity = activityByKey(currentActivity);
  const card = $('.check-card');
  let tabs = $('#activityTabs');
  if (!tabs) { tabs = document.createElement('div'); tabs.id = 'activityTabs'; tabs.className = 'activity-tabs'; card.prepend(tabs); }
  tabs.innerHTML = ACTIVITIES.map((a,i)=>`<button type="button" data-activity="${a.key}" class="${a.key===activity.key?'selected':''} ${activityDone(a)?'done':''}">${i+1}. ${escaped(a.name)}${activityDone(a)?' ✓':''}</button>`).join('');
  $('.check-head strong', card).textContent = activity.name;
  $('.check-list', card).innerHTML = activity.items.map(([item,title,hint])=>{
    const checked = Boolean(progress.get(`${activity.key}:${item}`));
    return `<label class="${checked?'checked':''}" data-check-key="${item}"><input type="checkbox" ${checked?'checked':''}><i></i><span><strong>${escaped(title)}</strong><small>${escaped(hint)}</small></span></label>`;
  }).join('');
  const count = activity.items.filter(([item])=>progress.get(`${activity.key}:${item}`)).length;
  $('.check-count', card).textContent = `${count}/${activity.items.length}`;
  $('.check-progress span', card).style.width = `${count/activity.items.length*100}%`;
  // Today's movement strip: selected activity + overall achievement.
  const done = ACTIVITIES.filter(activityDone).length;
  $('.session-copy strong').innerHTML = `${escaped(activity.name)} <span>${escaped(activity.en)}</span>`;
  $('.session-copy small').textContent = activity.desc;
  $('.progress-top span').textContent = '나의 활동 달성도';
  $('.progress-top strong').innerHTML = `${done} / ${ACTIVITIES.length} <small>활동</small>`;
  $('.progress-track span').style.width = `${done/ACTIVITIES.length*100}%`;
  $('.progress-labels').innerHTML = '<span>체크리스트 4개를 모두 채우면 활동 완료</span>';
}
async function loadChecklist() {
  if (!membership) return;
  const { data, error } = await supabase.from('activity_progress').select('activity_key,item_key,checked').eq('class_id',membership.class_id).eq('user_id',authUser.id);
  if (error) return;
  progress.clear();
  for (const row of data||[]) progress.set(`${row.activity_key}:${row.item_key}`, row.checked);
  renderActivities();
}
$('.check-card').addEventListener('click', event => {
  const tab = event.target.closest('[data-activity]');
  if (!tab) return;
  currentActivity = tab.dataset.activity;
  try { localStorage.setItem('bigjump.activity', currentActivity); } catch {}
  renderActivities();
});
$('.check-card').addEventListener('change', async event => {
  const input = event.target.closest('.check-list input');
  if (!input) return;
  const label = input.closest('label'), activity = activityByKey(currentActivity);
  if (!membership) { input.checked = false; toast('먼저 내 이름을 선택해 수업에 참여해주세요.'); return; }
  progress.set(`${activity.key}:${label.dataset.checkKey}`, input.checked);
  renderActivities();
  const {error}=await supabase.from('activity_progress').upsert({class_id:membership.class_id,user_id:authUser.id,activity_key:activity.key,item_key:label.dataset.checkKey,checked:input.checked,updated_at:new Date().toISOString()},{onConflict:'class_id,user_id,activity_key,item_key'});
  if(error)toast(`체크 기록을 저장하지 못했습니다: ${error.message}`);
});
$('#exerciseInput').innerHTML = ACTIVITIES.map(a=>`<option value="${escaped(a.name)}">${escaped(a.name)}</option>`).join('');
renderActivities();

function openUpload() {
  if(!membership){joinDialog.showModal();listRoster();return;}
  const groupSelect=$('#uploadGroupInput');
  groupSelect.innerHTML=groups.map(group=>`<option value="${escaped(group.id)}">${escaped(group.name)}</option>`).join('')+'<option value="">모둠 없음</option>';
  groupSelect.value=membership.group_id||'';
  $('#exerciseInput').value=activityByKey(currentActivity).name;
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
  currentAnalysis=null;currentSamples=[];selectedVideo=null;
  drawPose(poseCanvas,localVideo,null,false);
  $('#analysisProgress').classList.add('hidden-by-filter');
  $('#analysisIdle').classList.remove('hidden-by-filter');
}
function setMetric(id,value,unit,digits=1) {
  $(`#${id}`).innerHTML=value===null||value===undefined||!Number.isFinite(Number(value))?`— <small>${unit}</small>`:`${Number(value).toLocaleString('ko-KR',{maximumFractionDigits:digits,minimumFractionDigits:digits&&unit!=='W'?digits:0})} <small>${unit}</small>`;
}
function renderAnalysisMetrics(analysis,{mass,height}={}) {
  if(!analysis)return;
  setMetric('metricJumpHeight',analysis.jump_height_cm,'cm',1);
  setMetric('metricFlightTime',analysis.flight_time_s,'초',2);
  setMetric('metricPower',analysis.peak_power_w,'W',0);
  $('#metricHeightMethod').textContent=Number(height)>0?'체공시간 추정 · 신장 비례 비교 포함':'체공시간 기반 · 같은 높이 착지 가정';
  $('#metricPowerMethod').textContent=analysis.peak_power_w?`${analysis.power_formula} · 참고 추정 · 오차 가능성 큼`:(analysis.power_note||'체중을 입력하면 추정합니다.');
  $('#metricKneeAngle').textContent=analysis.knee_extension_angle_deg==null?'—°':`${analysis.knee_extension_angle_deg}°`;
  $('#metricKneeVelocity').textContent=analysis.knee_extension_angular_velocity_deg_s==null?'—°/s':`${analysis.knee_extension_angular_velocity_deg_s}°/s`;
  $('#metricHipVelocity').textContent=analysis.hip_extension_angular_velocity_deg_s==null?'—°/s':`${analysis.hip_extension_angular_velocity_deg_s}°/s`;
  const lean=analysis.trunk_lean_at_landing_deg;
  $('#metricBalance').textContent=lean==null?'측정 불가':`${lean.toFixed(0)}° 기울기`;
  $('#balanceBar').style.width=lean==null?'0%':`${Math.max(8,100-Math.min(lean,50)*1.5)}%`;
  $('#analysisQuality').textContent='포즈 감지 · 참고값';
  $('#analysisDisclaimer').textContent='비행시간으로 점프 높이를 추정하며 도약·착지 높이가 같다고 가정합니다. 파워는 Sayers 회귀식 추정치로, 힘판에서 직접 측정한 값이 아니며 원 논문에서 보고한 추정 오차는 수백 W 수준입니다.';
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
    selectedVideo={id:data.id,display_name:membership.display_name,exercise,analysis:record,storage_path:path,user_id:authUser.id,body_mass_kg:mass,height_cm:height};
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
  resetAnalysis();selectedVideo=row;currentAnalysis=row.analysis||null;
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

function openFeedback(row) {
  if(!row||!membership)return;
  activeFeedbackVideo=row;feedbackKind='observation';
  $('#feedbackTarget').textContent=row.display_name;$('#feedbackText').value='';
  analysisDialog.close();feedbackDialog.showModal();
}
$('#feedbackButton').addEventListener('click',()=>openFeedback(selectedVideo));
$('#closeFeedback').addEventListener('click',()=>feedbackDialog.close());
$('#cancelFeedback').addEventListener('click',()=>feedbackDialog.close());
$$('.feedback-prompts button').forEach(button=>button.addEventListener('click',()=>{
  feedbackKind=button.textContent.includes('잘한')?'strength':button.textContent.includes('다음')?'next_try':button.textContent.includes('균형')?'balance':'observation';
  const prefix={strength:'잘한 점: ',next_try:'다음 시도: ',balance:'균형 관찰: ',observation:''}[feedbackKind];
  if(!$('#feedbackText').value)$('#feedbackText').value=prefix;
  $('#feedbackText').focus();
}));
$('#sendFeedback').addEventListener('click',async()=>{
  const content=$('#feedbackText').value.trim();if(!content||!activeFeedbackVideo)return;
  const button=$('#sendFeedback');button.disabled=true;
  const {error}=await supabase.from('feedback').insert({video_id:activeFeedbackVideo.id,user_id:authUser.id,display_name:membership.display_name,kind:feedbackKind,content});
  button.disabled=false;
  if(error){toast(`피드백 저장 실패: ${error.message}`);return;}
  feedbackDialog.close();toast('관찰 피드백을 담벼락에 남겼어요.');await loadFeed();
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
$('#teacherLoad').addEventListener('click',async()=>{
  showTeacherError('');
  const code=($('#teacherClassCode').textContent==='—'?$('#joinCode').value:$('#teacherClassCode').textContent).trim().toUpperCase();
  if(!code){showTeacherError('수업 코드가 필요합니다. 먼저 수업을 만들거나 코드를 입력해주세요.');return;}
  try {
    const data=await teacherRequest({action:'load-class',class_code:code});
    $('#teacherClassCode').textContent=data.classroom.join_code;$('#editGroupNamesInput').value=data.groups.map(group=>group.name).join(', ');
    $('#editRosterInput').value=data.roster.map(row=>`${row.student_name}, ${row.groups?.name||''}`).join('\n');teacherTab('roster');
    toast(`${data.roster.length}명의 학생 명단을 불러왔어요.`);
  } catch(error){showTeacherError(error.message);}
});
$('#saveRosterButton').addEventListener('click',async()=>{
  showTeacherError('');
  const code=$('#teacherClassCode').textContent.trim();
  const groups=$('#editGroupNamesInput').value.split(',').map(value=>value.trim()).filter(Boolean);
  const students=$('#editRosterInput').value.split(/\r?\n/).map(line=>{
    const [name,...rest]=line.split(',');return {name:name.trim(),group:rest.join(',').trim()};
  }).filter(row=>row.name);
  try {
    const data=await teacherRequest({action:'save-roster',class_code:code,groups,students});
    toast(`${data.student_count}명의 학생 배정을 저장했어요.`);
    await loadClassroom(membership);
  } catch(error){showTeacherError(error.message);}
});
teacherDialog.addEventListener('close',()=>$('#teacherPin').value='');

for(const dialog of [analysisDialog,feedbackDialog,uploadDialog,joinDialog,teacherDialog])dialog.addEventListener('click',event=>{
  if(event.target!==dialog||!event.isTrusted)return;
  const rect=dialog.getBoundingClientRect();
  if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();
});

startApp();
