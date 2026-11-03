# Big Jump

플라이오메트릭 수업 담벼락과 동작 관찰 도구입니다. 학생은 이메일·비밀번호 입력 없이 Supabase 익명 세션으로 참여하고, 초대 코드와 교사 명단의 이름으로 수업을 연결합니다.

## 현재 구성

- `index.html`, `styles.css`, `app.js`: 담벼락, 업로드·피드백, 학생 참여, 교사 수업 관리 UI
- `pose-analysis.js`: 브라우저에서 MediaPipe Pose Landmarker(tasks-vision 0.10.35, full 모델, GPU 실패 시 CPU)로 영상 프레임 포즈 추출 및 점프·관절 계산
- `supabase/migrations/202611020001_big_jump.sql`: 수업, 모둠, 명단, 영상, 피드백, 체크리스트 테이블과 RLS 및 비공개 Storage 버킷
- `supabase/functions/join-class`: 익명 기기 세션과 학급 명단 이름 연결
- `supabase/functions/teacher-admin`: 교사 관리 코드 확인 후 수업·모둠·학생 명단 변경
- `config.js`: Supabase 프로젝트 URL과 브라우저용 publishable key

## 영상과 분석

영상은 브라우저에서 분석한 뒤 Supabase의 비공개 `class-videos` 버킷에 올라갑니다. 원본 파일은 학급 구성원에게 만료되는 서명 URL로 제공됩니다. MediaPipe 모델은 브라우저가 Google AI Edge 공식 CDN에서 불러오며, 영상 프레임 자체는 포즈 분석을 위해 외부 AI 서비스로 전송하지 않습니다.

CV는 초당 30개 프레임(최대 30초)을 분석해 발목의 초기 지면 기준 대비 이탈·복귀 구간으로 체공시간을 추정하고, 같은 높이에서 도약·착지한다고 가정해 `h = g·t²/8`로 점프 높이를 계산합니다. 다리 관절 점으로 무릎각과 도약 직전 신전 각속도를 계산하고, 착지 순간 어깨-골반 선의 기울기를 표시합니다. 신장을 입력하면 영상상 신체 크기 대비 발 위치 변화값도 교차 확인용으로 기록합니다. 카메라가 비스듬하거나 발이 가려지면 감지가 흔들릴 수 있어 결과는 참고 측정값입니다.

파워는 힘판의 힘-시간 자료가 없어 직접 측정한 값으로 표시하지 않습니다. 점프 앤 스틱은 CMJ, 스쿼트 점프는 SJ에 해당하는 Sayers 회귀식을 사용해 추정하고 원 연구의 수백 W 수준 표준추정오차를 함께 안내합니다. 이 회귀식은 청소년 수업 환경에서 별도 검증되지 않았으므로 학생 간 순위나 성적 판정에 사용하면 안 됩니다. 출처: [Sayers et al. (1999), Cross-validation of three jump power equations](https://doi.org/10.1097/00005768-199904000-00013).

## Supabase 설정

1. Supabase Dashboard의 SQL Editor에서 `supabase/migrations/202611020001_big_jump.sql`을 실행합니다.
2. Authentication에서 Anonymous Sign-Ins를 켭니다. 별도 로그인 UI는 없지만 Supabase가 기기별 익명 ID를 만들어 RLS 권한을 적용합니다.
3. Supabase CLI로 로그인하고 프로젝트를 연결한 뒤 함수를 배포합니다.

   ```powershell
   npx supabase login
   npx supabase link --project-ref tduggsraexjrjsiarzit
   npx supabase functions deploy join-class
   npx supabase functions deploy teacher-admin
   ```

4. 교사용 숫자 4자리 PIN을 정해 Supabase Edge Function secret `BIGJUMP_TEACHER_CODE`로 등록합니다. 이는 수업 생성과 명단 수정 화면을 여는 데 사용합니다.

   ```powershell
   npx supabase secrets set BIGJUMP_TEACHER_CODE=여기에_교사_PIN_4자리
   ```

5. `config.js`에는 URL과 **publishable** 키만 둡니다. `service_role` 또는 secret key는 절대 클라이언트에 넣지 않습니다.
6. 학교 배포 전에 Edge Function CORS의 `BIGJUMP_ALLOWED_ORIGIN`을 실제 사이트 주소로 설정하고, Supabase Auth CAPTCHA/요청 제한과 영상 보관 기간을 정합니다.

## 교사 관리 화면

`https://djhl36.github.io/big-jump/?admin` 으로 열면 학생 참여 화면 없이 교사 관리 창이 바로 열립니다. 교사 PIN을 입력하고 ‘수업 불러오기’를 누르면 학생별 모둠을 드롭다운으로 바꾸고 저장할 수 있습니다.

## 모둠 활동 방식

### 1. 📹 촬영 활동 (스쿼트 점프, 브로드 점프 연속동작 3회)
옆에서 전신을 촬영해 올리면 브라우저에서 MediaPipe 포즈 모델로 분석합니다(서버로 원본 프레임을 보내지 않음).
- 점프 높이: 체공 시간 t로 h = g·t²/8
- 도약 관절 신전 각속도: 발목(무릎–발목–발끝), 무릎, 고관절. 도약 직전 0.4초의 최대값
- 추정 파워: Sayers 스쿼트 점프 식(스쿼트 점프만, 체중 필요). 점프 75 cm 초과 시 측정 오류로 보고 생략
- 착지 충격: 착지 속도 v = g·t/2, 충격량 = 체중 × v, 평균 착지 힘 = 1 + v/(g·흡수 시간) [×체중]. 흡수 시간은 착지부터 무릎 굽힘의 90%에 이르는 시간
- 착지 균형: 착지 후 1초 동안 몸통 각도 변화(°), 엉덩이 앞뒤 흔들림(cm), 정지 시간. 균형 점수 = 100 − 1.5×몸통 − 2.5×엉덩이(cm) − 2초 미만 정지 감점
신장·체중은 학생 휴대폰에만 저장되어 다음 업로드 때 자동으로 채워집니다.

### 2. ⏱ 직접 측정 활동 (포고 점프, 좌우 라인홉, 앞뒤 라인홉)
촬영하지 않고 친구가 시간·횟수를 재서 기록합니다. 기록지에 10초 타이머(3초 준비 후 시작, 끝나면 소리·진동)와 스톱워치가 있습니다.
- 포고: 10회 수행 + 발목 탄성 평가 · 라인홉: 10초 횟수, 20회 걸린 시간(→ 초당 횟수, 선 밟음은 세지 않음), 관찰 평가(잘함/보통/다시)

### 3. 영상 담벼락
모둠별로 영상이 모이고, 분석 화면 아래에서 다른 친구 영상에 피드백 댓글을 남깁니다.

### 4. 기록 게시판
기록지 아래 ‘기록 게시판에 올리기’로 기록(활동별 2~3개)과 한 줄 소감 또는 친구 피드백을 게시합니다. 활동별로 걸러 볼 수 있고, 올린 사람이 삭제할 수 있습니다.

같은 모둠원은 서로의 기록지를 채우고 게시할 수 있습니다. 모둠원은 이름순으로 돌아가며 운동 → 촬영/시간 재기 → 피드백·기록을 맡습니다.

필요한 SQL: `supabase/migrations/202611030002_record_board.sql` 하나(003·activity_records 내용 포함). 업로드 모둠 선택은 `202611020002_video_group_tag.sql`.
