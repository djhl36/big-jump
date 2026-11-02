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

## 수업 준비와 접근 한계

- 교사는 앱의 **교사 수업 관리**에서 관리 코드를 입력하고 수업, 모둠, 학생 명단을 만듭니다. 학생은 수업 코드 없이 사이트에서 이름만 선택하며, 가장 최근에 만든 수업에 자동으로 참여합니다. 이름은 최초 연결 기기가 선점합니다.
- 로그인 화면은 없으므로 익명 ID는 해당 브라우저 데이터와 기기에 묶입니다. 데이터 삭제·다른 기기 사용 시 교사가 명단 연결을 초기화해야 합니다. 이름 선택 방식은 실제 신원을 검증하지 않으며, 공유 코드가 외부로 퍼지면 타인이 이름을 먼저 선점할 가능성이 있습니다. 이름 선점 초기화 UI와 수업 종료 후 기록 삭제 기능은 다음 운영 단계에서 보강이 필요합니다.
- 학생 영상은 개인 정보가 포함될 수 있습니다. 학교·보호자 동의, 접근 대상, 보관·삭제 정책을 정한 뒤 실제 학생 영상으로 운영하세요.
- anon/publishable key는 브라우저에 공개되는 키이며 보안 경계가 아닙니다. 데이터 권한은 SQL RLS와 Edge Function에 둡니다. service-role key는 Supabase가 Edge Function 환경에 제공하며 앱에서 사용하지 않습니다.

## 빌드

```powershell
node build.mjs
```

빌드 산출물은 `dist/`입니다. `index.html`을 직접 더블클릭하는 로컬 `file://` 환경은 ES module, CDN 모델, Supabase Auth 동작이 제한될 수 있어 로컬 웹 서버나 호스팅 URL을 사용하세요.
