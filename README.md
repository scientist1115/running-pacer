# 런페이서 (러너용 신호/횡단보도 회피 내비게이션) — Vercel 버전

## 배포 방법 (Vercel Drop — 넷리파이의 드래그 배포와 같은 방식)
1. https://vercel.com/drop 접속 (Vercel 계정 로그인 필요, 무료 Hobby 플랜으로 충분)
2. 이 zip 파일을 그대로 페이지에 드래그
3. 팀/프로젝트 이름 정하고 "Deploy" 클릭 → 몇 초 안에 주소가 생김
4. 방금 만들어진 프로젝트의 Settings > Environment Variables 에서
   `TMAP_APP_KEY`, `KAKAO_REST_KEY` 등록 (`.env.example` 참고)
5. 환경변수는 등록 후 "Redeploy" 한 번 해줘야 함수에 반영됨 (Deployments 탭 > 점 세 개 메뉴 > Redeploy)

## ⚠️ 주의: 업데이트할 때
Vercel Drop은 드롭할 때마다 **새 프로젝트**를 만들어요. 지금처럼 테스트하는 동안은 상관없지만,
기능을 추가해서 다시 배포하고 싶을 땐 같은 주소로 덮어쓰기가 안 되고 매번 새 주소가 생겨요.
계속 이어서 개발하기로 하면, 이 코드를 GitHub 저장소에 올리고 그 저장소를 Vercel 프로젝트에
연결하는 방식으로 바꾸는 걸 추천 — 그러면 이후엔 코드만 올려도 같은 주소로 자동 배포돼요.

## 지금까지 만든 것
- 앱 첫 실행(계정당 최초 1회) 시 셀카를 찍어서 지도 위 내 위치 마커로 사용 (로컬 저장, 서버 전송 없음).
  이미 찍어둔 사진이 있으면 다시 안 물어보고, 마이페이지에서 언제든 다시 찍을 수 있음
- 음성으로 "OO까지 3키로" / "5키로 달릴래" 말하면 경로 생성 시작
- **실제 3D 지도(MapLibre + OpenFreeMap, 키 필요 없음) 위에 경로와 건물을 그림** — 예전엔 2D
  평면 지도였는데, 이제 건물이 입체(3D 블록)로 세워져 있고, 카메라가 거의 지면 높이에서
  달리는 사람 시점으로 보임. 진행 방향이 항상 화면 위쪽을 향하도록 지도 자체가 회전하고,
  멈추면 화면도 같이 멈추고 움직이면 그 방향을 따라 다시 회전/이동함
- GPS로 실시간 이동 추적 → 지도 위 마커(얼굴 사진 + 방향 화살표) 이동, 남은거리/페이스/도착예정을 큰 글씨로 표시
- Tmap이 준 회전 지점(turns)에 실제로 가까워지면 그 안내 문구를 음성으로 말해줌 (예: "OO에서 우회전")
- 노래 저장(기기 로컬, IndexedDB) → 뛰기 시작하면 자동재생, 음성으로 "OO노래 틀어줘" 요청 가능
- Tmap 보행경로 / 카카오 장소검색을 Vercel 서버리스 함수(`/api`)로 프록시
- 목적지 없이 거리만 말하면, 근처 공원 후보 여러 곳 중 횡단보도(전국횡단보도표준데이터)와
  나쁜 노면(모래/흙/자갈, OpenStreetMap)이 가장 적은 경로를 골라줌
- 마이페이지에서 노래를 세 가지 방식으로 추가 가능: 내 파일 업로드 / 유튜브 검색 / Spotify 검색
  (Spotify는 로그인 연동 필요)
- 앱을 처음 열면 인트로 영상이 재생되고, 로그인 후에는 홈 화면이 뜸 — 홈 화면에는 "러닝 시작하기"
  버튼, 지난 러닝 경로를 모두 겹쳐서 보여주는 지도, 최근 페이스 그래프, 지난 기록 목록, 로그아웃
  버튼이 있음. 러닝이 끝나면(경로 진행률 98% 이상) 그 기록이 저장되고 잠시 후 홈 화면으로 돌아옴
- 목적지 없이 거리만 말했을 때는 "왕복"으로 바꿈 — 갈 때 경로를 그대로 뒤집어서 돌아오게 해서,
  가는 길/오는 길이 서로 다른 이상한 경로로 갈라지던 문제도 같이 해결됨
- 러닝 화면 아래에 "🛑 러닝 종료하기" 버튼 추가 — 목표거리 도착 전에도 언제든 직접 끝낼 수 있고,
  그때까지 뛴 만큼은 기록으로 저장됨
- 카메라를 내 위치보다 진행 방향으로 살짝 앞쪽에 띄워서, 마커가 화면 아래쪽에 오고 앞길이 넓게
  보이는 "로드뷰/러너 시점" 느낌을 더 강하게 냄
- GPS 위치 정확도(accuracy)가 안 좋은 값은 걸러내서, 가만히 있는데 흔들리는 위치값 때문에
  움직인 것처럼 페이스가 나오던 문제를 고침

## 유튜브/Spotify 음악 연동 설정
1. **유튜브**: Google Cloud Console에서 프로젝트 만들고 "YouTube Data API v3" 사용 설정 →
   사용자 인증 정보에서 API 키 발급 → `YOUTUBE_API_KEY` 환경변수에 등록
2. **Spotify**: developer.spotify.com/dashboard 에서 앱 생성 → Client ID 복사해서
   `js/spotify.js` 맨 위 `CLIENT_ID`에 붙여넣기 → 그 앱 설정의 Redirect URIs에
   지금 배포된 사이트 주소(예: `https://xxx.vercel.app/`)를 정확히 등록
3. Spotify 재생은 **Premium 계정**이 있어야 실제로 소리가 나옴 (무료 계정은 Web Playback SDK 제한)
4. 유튜브는 정책상 재생 화면이 완전히 안 보이게는 못 해서, 러닝 화면 왼쪽 아래에 작은 유튜브
   플레이어가 함께 떠 있음 (음악 감상용이라기보단 정책 준수를 위한 최소 크기)
5. ⚠️ Vercel Drop은 배포할 때마다 주소가 바뀌는데, Spotify의 Redirect URI는 정확히 등록된
   주소만 허용해서, 다시 배포할 때마다 이 설정도 같이 갱신해야 함. 이것 때문에라도 GitHub 연결
   방식으로 넘어가서 주소를 고정하는 걸 추천
6. Spotify 로그인 후 사이트로 돌아오면 화면이 새로고침되면서 목적지 설정 화면으로 이동함 —
   연결은 유지되니 마이페이지에 다시 들어가면 검색창이 나타남

## 아직 안 된 것 (다음 단계)
- **Firebase 설정 필요**: `js/auth.js` 맨 위 `firebaseConfig`가 아직 빈 값이라 지금 상태로는 로그인/회원가입이 작동하지 않음. 아래 "Firebase 설정" 순서대로 채워야 함.
- **횡단보도/노면 API 응답 형식 확인 필요**: `api/crosswalk-count.js`, `api/surface-check.js`를 실제로 연결해뒀지만, 공공데이터포털 API의 정확한 응답 구조(필드명)는 문서만으로 100% 확신할 수 없어서 실제 호출 결과를 보고 조정이 필요할 수 있음. `DATA_GO_KR_KEY` 환경변수 등록 후 실제로 몇 번 테스트해보면서 맞춰가야 함.
- **회전 안내 테스트는 실제로 걸어야 확인 가능**: 노트북/데스크탑 브라우저의 위치는 GPS가 아니라 와이파이
  기반 대략적 추정이라 거의 안 움직이는 걸로 잡혀서, 회전 지점 음성 안내가 실제로 트리거되는지는
  폰 들고 직접 걸어봐야 확인할 수 있음.
- 아이콘은 임시 플레이스홀더 (초록 원)로 채워둠.
- 음성 인식/합성은 iOS 사파리에서 일부 제약이 있을 수 있어 실기기 테스트 필요.

## Firebase 설정 (로그인/회원가입용)
1. https://console.firebase.google.com 에서 새 프로젝트 만들기 (무료)
2. 왼쪽 메뉴 Authentication > Sign-in method 에서 "이메일/비밀번호"와 "Google" 둘 다 사용 설정
3. 왼쪽 메뉴 Firestore Database > 데이터베이스 만들기 (테스트 모드로 시작 가능)
4. 프로젝트 설정(톱니바퀴) > 내 앱 > 웹 앱 추가 → 나오는 `firebaseConfig` 값을
   `js/auth.js` 맨 위에 그대로 붙여넣기
5. Authentication > Settings > 승인된 도메인에 배포된 Vercel 주소(예: xxx.vercel.app) 추가
   (안 하면 Google 로그인 팝업이 도메인 오류로 안 뜸)
6. 아이디/비밀번호는 내부적으로 `아이디@runpacer.local` 형식 가짜 이메일로 변환해서 Firebase에 저장됨 —
   실제 이메일 주소가 없어도 회원가입 가능
7. 아이디 중복확인은 `usernames/{아이디}` 문서 존재 여부로 확인함 (회원가입 시 `users/{uid}` 문서랑
   `usernames/{아이디}` 문서를 같이 만듦)
8. 올해 목표 거리는 회원가입 폼이 아니라 **가입 직후 별도 화면**에서 입력받음 (건너뛰기 가능,
   나중에 다시 설정 가능하도록 `Auth.saveGoal(uid, km)` 함수를 만들어둠)
9. 화면 위쪽에 항상 "올해 목표까지 OOkm 남음" 배너를 띄움 — `users/{uid}` 문서의 `goalKm`,
   `distanceRunKm` 필드로 계산하고, 러닝 중에는 진행 중인 거리도 실시간으로 반영함. 러닝이 끝나면
   (경로 진행률 98% 이상) 그 회차 거리를 `distanceRunKm`에 누적 저장함

## ⚠️ 지금 Firestore가 "테스트 모드"라면
테스트 모드는 30일 동안 아무나 읽고 쓸 수 있게 열어두는 임시 설정이에요. 실제로 서비스하려면
Firestore Database > 규칙 탭에서 아래처럼 바꿔주는 걸 추천:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
      match /runs/{runId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }
    match /usernames/{username} {
      allow get: if true; // 중복확인은 로그인 안 해도 가능해야 함
      allow create: if request.auth != null && request.auth.uid == request.resource.data.uid;
    }
  }
}
```

