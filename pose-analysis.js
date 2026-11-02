const VISION_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const CONNECTIONS = [
  [11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],
  [23,25],[25,27],[27,29],[29,31],[27,31],[24,26],[26,28],[28,30],[30,32],[28,32],
];
let landmarkerPromise;

async function getLandmarker() {
  if (!landmarkerPromise) landmarkerPromise = (async () => {
    const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/vision_bundle.mjs');
    const files = await vision.FilesetResolver.forVisionTasks(VISION_ROOT);
    return vision.PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.45,
      minPosePresenceConfidence: 0.45,
      minTrackingConfidence: 0.45,
    });
  })().catch(error => { landmarkerPromise = null; throw error; });
  return landmarkerPromise;
}

function validPoint(p) { return p && (p.visibility ?? 1) >= 0.25 && Number.isFinite(p.x) && Number.isFinite(p.y); }
function average(points) {
  const usable = points.filter(validPoint);
  if (!usable.length) return null;
  return { x: usable.reduce((n,p)=>n+p.x,0)/usable.length, y: usable.reduce((n,p)=>n+p.y,0)/usable.length };
}
function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a,b)=>a-b);
  if (!sorted.length) return NaN;
  const mid = Math.floor(sorted.length/2);
  return sorted.length%2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;
}
function angleAt(a,b,c,aspect) {
  if (![a,b,c].every(validPoint)) return NaN;
  const v1={x:(a.x-b.x)*aspect,y:a.y-b.y}, v2={x:(c.x-b.x)*aspect,y:c.y-b.y};
  const m1=Math.hypot(v1.x,v1.y),m2=Math.hypot(v2.x,v2.y);
  if (!m1 || !m2) return NaN;
  const dot=Math.max(-1,Math.min(1,(v1.x*v2.x+v1.y*v2.y)/(m1*m2)));
  return Math.acos(dot)*180/Math.PI;
}
function jointAngle(landmarks, leftHip, leftKnee, leftAnkle, rightHip, rightKnee, rightAnkle, aspect) {
  const left=angleAt(landmarks[leftHip],landmarks[leftKnee],landmarks[leftAnkle],aspect);
  const right=angleAt(landmarks[rightHip],landmarks[rightKnee],landmarks[rightAnkle],aspect);
  if (Number.isFinite(left) && Number.isFinite(right)) return (left+right)/2;
  return Number.isFinite(left) ? left : right;
}
function trunkAngle(landmarks,aspect) {
  const shoulder=average([landmarks[11],landmarks[12]]), hip=average([landmarks[23],landmarks[24]]);
  if (!shoulder || !hip) return NaN;
  return Math.atan2((hip.x-shoulder.x)*aspect, hip.y-shoulder.y)*180/Math.PI;
}
function waitForSeek(video) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>resolve(),1200);
    video.addEventListener('seeked',()=>{clearTimeout(timer);resolve();},{once:true});
    video.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('영상 프레임을 읽지 못했습니다.'));},{once:true});
  });
}

export async function analyzeJump(video, { bodyMassKg, heightCm, exercise, onProgress = () => {}, onFrame = () => {} } = {}) {
  const model=await getLandmarker();
  if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration)) throw new Error('영상이 아직 준비되지 않았습니다.');
  video.pause();
  const originalTime=video.currentTime;
  const originalRate=video.playbackRate;
  const duration=Math.min(video.duration,30);
  const fps=30;
  const count=Math.max(2,Math.ceil(duration*fps));
  const samples=[];
  let lastTimestamp=-1;
  for (let i=0;i<count;i++) {
    const time=Math.min(duration-0.001,i/fps);
    if (Math.abs(video.currentTime-time)>0.001) { video.currentTime=time; await waitForSeek(video); }
    const timestamp=Math.max(lastTimestamp+1,Math.round(time*1000));
    lastTimestamp=timestamp;
    const result=model.detectForVideo(video,timestamp);
    const landmarks=result.landmarks?.[0] ?? null;
    if (landmarks) {
      const feet=average([landmarks[27],landmarks[28],landmarks[29],landmarks[30],landmarks[31],landmarks[32]]);
      const nose=landmarks[0];
      const personHeight=feet&&validPoint(nose)?Math.abs(feet.y-nose.y):NaN;
      const knee=jointAngle(landmarks,23,25,27,24,26,28,video.videoWidth/video.videoHeight);
      const trunk=trunkAngle(landmarks,video.videoWidth/video.videoHeight);
      samples.push({time,landmarks,feetY:feet?.y??NaN,personHeight,knee,trunk});
      onFrame({time,landmarks,videoWidth:video.videoWidth,videoHeight:video.videoHeight});
    } else samples.push({time,landmarks:null,feetY:NaN,personHeight:NaN,knee:NaN,trunk:NaN});
    if (i%3===0 || i===count-1) onProgress((i+1)/count);
  }
  video.currentTime=originalTime;
  video.playbackRate=originalRate;
  const firstSamples=samples.filter(s=>s.time<=Math.min(0.45,duration*0.12)&&Number.isFinite(s.feetY));
  const baseline=median(firstSamples.map(s=>s.feetY));
  const scale=median(firstSamples.map(s=>s.personHeight));
  if (!Number.isFinite(baseline)||!Number.isFinite(scale)||scale<=0) throw new Error('전신 관절을 찾지 못했습니다. 옆면에서 머리부터 발끝까지 보이게 다시 촬영해주세요.');
  const liftThreshold=Math.max(0.012,scale*0.045);
  const airborne=samples.map(s=>Number.isFinite(s.feetY)&&s.feetY<baseline-liftThreshold);
  const bouts=[];
  let start=-1;
  for (let i=0;i<=airborne.length;i++) {
    if (airborne[i]&&start<0) start=i;
    if ((!airborne[i]||i===airborne.length)&&start>=0) {
      const end=i-1;
      if (end-start>=2) bouts.push({start,end,duration:samples[end].time-samples[start].time+1/fps});
      start=-1;
    }
  }
  const jump=bouts.filter(b=>b.duration>=0.12&&b.duration<=1.5).sort((a,b)=>b.duration-a.duration)[0];
  if (!jump) throw new Error('도약과 착지 구간을 찾지 못했습니다. 준비 자세와 착지가 모두 보이는 영상으로 다시 시도해주세요.');
  const jumpHeightCm=9.80665*jump.duration*jump.duration/8*100;
  const mass=Number(bodyMassKg);
  const isSquatJump=String(exercise||'').toLowerCase().includes('스쿼트');
  const powerW=mass>0 ? (isSquatJump ? 60.7*jumpHeightCm+45.3*mass-2055 : 51.9*jumpHeightCm+48.9*mass-2007) : null;
  const powerValid=powerW!==null&&powerW>0;
  const windowStart=Math.max(0,samples[jump.start].time-0.35);
  const windowEnd=samples[jump.start].time+0.05;
  const approach=samples.filter(s=>s.time>=windowStart&&s.time<=windowEnd&&Number.isFinite(s.knee));
  const maxKnee=approach.length?Math.max(...approach.map(s=>s.knee)):NaN;
  let maxExtensionVelocity=NaN;
  for(let i=1;i<approach.length;i++) {
    const delta=approach[i].time-approach[i-1].time;
    const velocity=(approach[i].knee-approach[i-1].knee)/delta;
    if(velocity>0&&(!Number.isFinite(maxExtensionVelocity)||velocity>maxExtensionVelocity)) maxExtensionVelocity=velocity;
  }
  const landing=samples[jump.end];
  const lean=Math.abs(landing.trunk);
  const visualJumpCm=Number(heightCm)>0?Math.max(0,(baseline-Math.min(...samples.slice(jump.start,jump.end+1).map(s=>s.feetY).filter(Number.isFinite)))/scale*Number(heightCm)):null;
  return {
    method:'flight_time_same_landing_level',
    flight_time_s:Number(jump.duration.toFixed(3)),
    jump_height_cm:Number(jumpHeightCm.toFixed(2)),
    visual_height_cm:visualJumpCm===null?null:Number(visualJumpCm.toFixed(2)),
    body_mass_kg:mass>0?mass:null,
    stature_cm:Number(heightCm)>0?Number(heightCm):null,
    peak_power_w:powerValid?Math.round(powerW):null,
    power_formula:isSquatJump?'Sayers SJ (60.7×height_cm + 45.3×mass_kg − 2055)':'Sayers CMJ (51.9×height_cm + 48.9×mass_kg − 2007)',
    power_standard_error_w:isSquatJump?373:562,
    knee_extension_angle_deg:Number.isFinite(maxKnee)?Number(maxKnee.toFixed(1)):null,
    knee_extension_angular_velocity_deg_s:Number.isFinite(maxExtensionVelocity)?Number(maxExtensionVelocity.toFixed(1)):null,
    trunk_lean_at_landing_deg:Number.isFinite(lean)?Number(lean.toFixed(1)):null,
    takeoff_s:Number(samples[jump.start].time.toFixed(3)),
    landing_s:Number(samples[jump.end].time.toFixed(3)),
    confidence:'estimated',
    sample_fps:fps,
    samples,
  };
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
