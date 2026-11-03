// Use a stable, published version. The wasm folder must be the same version as the bundle.
const VISION_VERSION = '0.10.35';
const VISION_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
const CONNECTIONS = [
  [11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],
  [23,25],[25,27],[27,29],[29,31],[27,31],[24,26],[26,28],[28,30],[30,32],[28,32],
];
const SIDES = {
  left: { shoulder: 11, hip: 23, knee: 25, ankle: 27 },
  right: { shoulder: 12, hip: 24, knee: 26, ankle: 28 },
};
const FOOT_POINTS = [29, 30, 31, 32]; // heels and toes
const G = 9.80665;
const MAX_FLIGHT_S = 1.0; // ~1.2 m jump; anything longer is not a real flight
const MIN_FLIGHT_S = 0.1;

let landmarkerPromise;
// VIDEO mode needs strictly increasing timestamps for the lifetime of the landmarker,
// including across separate analyses.
let lastTimestamp = 0;

async function createLandmarker(vision, files, delegate) {
  return vision.PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO', numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

async function getLandmarker() {
  if (!landmarkerPromise) landmarkerPromise = (async () => {
    let vision;
    try {
      vision = await import(`${VISION_BASE}/vision_bundle.mjs`);
    } catch (error) {
      throw new Error('포즈 분석 모델을 불러오지 못했습니다. 인터넷 연결이나 학교 네트워크의 CDN 차단 여부를 확인해주세요.');
    }
    const files = await vision.FilesetResolver.forVisionTasks(`${VISION_BASE}/wasm`);
    try {
      return await createLandmarker(vision, files, 'GPU');
    } catch (error) {
      console.warn('GPU pose model failed, falling back to CPU', error);
      return createLandmarker(vision, files, 'CPU');
    }
  })().catch(error => { landmarkerPromise = null; throw error; });
  return landmarkerPromise;
}

async function resetLandmarker(model) {
  try { model?.close?.(); } catch {}
  landmarkerPromise = null;
  return getLandmarker();
}

export function validPoint(p, minVisibility = 0.25) {
  return Boolean(p) && (p.visibility ?? 1) >= minVisibility && Number.isFinite(p.x) && Number.isFinite(p.y);
}
function percentile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a,b)=>a-b);
  if (!sorted.length) return NaN;
  const pos = (sorted.length-1)*q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi]-sorted[lo])*(pos-lo);
}
const median = values => percentile(values, 0.5);
function angleAt(a,b,c,aspect) {
  if (![a,b,c].every(p=>validPoint(p))) return NaN;
  // Normalized x is in width units and y in height units; convert x into height units.
  const v1={x:(a.x-b.x)*aspect,y:a.y-b.y}, v2={x:(c.x-b.x)*aspect,y:c.y-b.y};
  const m1=Math.hypot(v1.x,v1.y),m2=Math.hypot(v2.x,v2.y);
  if (!m1 || !m2) return NaN;
  const dot=Math.max(-1,Math.min(1,(v1.x*v2.x+v1.y*v2.y)/(m1*m2)));
  return Math.acos(dot)*180/Math.PI;
}
function trunkAngle(landmarks,aspect) {
  const pts=[11,12,23,24].map(i=>landmarks[i]);
  if (!pts.every(p=>validPoint(p))) return NaN;
  const shoulder={x:(pts[0].x+pts[1].x)/2,y:(pts[0].y+pts[1].y)/2};
  const hip={x:(pts[2].x+pts[3].x)/2,y:(pts[2].y+pts[3].y)/2};
  return Math.atan2((shoulder.x-hip.x)*aspect, hip.y-shoulder.y)*180/Math.PI;
}
// Centered moving average that skips missing values.
function smooth(values, radius) {
  return values.map((_,i)=>{
    let sum=0,n=0;
    for (let k=i-radius;k<=i+radius;k++) if (Number.isFinite(values[k])) { sum+=values[k]; n++; }
    return Number.isFinite(values[i]) && n ? sum/n : NaN;
  });
}
function medianFilter3(values) {
  return values.map((v,i)=>{
    const window=[values[i-1],v,values[i+1]].filter(Number.isFinite);
    return Number.isFinite(v) ? median(window) : NaN;
  });
}
// Peak positive rate of change (deg/s) using central differences.
function peakExtensionVelocity(angles, times, from, to) {
  let peak=NaN;
  for (let i=Math.max(1,from); i<=Math.min(angles.length-2,to); i++) {
    const a=angles[i-1], b=angles[i+1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const v=(b-a)/(times[i+1]-times[i-1]);
    if (v>0 && !(v<=peak)) peak=v;
  }
  return peak;
}
function pickSide(frames) {
  const score = side => frames.reduce((sum,lm)=>{
    if (!lm) return sum;
    const s=SIDES[side];
    return sum + [s.hip,s.knee,s.ankle].reduce((n,i)=>n+(lm[i]?.visibility ?? 0),0);
  },0);
  return score('left') >= score('right') ? 'left' : 'right';
}

/**
 * Pure calculation from per-frame landmarks. Exported for testing.
 * frames: [{ time, landmarks|null }] sampled at a fixed rate.
 */
export function computeJumpMetrics(frames, { fps, aspect, bodyMassKg, heightCm, exercise } = {}) {
  const n=frames.length, dt=1/fps;
  const times=frames.map(f=>f.time);
  const lms=frames.map(f=>f.landmarks);
  // Lowest visible point of either foot (image y grows downward).
  const rawFootY=lms.map(lm=>{
    if (!lm) return NaN;
    const ys=FOOT_POINTS.map(i=>lm[i]).filter(p=>validPoint(p)).map(p=>p.y);
    return ys.length ? Math.max(...ys) : NaN;
  });
  const footY=medianFilter3(rawFootY);
  const bodyLen=lms.map((lm,i)=>lm&&validPoint(lm[0])&&Number.isFinite(footY[i])?footY[i]-lm[0].y:NaN);
  // Standing nose-to-floor length; a high percentile ignores crouched frames.
  const scale=percentile(bodyLen,0.8);
  const ground=percentile(footY,0.8);
  if (!Number.isFinite(scale) || scale<=0.05 || !Number.isFinite(ground)) {
    throw new Error('전신 관절을 찾지 못했습니다. 옆면에서 머리부터 발끝까지 보이게 다시 촬영해주세요.');
  }
  // Pogo and line hops leave the floor by only a few cm, so they use a lower threshold.
  const repeated=/포고|라인홉|연속/.test(String(exercise||''));
  const liftThreshold=repeated?Math.max(0.005,scale*0.014):Math.max(0.01,scale*0.03); // ~2 cm / ~5 cm off the floor
  const groundTol=repeated?Math.max(0.002,scale*0.005):Math.max(0.004,scale*0.01);    // ~0.7 cm / ~1.5 cm: back on the floor
  const minFlight=repeated?0.06:MIN_FLIGHT_S;
  const airborne=footY.map(y=>Number.isFinite(y)&&y<ground-liftThreshold);

  const bouts=[];
  for (let i=0;i<n;i++) {
    if (!airborne[i]) continue;
    let end=i; while (end+1<n && airborne[end+1]) end++;
    if (end>i) bouts.push({start:i,end});
    i=end;
  }
  const window=Math.round(0.4*fps);
  const candidates=bouts.map(({start,end})=>{
    // Local floor level just before take-off and just after landing.
    const before=footY.slice(Math.max(0,start-window),start).filter((y,k)=>Number.isFinite(y)&&!airborne[Math.max(0,start-window)+k]);
    const after=footY.slice(end+1,end+1+window).filter((y,k)=>Number.isFinite(y)&&!airborne[end+1+k]);
    const floors=[median(before),median(after)].filter(Number.isFinite);
    const floor=floors.length?floors.reduce((a,b)=>a+b,0)/floors.length:ground;
    const level=floor-groundTol;
    // Extend the bout outward to where the foot actually leaves / reaches the floor.
    let k=start; while (k-1>=0 && footY[k-1]<level) k--;
    let m=end; while (m+1<n && footY[m+1]<level) m++;
    const cross=(i,j)=>{ // time where footY crosses `level` between frames i and j
      const a=footY[i], b=footY[j];
      if (!Number.isFinite(a)||!Number.isFinite(b)||a===b) return (times[i]+times[j])/2;
      return times[i]+(times[j]-times[i])*Math.min(1,Math.max(0,(a-level)/(a-b)));
    };
    const takeoff=k>0?cross(k-1,k):times[k]-dt/2;
    const landing=m<n-1?cross(m,m+1):times[m]+dt/2;
    const peakY=Math.min(...footY.slice(k,m+1).filter(Number.isFinite));
    return {start:k,end:m,takeoff,landing,duration:landing-takeoff,floor,peakY};
  });
  const valid=candidates.filter(c=>c.duration>=minFlight&&c.duration<=MAX_FLIGHT_S);
  if (!valid.length) {
    if (candidates.some(c=>c.duration>MAX_FLIGHT_S)) throw new Error('체공 시간이 비정상적으로 깁니다. 슬로모션으로 촬영한 영상이면 일반 속도(1배속) 영상으로 다시 올려주세요.');
    throw new Error('도약과 착지 구간을 찾지 못했습니다. 준비 자세와 착지가 모두 보이는 영상으로 다시 시도해주세요.');
  }
  const jump=valid.sort((a,b)=>b.duration-a.duration)[0];
  const jumpHeightCm=G*jump.duration*jump.duration/8*100;

  const side=pickSide(lms);
  const s=SIDES[side];
  const knee=smooth(lms.map(lm=>lm?angleAt(lm[s.hip],lm[s.knee],lm[s.ankle],aspect):NaN),1);
  const hip=smooth(lms.map(lm=>lm?angleAt(lm[s.shoulder],lm[s.hip],lm[s.knee],aspect):NaN),1);
  // Propulsion phase: from 0.4 s before take-off until just after it.
  const from=Math.max(0,jump.start-window), to=Math.min(n-1,jump.start+1);
  const kneeWindow=knee.slice(from,to+1).filter(Number.isFinite);
  const maxKnee=kneeWindow.length?Math.max(...kneeWindow):NaN;
  const minKnee=kneeWindow.length?Math.min(...kneeWindow):NaN;
  const kneeVel=peakExtensionVelocity(knee,times,from,to);
  const hipVel=peakExtensionVelocity(hip,times,from,to);
  const landingIndex=Math.min(n-1,jump.end+1);
  const lean=Math.abs(lms[landingIndex]?trunkAngle(lms[landingIndex],aspect):NaN);

  // Landing: how far and how fast the knee bends to absorb the impact (largest jump).
  const absorbTo=Math.min(n-1,landingIndex+Math.round(0.6*fps));
  let absorbEnd=landingIndex, kneeLowest=knee[landingIndex];
  for (let i=landingIndex;i<=absorbTo;i++) if (Number.isFinite(knee[i]) && !(knee[i]>=kneeLowest)) { kneeLowest=knee[i]; absorbEnd=i; }
  const landingFlex=Number.isFinite(knee[landingIndex])&&Number.isFinite(kneeLowest)?knee[landingIndex]-kneeLowest:NaN;
  const flexVel=peakExtensionVelocity(knee.map(v=>-v),times,landingIndex,absorbTo);
  // Stick: time the hips and feet stay still after the landing absorption.
  const hipMid=lms.map(lm=>lm&&validPoint(lm[23])&&validPoint(lm[24])?{x:(lm[23].x+lm[24].x)/2,y:(lm[23].y+lm[24].y)/2}:null);
  const footX=lms.map(lm=>{ if(!lm) return NaN; const xs=FOOT_POINTS.map(i=>lm[i]).filter(p=>validPoint(p)).map(p=>p.x); return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:NaN; });
  let holdS=NaN;
  if (hipMid[absorbEnd] && Number.isFinite(footX[absorbEnd])) {
    const ref=hipMid[absorbEnd], refFoot=footX[absorbEnd], tol=scale*0.06;
    let last=absorbEnd;
    for (let i=absorbEnd+1;i<n;i++) {
      if (airborne[i]) break;
      if (!hipMid[i] || !Number.isFinite(footX[i])) { if (i-last>3) break; continue; }
      if (Math.hypot((hipMid[i].x-ref.x)*aspect,hipMid[i].y-ref.y)>tol || Math.abs((footX[i]-refFoot)*aspect)>tol) break;
      last=i;
    }
    holdS=times[last]-times[landingIndex];
  }
  // Repeated jumps (pogo, line hops, broad series): ground contact between hops and rhythm.
  const hops=valid.slice().sort((a,b)=>a.takeoff-b.takeoff);
  const contacts=[], flights=[];
  for (let i=1;i<hops.length;i++) {
    const contact=hops[i].takeoff-hops[i-1].landing;
    if (contact>0.03&&contact<1.5) { contacts.push(contact); flights.push((hops[i].duration+hops[i-1].duration)/2); }
  }
  const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:NaN;
  const meanContact=mean(contacts), meanFlight=mean(flights);
  const span=hops.length>=3?hops[hops.length-1].takeoff-hops[0].takeoff:NaN;
  const cycles=hops.slice(1).map((h,i)=>h.takeoff-hops[i].takeoff).filter(c=>c<2);
  const cycleMean=mean(cycles), cycleSd=cycles.length>1?Math.sqrt(mean(cycles.map(c=>(c-cycleMean)**2))):NaN;
  const mass=Number(bodyMassKg);
  const exerciseName=String(exercise||'');
  const isSquatJump=exerciseName.includes('스쿼트');
  // Sayers equations were built for single vertical jumps (CMJ/SJ); other drills get no power estimate.
  const powerApplies=isSquatJump||exerciseName.includes('점프 앤 스틱');
  const powerW=mass>0&&powerApplies ? (isSquatJump ? 60.7*jumpHeightCm+45.3*mass-2055 : 51.9*jumpHeightCm+48.9*mass-2007) : null;
  // Above ~75 cm the take-off/landing detection is almost certainly wrong for students, so no power.
  const powerValid=powerW!==null&&powerW>0&&jumpHeightCm<=75;
  // Nose height is ~92% of standing height.
  const visualJumpCm=Number(heightCm)>0&&Number.isFinite(jump.peakY)?Math.max(0,(jump.floor-jump.peakY)/scale*Number(heightCm)*0.92):null;
  const round=(v,d)=>Number.isFinite(v)?Number(v.toFixed(d)):null;
  return {
    method:'flight_time_same_landing_level',
    flight_time_s:round(jump.duration,3),
    jump_height_cm:round(jumpHeightCm,2),
    visual_height_cm:visualJumpCm===null?null:round(visualJumpCm,2),
    body_mass_kg:mass>0?mass:null,
    stature_cm:Number(heightCm)>0?Number(heightCm):null,
    peak_power_w:powerValid?Math.round(powerW):null,
    power_formula:isSquatJump?'Sayers SJ (60.7×height_cm + 45.3×mass_kg − 2055)':'Sayers CMJ (51.9×height_cm + 48.9×mass_kg − 2007)',
    power_standard_error_w:isSquatJump?373:562,
    power_note:!powerApplies?'파워 추정식은 제자리 수직 점프(점프 앤 스틱)에만 적용해요.':(mass>0?null:'체중을 입력하면 추정합니다.'),
    knee_extension_angle_deg:round(maxKnee,1),
    knee_min_angle_deg:round(minKnee,1),
    knee_extension_angular_velocity_deg_s:round(kneeVel,1),
    hip_extension_angular_velocity_deg_s:round(hipVel,1),
    analysis_side:side,
    trunk_lean_at_landing_deg:round(lean,1),
    takeoff_s:round(jump.takeoff,3),
    landing_s:round(jump.landing,3),
    jump_count:valid.length,
    landing_knee_flexion_deg:round(landingFlex,1),
    landing_knee_flexion_velocity_deg_s:round(flexVel,1),
    stick_hold_s:round(holdS,2),
    hop_count:hops.length,
    mean_contact_time_s:contacts.length?round(meanContact,3):null,
    reactive_strength_index:contacts.length?round(meanFlight/meanContact,2):null,
    hops_per_10s:Number.isFinite(span)&&span>0?round((hops.length-1)/span*10,1):null,
    rhythm_variation_pct:Number.isFinite(cycleSd)&&cycleMean>0?round(cycleSd/cycleMean*100,1):null,
    confidence:'estimated',
    sample_fps:fps,
    pose_model:`mediapipe-tasks-vision@${VISION_VERSION} pose_landmarker_full`,
  };
}

function seekTo(video, time) {
  return new Promise((resolve,reject)=>{
    const done=()=>{clearTimeout(timer);video.removeEventListener('seeked',onSeeked);video.removeEventListener('error',onError);};
    const onSeeked=()=>{done();resolve();};
    const onError=()=>{done();reject(new Error('영상 프레임을 읽지 못했습니다.'));};
    const timer=setTimeout(()=>{done();resolve();},3000);
    video.addEventListener('seeked',onSeeked);
    video.addEventListener('error',onError);
    video.currentTime=time;
  });
}

export async function analyzeJump(video, { bodyMassKg, heightCm, exercise, onProgress = () => {}, onFrame = () => {} } = {}) {
  let model=await getLandmarker();
  if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration)) throw new Error('영상이 아직 준비되지 않았습니다.');
  video.pause();
  const originalTime=video.currentTime;
  const duration=Math.min(video.duration,30);
  const fps=30;
  const count=Math.max(2,Math.floor(duration*fps));
  const aspect=video.videoWidth/video.videoHeight;
  const frames=[];
  const base=lastTimestamp+1000;
  let rebuilds=0;
  for (let i=0;i<count;i++) {
    const time=Math.min(duration-0.001,i/fps);
    await seekTo(video,time);
    const timestamp=Math.max(lastTimestamp+1,base+Math.round(time*1000));
    lastTimestamp=timestamp;
    let landmarks=null;
    try {
      landmarks=model.detectForVideo(video,timestamp).landmarks?.[0] ?? null;
    } catch (error) {
      if (String(error?.message||error).toLowerCase().includes('security')) throw new Error('영상 보안 설정 때문에 프레임을 읽지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.');
      // MediaPipe's tracking box can collapse to zero size (e.g. the body leaves the frame or the pose
      // is lost mid-jump). The graph then stays broken, so rebuild the model, skip this frame and go on.
      console.warn('Pose graph failed at', time.toFixed(2), 's; rebuilding', error);
      if (++rebuilds > 6) throw new Error('관절 추적이 계속 끊겨 분석하지 못했습니다. 머리부터 발끝까지 화면 안에 들어오도록 조금 더 멀리서 촬영해주세요.');
      model = await resetLandmarker(model);
    }
    frames.push({time,landmarks});
    if (landmarks) onFrame({time,landmarks,videoWidth:video.videoWidth,videoHeight:video.videoHeight});
    if (i%3===0 || i===count-1) onProgress((i+1)/count);
  }
  await seekTo(video,originalTime);
  const metrics=computeJumpMetrics(frames,{fps,aspect,bodyMassKg,heightCm,exercise});
  return {...metrics,samples:frames};
}

export function drawPose(canvas, video, landmarks, enabled=true) {
  const ctx=canvas.getContext('2d');
  const width=video.videoWidth||canvas.clientWidth, height=video.videoHeight||canvas.clientHeight;
  if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
  ctx.clearRect(0,0,width,height);
  if(!enabled||!landmarks)return;
  ctx.lineWidth=Math.max(2,width/350);ctx.strokeStyle='#d9f276';ctx.fillStyle='#efffa2';ctx.shadowColor='#87aa40';ctx.shadowBlur=5;
  for(const [a,b] of CONNECTIONS){const p=landmarks[a],q=landmarks[b];if(!validPoint(p)||!validPoint(q))continue;ctx.beginPath();ctx.moveTo(p.x*width,p.y*height);ctx.lineTo(q.x*width,q.y*height);ctx.stroke();}
  for(const index of [11,12,13,14,15,16,23,24,25,26,27,28,29,30,31,32]){const p=landmarks[index];if(!validPoint(p))continue;ctx.beginPath();ctx.arc(p.x*width,p.y*height,Math.max(3,width/180),0,Math.PI*2);ctx.fill();}
  ctx.shadowBlur=0;
}
