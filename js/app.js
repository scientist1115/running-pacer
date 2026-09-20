// 화면 전환 + 셀카 온보딩 + GPS 추적 + 통계 업데이트를 묶는 메인 컨트롤러
(function () {
  const FACE_KEY = 'run-pacer-face-photo';
  const COMEDY_KEY = 'run-pacer-comedy-mode';
  const VOICE_KEY = 'run-pacer-voice-key';
  const ARROW_MODE_KEY = 'run-pacer-arrow-mode'; // 'map' | 'ar'
  const NICKNAME_KEY = 'run-pacer-leaderboard-nickname';
  const ITEMS_KEY = 'run-pacer-items'; // localStorage: 보유한 아이템 id 배열(획득 순서 유지)
  let lastItemMilestone = 0; // 이번 러닝에서 마지막으로 아이템을 받은 거리(m)
  let itemPopupTimer = null;

  // 3km마다 러닝 중에 랜덤으로 하나씩 얻는 아이템 10종 - 슬롯별로 캐릭터에 장착돼서 보여짐
  const ITEM_CATALOG = [
    { id: 'headband', name: '머리띠', slot: 'head', color: '#FF6B5E' },
    { id: 'cap', name: '모자', slot: 'head', color: '#4FD8FF' },
    { id: 'sunglasses', name: '선글라스', slot: 'head', color: '#2C2C2C' },
    { id: 'waterbottle', name: '물병', slot: 'hand', color: '#4FA8FF' },
    { id: 'energydrink', name: '에너지드링크', slot: 'hand', color: '#FFB238' },
    { id: 'kneepads', name: '무릎보호대', slot: 'legs', color: '#8B5CF6' },
    { id: 'armsleeve', name: '팔토시', slot: 'arms', color: '#38E1FF' },
    { id: 'scarf', name: '목도리', slot: 'neck', color: '#FF9FB2' },
    { id: 'wristband', name: '손목밴드', slot: 'wrist', color: '#FFD60A' },
    { id: 'vest', name: '조끼', slot: 'torso', color: '#2BD97C' },
  ];

  function getOwnedItemIds() {
    try { return JSON.parse(localStorage.getItem(ITEMS_KEY) || '[]'); } catch { return []; }
  }

  // 슬롯별로 가장 최근에 얻은 아이템 하나만 "장착"된 걸로 취급 (같은 부위 여러 개면 최신 것만 보임)
  function getEquippedItems() {
    const owned = getOwnedItemIds();
    const equipped = {};
    owned.forEach((id) => {
      const item = ITEM_CATALOG.find((i) => i.id === id);
      if (item) equipped[item.slot] = item;
    });
    return equipped;
  }

  function showItemPopup(text) {
    const el = $('item-popup');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(itemPopupTimer);
    itemPopupTimer = setTimeout(() => el.classList.remove('show'), 3000);
  }

  // 3km 지점마다 호출됨 - 랜덤 아이템 하나를 주고, 이미 있으면 그렇다고 알려줌
  function awardRandomItem() {
    const item = ITEM_CATALOG[Math.floor(Math.random() * ITEM_CATALOG.length)];
    const owned = getOwnedItemIds();
    const already = owned.includes(item.id);
    if (!already) {
      owned.push(item.id);
      localStorage.setItem(ITEMS_KEY, JSON.stringify(owned));
    }
    showItemPopup(already ? `🎁 ${item.name} (이미 보유)` : `🎁 아이템 획득: ${item.name}!`);
    announce(already ? `${item.name}를 또 발견했어요` : `아이템을 획득했어요! ${item.name}`);
  }

  const NICK_ADJ = ['번개', '질풍', '폭풍', '무적', '씩씩한', '날쌘', '용감한', '유쾌한', '신비한', '화끈한', '조용한', '엉뚱한'];
  const NICK_NOUN = ['치타', '표범', '여우', '독수리', '다람쥐', '늑대', '호랑이', '사자', '토끼', '매', '거북이', '두더지'];
  function generateRandomNickname() {
    const adj = NICK_ADJ[Math.floor(Math.random() * NICK_ADJ.length)];
    const noun = NICK_NOUN[Math.floor(Math.random() * NICK_NOUN.length)];
    const num = Math.floor(Math.random() * 90) + 10;
    return `${adj}${noun}${num}`;
  }
  function getOrCreateNickname() {
    let nick = localStorage.getItem(NICKNAME_KEY);
    if (!nick) {
      nick = generateRandomNickname();
      localStorage.setItem(NICKNAME_KEY, nick);
    }
    return nick;
  }
  let arModeEnabled = false;
  let arStream = null;
  let arCtx = null;
  let arResizeHandler = null;
  let arUsingXr = false;
  let currentStream = null;
  let route = null;       // { points, distanceMeters, turns }
  let currentRouteOptions = []; // 신호등 개수별 대안 경로들 (경로가 준비된 화면에서 고를 수 있음)
  let mapHelper = null;   // route.js의 renderOnMap 결과 (MapLibre)
  let watchId = null;
  let elapsedTimer = null; // 러닝 중 경과시간(스톱워치) 1초마다 갱신하는 인터벌
  let lastPos = null;
  let traveledMeters = 0;
  let startedAt = null;
  let currentUser = null;
  let cachedProfile = null; // { goalKm, distanceRunKm, ... }
  let goalCountedForThisRun = false;
  let interactiveAuthInProgress = false;
  let onboardReturnScreen = 'screen-setup'; // 셀카 촬영 후 돌아갈 화면 (최초 가입 vs 마이페이지에서 변경)
  let profileReturnScreen = 'screen-home';  // 마이페이지 닫을 때 돌아갈 화면
  let announcedTurnCount = 0; // 지금까지 음성으로 안내한 회전 지점 개수
  let faceMarkerObj = null;  // MapLibre 마커 (얼굴 사진 + 방향 화살표)
  let currentBearing = 0;    // 현재 진행 방향(도) - 지도 회전 기준
  let compassHeading = null; // 나침반(자기센서)이 알려주는 실제 핸드폰이 향한 방향
  let orientationAttached = false;
  let lastKnownIsMoving = false;
  let lastCompassApply = 0;
  let homeMapObj = null;     // 홈 화면 지도(지난 경로 겹쳐보기) MapLibre 인스턴스
  let finishMapObj = null;   // 완료 화면 지도 MapLibre 인스턴스
  let paceSplits = [];       // 이번 러닝의 구간별 페이스 기록 (완료 화면 그래프용)
  let lastSplitMeters = 0;
  let lastSplitTime = 0;

  const $ = (id) => document.getElementById(id);
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(id).classList.add('active');
  }

  // 로그인/가입 직후 다음 화면으로 - 얼굴 사진이 이미 있으면 셀카 화면 건너뛰고 홈으로
  function goToPostAuthFlow() {
    if (localStorage.getItem(FACE_KEY)) {
      showScreen('screen-home');
      loadHomeScreen();
    } else {
      onboardReturnScreen = 'screen-home';
      showScreen('screen-onboard');
      startCamera();
    }
  }

  // 올해 목표 대비 남은 거리를 화면 위쪽 배너에 표시
  function refreshGoalHeader() {
    const header = $('goal-header');
    if (!cachedProfile || !cachedProfile.goalKm) {
      header.classList.add('hidden');
      return;
    }
    const storedKm = cachedProfile.distanceRunKm || 0;
    const liveExtraKm = goalCountedForThisRun ? 0 : traveledMeters / 1000;
    const remaining = Math.max(cachedProfile.goalKm - storedKm - liveExtraKm, 0);
    header.textContent = `올해 목표까지 ${remaining.toFixed(1)}km 남음`;
    header.classList.remove('hidden');
  }

  /* ---------------- 1. 셀카 온보딩 ---------------- */
  async function startCamera() {
    try {
      currentStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      $('camera-preview').srcObject = currentStream;
    } catch (e) {
      console.warn('카메라 접근 실패, 건너뛰기로 진행', e);
    }
  }

  function stopCamera() {
    currentStream?.getTracks().forEach((t) => t.stop());
  }

  function shootSelfie() {
    const video = $('camera-preview');
    const canvas = $('selfie-canvas');
    const ctx = canvas.getContext('2d');
    const size = Math.min(video.videoWidth, video.videoHeight);
    ctx.drawImage(
      video,
      (video.videoWidth - size) / 2, (video.videoHeight - size) / 2, size, size,
      0, 0, canvas.width, canvas.height
    );
    video.classList.add('hidden');
    canvas.classList.remove('hidden');
    $('btn-shoot').classList.add('hidden');
    $('btn-retake').classList.remove('hidden');
    $('btn-confirm').classList.remove('hidden');
  }

  function confirmSelfie() {
    const dataUrl = $('selfie-canvas').toDataURL('image/jpeg', 0.7);
    localStorage.setItem(FACE_KEY, dataUrl);
    stopCamera();
    showScreen(onboardReturnScreen);
    if (onboardReturnScreen === 'screen-profile') refreshProfileScreen();
    if (onboardReturnScreen === 'screen-home') loadHomeScreen();
  }

  function retakeSelfie() {
    $('selfie-canvas').classList.add('hidden');
    $('camera-preview').classList.remove('hidden');
    $('btn-shoot').classList.remove('hidden');
    $('btn-retake').classList.add('hidden');
    $('btn-confirm').classList.add('hidden');
  }

  /* ---------------- 1-1. 마이페이지 ---------------- */
  function refreshProfileScreen() {
    const face = localStorage.getItem(FACE_KEY);
    $('profile-face-preview').src = face || '';
    $('profile-goal-input').value = cachedProfile?.goalKm || '';
    $('profile-comedy-toggle').checked = localStorage.getItem(COMEDY_KEY) === '1';
    $('profile-nickname-display').textContent = getOrCreateNickname();
    renderVoiceChips();
    renderArrowModeChips();
    if (currentUser) {
      Auth.isPublished(currentUser.uid).then((pub) => {
        $('profile-publish-toggle').checked = pub;
      }).catch(() => {});
    }
  }

  // 안내 목소리 선택 칩(기본 + 캐릭터들)을 그리고, 누르면 바로 그 목소리로 미리듣기함
  function renderVoiceChips() {
    const savedKey = localStorage.getItem(VOICE_KEY) || null;
    const chipsEl = $('voice-select-chips');
    chipsEl.innerHTML = '';
    const options = [{ key: null, label: '기본(무료)' }, ...Voice.getVoiceOptions()];
    options.forEach((opt) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'crosswalk-chip' + (opt.key === savedKey ? ' active' : '');
      chip.textContent = opt.label;
      chip.addEventListener('click', () => {
        localStorage.setItem(VOICE_KEY, opt.key || '');
        Voice.setVoiceKey(opt.key);
        renderVoiceChips();
        Voice.speak(`안녕하세요, ${opt.label} 목소리예요`);
      });
      chipsEl.appendChild(chip);
    });
  }

  // 화살표 표시 방식(지도 / AR 카메라) 선택 칩 - 실제 카메라 시작/종료는 러닝 시작/종료 시점에 함
  function renderArrowModeChips() {
    const savedMode = localStorage.getItem(ARROW_MODE_KEY) === 'ar' ? 'ar' : 'map';
    const chipsEl = $('arrow-mode-chips');
    chipsEl.innerHTML = '';
    const options = [{ key: 'map', label: '지도' }, { key: 'ar', label: 'AR 카메라' }];
    options.forEach((opt) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'crosswalk-chip' + (opt.key === savedMode ? ' active' : '');
      chip.textContent = opt.label;
      chip.addEventListener('click', () => {
        localStorage.setItem(ARROW_MODE_KEY, opt.key);
        arModeEnabled = opt.key === 'ar';
        renderArrowModeChips();
      });
      chipsEl.appendChild(chip);
    });
  }

  /* ---------------- 2. 목적지/거리 설정 ---------------- */
  function announce(text) {
    Voice.speak(text);
    const el = $('voice-caption-text');
    if (el) el.textContent = text;
  }

  function handleSetupVoice(transcript) {
    const cmd = Voice.parseCommand(transcript);
    if (cmd.type === 'unknown') {
      announce('잘 못 들었어요. 다시 한 번 말해주세요.');
      return;
    }
    prepareRoute(cmd);
  }

  // 카운트다운 후 실제로 GPS 추적을 시작함 (경로는 이미 준비되어 화면에 그려진 상태)
  function runCountdown() {
    showScreen('screen-countdown');
    let n = 3;
    $('countdown-num').textContent = n;
    const timer = setInterval(() => {
      n -= 1;
      if (n > 0) {
        $('countdown-num').textContent = n;
      } else {
        clearInterval(timer);
        showScreen('screen-run');
        startedAt = Date.now();
        traveledMeters = 0;
        goalCountedForThisRun = false;
        announcedTurnCount = 0;
        paceSplits = [];
        lastSplitMeters = 0;
        lastSplitTime = Date.now();
        lastItemMilestone = 0;
        announce('출발할게요.');
        Music.startForRun();
        startGpsTracking();
        if (arModeEnabled) startArCamera();
        if (elapsedTimer) clearInterval(elapsedTimer);
        updateElapsedDisplay();
        elapsedTimer = setInterval(updateElapsedDisplay, 1000);
      }
    }, 900);
  }

  // 러닝 중 경과시간을 mm:ss(1시간 넘으면 h:mm:ss)로 화면에 표시 - GPS 신호와 무관하게 1초마다 갱신
  function updateElapsedDisplay() {
    if (!startedAt) return;
    const totalSec = Math.max(Math.floor((Date.now() - startedAt) / 1000), 0);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const text = h > 0
      ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
      : `${m}:${s.toString().padStart(2, '0')}`;
    const el = $('stat-elapsed');
    if (el) el.textContent = text;
  }

  // 실제 나침반(자기센서) 방향을 읽어서, 가만히 서서 몸만 돌려도 지도가 같이 돌게 함
  function attachCompass() {
    if (orientationAttached) return;
    orientationAttached = true;
    const handler = (e) => {
      let heading = null;
      if (typeof e.webkitCompassHeading === 'number') {
        heading = e.webkitCompassHeading; // iOS: 0=북, 시계방향으로 증가
      } else if (e.absolute && typeof e.alpha === 'number') {
        heading = (360 - e.alpha) % 360; // 안드로이드 근사치
      }
      if (heading === null) return;
      compassHeading = heading;

      const now = Date.now();
      if (now - lastCompassApply < 100) return; // 너무 잦은 갱신은 성능상 스킵
      lastCompassApply = now;
      currentBearing = heading;

      // 멈춰 서 있을 때는 위치 이동 없이 방향만 바로 반영 (몸을 돌리면 지도도 즉시 도는 느낌)
      if (!lastKnownIsMoving && mapHelper) {
        mapHelper.map.setBearing(heading);
      }
      // AR 모드면 GPS 갱신을 기다리지 않고 방향이 바뀔 때마다 바로 다시 그림 -
      // 안 그러면 제자리에서 몸만 돌렸을 때 다음 GPS 신호가 올 때까지 화살표가 그대로 있게 됨
      if (arModeEnabled && lastPos) {
        if (arUsingXr) ArXR.updatePath(getLookaheadPathPoints());
        else updateArOverlay(lastPos, heading);
      }
    };
    window.addEventListener('deviceorientationabsolute', handler, true);
    window.addEventListener('deviceorientation', handler, true);
  }

  // iOS는 센서 접근에 사용자 탭이 필요해서, 버튼 누르는 시점에 같이 요청함
  function requestCompassPermission() {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().then((state) => {
        if (state === 'granted') attachCompass();
      }).catch(() => {});
    } else {
      attachCompass();
    }
  }

  // 경로를 조회해서 화면에 그려두기만 함 (GPS 추적은 "러닝 시작" 버튼을 눌러야 시작됨)
  async function prepareRoute(cmd) {
    showScreen('screen-run');
    announce('경로를 준비하고 있어요.');
    faceMarkerObj = null;
    traveledMeters = 0;
    $('turn-banner').classList.add('hidden');
    $('btn-start-run').classList.add('hidden');
    $('route-ready-sub').textContent = '경로가 준비됐어요';
    $('crosswalk-selector').classList.add('hidden');
    currentRouteOptions = [];

    navigator.geolocation.getCurrentPosition(async (pos) => {
      const start = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      lastPos = start; // 검색 기준점을 내 실제 현재 위치로 즉시 반영
      try {
        if (cmd.type === 'destination_with_distance') {
          const dest = await geocode(cmd.destination, start);
          route = await RouteEngine.buildRouteToDestination(start, dest, cmd.distance);
        } else if (cmd.type === 'distance_only') {
          route = await RouteEngine.buildLoopRoute(start, cmd.distance);
        } else if (cmd.type === 'destination_only') {
          const dest = await geocode(cmd.destination, start);
          route = await RouteEngine.fetchWalkRoute(start, dest);
        }
        mapHelper = RouteEngine.renderOnMap($('map-canvas'), route.points, mapHelper?.map);
        currentBearing = mapHelper.initialBearing || 0;
        updateMarker(0, currentBearing, false);
        $('stat-distance').textContent = (route.distanceMeters / 1000).toFixed(1) + 'km';

        // 경로가 이미 채점된 경우(공원 경유/왕복 후보 비교) crosswalkCount/crosswalkDataOk가 붙어있고,
        // 직선 경로 그대로 쓴 경우엔 여기서 한 번 계산해서 시작 전에 미리 보여줌
        let crosswalkCount = route.crosswalkCount;
        let crosswalkDataOk = route.crosswalkDataOk;
        if (typeof crosswalkCount !== 'number') {
          const result = await RouteEngine.countCrosswalksNear(route.points);
          crosswalkCount = result.count;
          crosswalkDataOk = result.ok;
        }
        route.crosswalkCount = crosswalkCount;
        route.crosswalkDataOk = crosswalkDataOk;

        const readySub = !crosswalkDataOk
          ? '횡단보도 정보를 확인하지 못했어요 - 직접 살펴보며 뛰어주세요'
          : crosswalkCount === 0
            ? '횡단보도 없이 갈 수 있어요'
            : `횡단보도 ${crosswalkCount}회 예상돼요`;
        $('route-ready-sub').textContent = readySub;
        renderCrosswalkOptions(route);

        announce(!crosswalkDataOk
          ? '경로 준비됐어요. 이번엔 횡단보도 정보를 확인하지 못했어요. 직접 살펴보며 뛰어주세요. 시작 버튼을 눌러주세요.'
          : crosswalkCount === 0
            ? '경로 준비됐어요. 횡단보도 없이 갈 수 있어요. 시작 버튼을 눌러주세요.'
            : `경로 준비됐어요. 횡단보도 ${crosswalkCount}번 건너요. 시작 버튼을 눌러주세요.`);
        $('btn-start-run').classList.remove('hidden');
      } catch (e) {
        announce('경로를 만드는 데 실패했어요. ' + e.message);
      }
    }, () => announce('위치 정보를 가져올 수 없어요. GPS를 켜주세요.'), { enableHighAccuracy: true });
  }

  // 채점된 대안 경로들(있다면)을 신호등 개수 기준으로 중복 없이 정리해서 칩으로 보여줌.
  // 대안이 1개뿐이면(선택할 게 없으면) UI 자체를 숨김.
  function renderCrosswalkOptions(chosenRoute) {
    const rawOptions = chosenRoute.routeOptions?.length ? chosenRoute.routeOptions : [chosenRoute];
    const seen = new Set();
    const options = [];
    for (const opt of rawOptions) {
      const ok = opt.crosswalkDataOk !== false; // true/undefined면 성공으로 간주(구버전 경로 호환)
      const count = typeof opt.crosswalkCount === 'number' ? opt.crosswalkCount : chosenRoute.crosswalkCount;
      const key = ok ? `c${count}` : 'failed'; // 실패한 후보들은 전부 하나의 "확인불가" 옵션으로 묶음
      if (seen.has(key)) continue; // 같은 개수면 이미 더 좋은 점수의 후보가 앞에 있었던 것
      seen.add(key);
      options.push({ ...opt, crosswalkCount: count, crosswalkDataOk: ok });
    }
    options.sort((a, b) => {
      if (a.crosswalkDataOk !== b.crosswalkDataOk) return a.crosswalkDataOk ? -1 : 1; // 확인된 것 먼저, 확인불가는 맨 뒤
      return a.crosswalkCount - b.crosswalkCount;
    });
    currentRouteOptions = options;

    const box = $('crosswalk-selector');
    const chipsEl = $('crosswalk-selector-chips');
    chipsEl.innerHTML = '';
    if (options.length <= 1) {
      box.classList.add('hidden');
      return;
    }
    options.forEach((opt) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'crosswalk-chip' + (opt.crosswalkCount === chosenRoute.crosswalkCount ? ' active' : '');
      chip.textContent = opt.crosswalkDataOk === false ? '확인불가' : (opt.crosswalkCount === 0 ? '0회' : `${opt.crosswalkCount}회`);
      chip.addEventListener('click', () => applyRouteOption(opt));
      chipsEl.appendChild(chip);
    });
    box.classList.remove('hidden');
  }

  // 사용자가 칩을 눌러 다른 신호등 개수의 경로를 고른 경우: 실제 진행 경로를 바꿔치기하고 지도/안내를 다시 그림
  function applyRouteOption(opt) {
    route = opt;
    mapHelper = RouteEngine.renderOnMap($('map-canvas'), route.points, mapHelper?.map);
    currentBearing = mapHelper.initialBearing || 0;
    updateMarker(0, currentBearing, false);
    $('stat-distance').textContent = (route.distanceMeters / 1000).toFixed(1) + 'km';
    $('route-ready-sub').textContent = opt.crosswalkDataOk === false
      ? '횡단보도 정보를 확인하지 못했어요 - 직접 살펴보며 뛰어주세요'
      : opt.crosswalkCount === 0
        ? '횡단보도 없이 갈 수 있어요'
        : `횡단보도 ${opt.crosswalkCount}회 예상돼요`;
    renderCrosswalkOptions(route);
    announce(opt.crosswalkDataOk === false
      ? '횡단보도 정보를 확인 못하는 경로로 바꿨어요.'
      : opt.crosswalkCount === 0
        ? '횡단보도 없는 경로로 바꿨어요.'
        : `횡단보도 ${opt.crosswalkCount}회인 경로로 바꿨어요.`);
  }

  async function geocode(placeName, center) {
    // Kakao 검색으로 지명 -> 좌표 변환 (반드시 실제 현재 위치를 기준으로 검색)
    const results = await RouteEngine.searchNearby(placeName, center || lastPos);
    if (!results.length) throw new Error(`"${placeName}"을(를) 못 찾았어요`);
    // 기본은 거리순 첫 결과지만, 이름이 정확히 같은(공백 무시) 곳이 있으면 그게 더 가깝지 않아도 우선함
    // - 예: "과천역"을 찾았는데 이름만 비슷한 훨씬 가까운 다른 곳이 걸려서 엉뚱한 곳으로 안내되는 걸 방지
    const normalize = (s) => (s || '').replace(/\s/g, '').toLowerCase();
    const target = normalize(placeName);
    const exact = results.find((r) => normalize(r.name) === target);
    const picked = exact || results[0];
    console.log(`[목적지 검색] "${placeName}" -> "${picked.name}" (${picked.lat}, ${picked.lng})`, results);
    return { lat: picked.lat, lng: picked.lng };
  }

  /* ---------------- 3. GPS 추적 + 마커/음악 연동 ---------------- */
  function startGpsTracking() {
    watchId = navigator.geolocation.watchPosition(onGpsUpdate, console.warn, {
      enableHighAccuracy: true, maximumAge: 1000, timeout: 5000,
    });
  }

  function onGpsUpdate(pos) {
    const cur = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    const accuracy = pos.coords.accuracy || 999; // 미터 단위 오차 반경
    const speed = pos.coords.speed || 0; // m/s

    // 위치 정확도가 아주 나쁘면(100m 넘으면, 거의 못 쓰는 수준) 이번 값은 건너뜀.
    // 30m 기준은 고층건물 많은 지역(예: 과천지식정보타운)에서 대부분의 위치가 버려져서
    // 거리가 거의 안 잡히는 문제가 있었음 - 100m로 완화하고, 대신 noiseFloor로 흔들림을 거름
    if (accuracy > 100) return;

    const movedMeters = lastPos ? haversine(lastPos, cur) : 0;
    const noiseFloor = Math.max(5, accuracy * 0.8); // 정확도가 나쁠수록 더 크게 움직여야 "진짜 이동"으로 침
    const isRealMovement = lastPos ? movedMeters > noiseFloor : false;
    const isMoving = speed > 0.3 || isRealMovement;

    if (isRealMovement) traveledMeters += movedMeters;
    if (traveledMeters - lastItemMilestone >= 3000) {
      lastItemMilestone = Math.floor(traveledMeters / 3000) * 3000;
      awardRandomItem();
    }

    // 방향: 나침반이 있으면 그걸 최우선으로(제일 반응이 빠름), 없으면 기기 heading,
    // 그것도 없으면 직전 위치 대비 이동 방향으로 계산
    if (isMoving) {
      if (compassHeading !== null) {
        currentBearing = compassHeading;
      } else if (typeof pos.coords.heading === 'number' && !Number.isNaN(pos.coords.heading)) {
        currentBearing = pos.coords.heading;
      } else if (isRealMovement) {
        currentBearing = RouteEngine.computeBearing(lastPos, cur);
      }
    }
    lastKnownIsMoving = isMoving;

    lastPos = cur;
    Music.onSpeedUpdate(speed);

    // 250m마다 그 구간 페이스를 기록해서 완료 화면 그래프에 씀
    if (traveledMeters - lastSplitMeters >= 250) {
      const segKm = (traveledMeters - lastSplitMeters) / 1000;
      const segMin = (Date.now() - lastSplitTime) / 60000;
      if (segKm > 0 && segMin > 0) paceSplits.push(segMin / segKm);
      lastSplitMeters = traveledMeters;
      lastSplitTime = Date.now();
    }

    const progress = route ? Math.min(traveledMeters / route.distanceMeters, 1) : 0;
    updateMarker(progress, currentBearing, isMoving);
    if (arModeEnabled) {
      if (arUsingXr) ArXR.updatePath(getLookaheadPathPoints());
      else updateArOverlay(cur, currentBearing);
    }
    updateStats(progress, speed);
    refreshGoalHeader();
    checkUpcomingTurn(cur);

    if (progress >= 0.98 && !goalCountedForThisRun && currentUser) {
      goalCountedForThisRun = true;
      finishRun(false);
    }
  }

  // 러닝 완료 처리: 누적거리/기록 저장하고 완료 요약 화면을 보여줌
  // manual=true면 목표거리 도착 전에 사용자가 직접 "종료하기"를 누른 경우
  function finishRun(manual) {
    if (watchId) navigator.geolocation.clearWatch(watchId);
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    stopArCamera();
    const km = traveledMeters / 1000;
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    const elapsedMin = elapsedSec / 60;
    const paceMinPerKm = km > 0.05 ? elapsedMin / km : 0;

    if (currentUser && km > 0.02) {
      Auth.addDistance(currentUser.uid, km).then(() => {
        cachedProfile.distanceRunKm = (cachedProfile.distanceRunKm || 0) + km;
        refreshGoalHeader();
      }).catch(console.warn);

      Auth.saveRun(currentUser.uid, {
        points: route?.points || [],
        distanceKm: km,
        durationSec: elapsedSec,
        paceMinPerKm,
      }).then(() => Auth.isPublished(currentUser.uid)).then((pub) => {
        if (!pub) return;
        return Auth.publishLeaderboard(currentUser.uid, getOrCreateNickname());
      }).catch(console.warn);
    }

    announce(manual ? '러닝을 종료했어요. 수고했어요.' : '목표 거리에 도착했어요! 수고했어요.');
    Music.pause();

    showFinishScreen({ km, elapsedSec, paceMinPerKm });
  }

  function showFinishScreen({ km, elapsedSec, paceMinPerKm }) {
    $('finish-title').textContent = '오늘의 러닝 완료!';
    $('finish-distance').textContent = km.toFixed(2) + 'km';
    const min = Math.floor(elapsedSec / 60), sec = elapsedSec % 60;
    $('finish-duration').textContent = `${min}:${sec.toString().padStart(2, '0')}`;
    if (paceMinPerKm > 0) {
      const pMin = Math.floor(paceMinPerKm);
      const pSec = Math.round((paceMinPerKm - pMin) * 60);
      $('finish-pace').textContent = `${pMin}'${pSec.toString().padStart(2, '0')}"`;
    } else {
      $('finish-pace').textContent = '-';
    }

    // 오늘 뛴 경로 지도로 보여주기 - 시작/종료 마커 + 1km마다 거리 핀
    const container = $('finish-map');
    if (finishMapObj) { finishMapObj.remove(); finishMapObj = null; }
    container.innerHTML = '';
    if (route?.points?.length > 1) {
      const coords = route.points.map((p) => [p.lng, p.lat]);
      const lons = coords.map((c) => c[0]), lats = coords.map((c) => c[1]);
      finishMapObj = new maplibregl.Map({
        container, style: 'https://tiles.openfreemap.org/styles/bright',
        center: coords[0], zoom: 14, pitch: 0, interactive: false, attributionControl: false,
      });
      finishMapObj.on('load', () => {
        finishMapObj.addSource('finish-route', {
          type: 'geojson',
          data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } },
        });
        finishMapObj.addLayer({
          id: 'finish-route-line', type: 'line', source: 'finish-route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#2BD97C', 'line-width': 6 },
        });

        // 시작(초록) / 종료(빨강) 점
        new maplibregl.Marker({ color: '#2BD97C' }).setLngLat(coords[0]).addTo(finishMapObj);
        new maplibregl.Marker({ color: '#FF6B5E' }).setLngLat(coords[coords.length - 1]).addTo(finishMapObj);

        // 1km마다 거리 핀 (나이키 런 클럽처럼 "1 km" 알약 라벨)
        const totalKm = Math.floor(km);
        for (let i = 1; i <= totalKm; i++) {
          const pt = pointsAlongRoute(route.points, [i * 1000])[0];
          if (!pt) continue;
          const el = document.createElement('div');
          el.className = 'map-km-pill';
          el.textContent = `${i} km`;
          new maplibregl.Marker({ element: el }).setLngLat([pt.lng, pt.lat]).addTo(finishMapObj);
        }

        finishMapObj.fitBounds(
          [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
          { padding: 28, duration: 0 }
        );
      });
    }

    // 페이스 분석 대시보드 - A) 거리별 페이스, B) 페이스 분포 히스토그램, C) 최근 기록과 비교
    const analysisContainer = $('finish-pace-analysis');
    if (paceSplits.length < 2) {
      $('finish-chart-a').innerHTML = '<p class="onboard-sub" style="padding:8px 0;">그래프를 그리기엔 너무 짧게 뛰었어요</p>';
      $('finish-chart-b').innerHTML = '';
      $('finish-chart-c').innerHTML = '';
      analysisContainer.innerHTML = '';
    } else {
      const formatPace = (p) => `${Math.floor(p)}'${Math.round((p - Math.floor(p)) * 60).toString().padStart(2, '0')}"`;
      const avg = paceSplits.reduce((a, b) => a + b, 0) / paceSplits.length;
      const minP = Math.min(...paceSplits);
      const maxP = Math.max(...paceSplits);
      const worstIdx = paceSplits.indexOf(maxP);
      const bestIdx = paceSplits.indexOf(minP);
      const range = maxP - minP || 1;

      // A) 거리별 페이스 - 영역그래프 + 격자선 + 축 라벨 (빠를수록 위로 오게 그림)
      {
        const W = 320, H = 120, PADL = 34, PADR = 8, PADT = 10, PADB = 18;
        const plotW = W - PADL - PADR, plotH = H - PADT - PADB;
        const n = paceSplits.length;
        const yFor = (p) => PADT + (1 - (p - minP) / range) * plotH;
        const xFor = (i) => PADL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
        const linePts = paceSplits.map((p, i) => `${xFor(i).toFixed(1)},${yFor(p).toFixed(1)}`).join(' ');
        const areaPts = `${xFor(0).toFixed(1)},${(PADT + plotH).toFixed(1)} ${linePts} ${xFor(n - 1).toFixed(1)},${(PADT + plotH).toFixed(1)}`;
        const gridLines = [0, 0.5, 1].map((t) => {
          const y = PADT + t * plotH;
          const pace = maxP - t * range;
          return `<line x1="${PADL}" y1="${y.toFixed(1)}" x2="${W - PADR}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
                  <text x="${PADL - 5}" y="${(y + 3).toFixed(1)}" font-size="8.5" fill="var(--mute)" text-anchor="end">${formatPace(pace)}</text>`;
        }).join('');
        const xLabels = `<text x="${PADL}" y="${H - 3}" font-size="8.5" fill="var(--mute)">0km</text>
          <text x="${W - PADR}" y="${H - 3}" font-size="8.5" fill="var(--mute)" text-anchor="end">${(n * 0.25).toFixed(2)}km</text>`;
        $('finish-chart-a').innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%">
          ${gridLines}
          <polygon points="${areaPts}" fill="var(--go)" opacity="0.18"/>
          <polyline points="${linePts}" fill="none" stroke="var(--go)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="${xFor(worstIdx).toFixed(1)}" cy="${yFor(maxP).toFixed(1)}" r="4" fill="var(--amber)"/>
          <circle cx="${xFor(bestIdx).toFixed(1)}" cy="${yFor(minP).toFixed(1)}" r="4" fill="#4FE3A0"/>
          ${xLabels}
        </svg>`;
      }

      // B) 페이스 분포 히스토그램 - 15초 단위로 구간을 나눠서 각 구간에 몇 개 세그먼트가 있었는지
      {
        const binSec = 15;
        const bins = {};
        paceSplits.forEach((p) => {
          const key = Math.floor((p * 60) / binSec) * binSec; // 초 단위로 반올림한 구간 시작점
          bins[key] = (bins[key] || 0) + 1;
        });
        const keys = Object.keys(bins).map(Number).sort((a, b) => a - b);
        const maxCount = Math.max(...keys.map((k) => bins[k]));
        const W = 320, H = 100, PADL = 10, PADR = 10, PADT = 10, PADB = 24;
        const plotW = W - PADL - PADR, plotH = H - PADT - PADB;
        const barGap = 3;
        const barW = keys.length ? plotW / keys.length - barGap : 0;
        const bars = keys.map((k, i) => {
          const count = bins[k];
          const h = (count / maxCount) * plotH;
          const x = PADL + i * (plotW / keys.length);
          const y = PADT + plotH - h;
          const label = `${Math.floor(k / 60)}'${(k % 60).toString().padStart(2, '0')}"`;
          return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="var(--go)" opacity="0.8"/>
            <text x="${(x + barW / 2).toFixed(1)}" y="${H - 6}" font-size="7.5" fill="var(--mute)" text-anchor="middle">${label}</text>`;
        }).join('');
        $('finish-chart-b').innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%">
          <text x="${W - PADR}" y="${PADT}" font-size="8.5" fill="var(--mute)" text-anchor="end">n=${paceSplits.length}</text>
          ${bars}
        </svg>`;
      }

      // C) 최근 기록과 비교 - 오늘 평균 vs 최근 기록들 평균(오차막대: 표준편차). 데이터는 비동기로 채움
      $('finish-chart-c').innerHTML = '<p class="onboard-sub" style="padding:8px 0; font-size:12.5px;">최근 기록 불러오는 중…</p>';
      if (currentUser) {
        Auth.listRuns(currentUser.uid, 8).then((runs) => {
          // 방금 저장된 오늘 기록(몇 초 이내)은 "최근 기록"에서 제외하고 비교함
          const now = Date.now();
          const past = runs.filter((r) => {
            const t = r.completedAt?.toDate ? r.completedAt.toDate().getTime() : 0;
            return now - t > 120000 && r.paceMinPerKm > 0;
          });
          if (past.length < 2) {
            $('finish-chart-c').innerHTML = '<p class="onboard-sub" style="padding:8px 0; font-size:12.5px;">비교할 만한 이전 기록이 아직 부족해요</p>';
            return;
          }
          const pastPaces = past.map((r) => r.paceMinPerKm);
          const pastAvg = pastPaces.reduce((a, b) => a + b, 0) / pastPaces.length;
          const variance = pastPaces.reduce((a, b) => a + (b - pastAvg) ** 2, 0) / pastPaces.length;
          const stdDev = Math.sqrt(variance);

          const W = 320, H = 130, PADL = 34, PADR = 60, PADT = 14, PADB = 22;
          const plotH = H - PADT - PADB;
          const allVals = [avg, pastAvg - stdDev, pastAvg + stdDev];
          const cMin = Math.min(...allVals) * 0.95;
          const cMax = Math.max(...allVals) * 1.05;
          const cRange = cMax - cMin || 1;
          const yFor = (p) => PADT + (1 - (p - cMin) / cRange) * plotH;
          const barW = 60;
          const x1 = 70, x2 = 190;
          const y1 = yFor(avg), y2 = yFor(pastAvg);
          const errTop = yFor(pastAvg + stdDev), errBot = yFor(pastAvg - stdDev);
          $('finish-chart-c').innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%">
            <line x1="${PADL}" y1="${(PADT + plotH).toFixed(1)}" x2="${W - PADR}" y2="${(PADT + plotH).toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
            <rect x="${x1 - barW / 2}" y="${y1.toFixed(1)}" width="${barW}" height="${(PADT + plotH - y1).toFixed(1)}" rx="4" fill="var(--amber)"/>
            <text x="${x1}" y="${(y1 - 6).toFixed(1)}" font-size="10.5" fill="var(--paper)" text-anchor="middle" font-weight="700">${formatPace(avg)}</text>
            <text x="${x1}" y="${H - 6}" font-size="9" fill="var(--mute)" text-anchor="middle">오늘</text>
            <rect x="${x2 - barW / 2}" y="${y2.toFixed(1)}" width="${barW}" height="${(PADT + plotH - y2).toFixed(1)}" rx="4" fill="var(--go)"/>
            <line x1="${x2}" y1="${errTop.toFixed(1)}" x2="${x2}" y2="${errBot.toFixed(1)}" stroke="var(--paper)" stroke-width="1.5"/>
            <line x1="${x2 - 6}" y1="${errTop.toFixed(1)}" x2="${x2 + 6}" y2="${errTop.toFixed(1)}" stroke="var(--paper)" stroke-width="1.5"/>
            <line x1="${x2 - 6}" y1="${errBot.toFixed(1)}" x2="${x2 + 6}" y2="${errBot.toFixed(1)}" stroke="var(--paper)" stroke-width="1.5"/>
            <text x="${x2}" y="${(y2 - 6).toFixed(1)}" font-size="10.5" fill="var(--paper)" text-anchor="middle" font-weight="700">${formatPace(pastAvg)}</text>
            <text x="${x2}" y="${H - 6}" font-size="9" fill="var(--mute)" text-anchor="middle">최근 ${past.length}회 평균</text>
            <text x="${W - PADR + 4}" y="${PADT + 4}" font-size="8" fill="var(--mute)">n=${past.length}</text>
          </svg>`;
        }).catch(() => {
          $('finish-chart-c').innerHTML = '<p class="onboard-sub" style="padding:8px 0; font-size:12.5px;">비교 데이터를 못 불러왔어요</p>';
        });
      } else {
        $('finish-chart-c').innerHTML = '';
      }

      const rows = [];
      if (maxP > avg * 1.1) {
        const startKm = (worstIdx * 0.25).toFixed(2);
        const endKm = ((worstIdx + 1) * 0.25).toFixed(2);
        const diffSec = Math.round((maxP - avg) * 60);
        rows.push(`<div class="row"><span class="dot" style="background:var(--amber)"></span><span class="text"><b>${startKm}~${endKm}km</b> 구간에서 가장 처졌어요 - 평균보다 <b>${diffSec}초/km</b> 느렸어요 (${formatPace(maxP)}/km)</span></div>`);
      }
      if (minP < avg * 0.9) {
        const startKm = (bestIdx * 0.25).toFixed(2);
        const endKm = ((bestIdx + 1) * 0.25).toFixed(2);
        rows.push(`<div class="row"><span class="dot" style="background:#4FE3A0"></span><span class="text"><b>${startKm}~${endKm}km</b> 구간이 가장 빨랐어요 (${formatPace(minP)}/km)</span></div>`);
      }
      rows.push(`<div class="row"><span class="dot" style="background:var(--mute)"></span><span class="text">전체 평균 페이스는 <b>${formatPace(avg)}/km</b>였어요</span></div>`);
      analysisContainer.innerHTML = rows.join('');
    }

    showScreen('screen-finish');
  }

  // 다음 회전 지점에 가까워지면 그 안내 문구를 말해줌 (Tmap이 준 turns 좌표 기준)
  function checkUpcomingTurn(currentPos) {
    if (!route?.turns?.length || announcedTurnCount >= route.turns.length) {
      $('turn-banner').classList.add('hidden');
      return;
    }
    const next = route.turns[announcedTurnCount];
    if (!next.lat || !next.lng) { announcedTurnCount++; return; }
    const dist = haversine(currentPos, next);
    const desc = next.description || '방향 전환';

    // 배너는 매번 최신 거리로 갱신해서 항상 다음 회전까지 얼마나 남았는지 보여줌
    $('turn-dist').textContent = `${Math.round(dist)}m`;
    $('turn-desc').textContent = desc;
    $('turn-banner').classList.remove('hidden');
    // 음성 캡션도 항상 배너와 같은 내용으로 맞춰서, 서로 다른 회전 정보를 동시에 보여주지 않게 함
    $('voice-caption-text').textContent = desc;

    if (dist < 40) {
      announcedTurnCount++;
      Voice.speak(desc);
    }
  }

  // pos: 진행률로 계산한 좌표, bearing: 화면 위쪽이 향해야 할 방향, isMoving: false면 카메라를 그대로 둠(정지)
  function updateMarker(progress, bearing, isMoving) {
    if (!mapHelper) return;
    const pos = mapHelper.pointAtProgress(progress);
    const face = localStorage.getItem(FACE_KEY);
    mapHelper.updateChevrons(progress, mapHelper.map);

    if (!faceMarkerObj) {
      const el = document.createElement('div');
      el.className = 'face-marker-wrap';
      el.innerHTML = `
        <div class="face-marker-arrow"></div>
        <div class="face-marker-inner" style="${face ? `background-image:url(${face})` : ''}"></div>
      `;
      // rotationAlignment 기본값(viewport)이라 화살표는 항상 화면 위쪽을 가리키고,
      // 대신 지도 자체를 진행 방향으로 회전시켜 "앞으로 가는 느낌"을 냄
      faceMarkerObj = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([pos.lng, pos.lat])
        .addTo(mapHelper.map);
    } else {
      faceMarkerObj.setLngLat([pos.lng, pos.lat]);
    }

    if (isMoving) {
      // 카메라를 내 위치보다 살짝 앞쪽(진행 방향)으로 밀어서, 내 마커는 화면 아래쪽에 오고
      // 앞으로 갈 길이 더 넓게 보이는 "로드뷰/러너 시점" 느낌을 냄
      const lookAhead = RouteEngine.destinationPoint(pos, bearing, 38);
      mapHelper.map.easeTo({ center: [lookAhead.lng, lookAhead.lat], bearing, duration: 450, easing: (t) => t });
    }
    // isMoving이 false면 카메라를 그대로 둬서 "멈추면 화면도 멈춤"을 구현
  }

  // AR 모드 진입점: 이 기기가 WebXR(진짜 공간 인식, 안드로이드 크롬)을 지원하면 그걸 먼저 시도하고,
  // 안 되거나 실패하면 나침반 기반 2D 카메라 방식으로 조용히 전환함
  async function startArCamera() {
    const xrOk = await ArXR.isSupported().catch(() => false);
    if (xrOk) {
      try {
        await startArXr();
        return;
      } catch (e) {
        console.warn('WebXR AR 시작 실패, 2D 방식으로 대체:', e.message);
      }
    }
    await startAr2D();
  }

  async function startArXr() {
    $('ar-layer').classList.remove('hidden');
    $('ar-video').classList.add('hidden'); // XR은 카메라 합성을 브라우저가 자체적으로 해줘서 video 요소가 필요 없음
    const canvas = $('ar-canvas');
    await ArXR.start(canvas, currentBearing, lastPos || { lat: 0, lng: 0 });
    arUsingXr = true;
    $('map-area').classList.add('ar-active');
  }

  async function startAr2D() {
    try {
      arStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      $('ar-video').classList.remove('hidden');
      $('ar-video').srcObject = arStream;
      $('ar-layer').classList.remove('hidden');
      const canvas = $('ar-canvas');
      const resize = () => { canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight; };
      resize();
      arResizeHandler = resize;
      window.addEventListener('resize', arResizeHandler);
      arCtx = canvas.getContext('2d');
      arUsingXr = false;
      $('map-area').classList.add('ar-active');
    } catch (e) {
      console.warn('카메라를 열 수 없어요:', e.message);
      announce('카메라를 열 수 없어서 지도로 안내할게요.');
      arModeEnabled = false;
    }
  }

  function stopArCamera() {
    if (arUsingXr) ArXR.stop();
    if (arStream) { arStream.getTracks().forEach((t) => t.stop()); arStream = null; }
    $('ar-layer').classList.add('hidden');
    $('map-area').classList.remove('ar-active');
    if (arResizeHandler) { window.removeEventListener('resize', arResizeHandler); arResizeHandler = null; }
    arCtx = null;
    arUsingXr = false;
  }

  // 경로 위에서 지정한 누적거리들(distances, 오름차순)에 해당하는 좌표를 한 번에 보간해서 찾음
  function pointsAlongRoute(points, distances) {
    if (!points || points.length < 2) return distances.map(() => points?.[0]).filter(Boolean);
    const result = [];
    let segIdx = 1;
    let segStart = 0;
    let segLen = haversine(points[0], points[1]);
    for (const d of distances) {
      while (segIdx < points.length - 1 && segStart + segLen < d) {
        segStart += segLen;
        segIdx++;
        segLen = haversine(points[segIdx - 1], points[segIdx]);
      }
      if (segIdx >= points.length) { result.push(points[points.length - 1]); continue; }
      const t = segLen > 0 ? Math.min(Math.max((d - segStart) / segLen, 0), 1) : 0;
      const a = points[segIdx - 1];
      const b = points[segIdx];
      result.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
    }
    return result;
  }

  // 지금 지나온 거리 기준으로 앞으로 몇 m까지의 경로 지점들을 촘촘하게 뽑아줌 (XR/2D 둘 다 이걸 씀)
  function getLookaheadPathPoints() {
    if (!route?.points) return [];
    const NEAR = 2;
    const FAR = 110;
    const STEP = 2;
    const distances = [];
    for (let d = NEAR; d <= FAR; d += STEP) distances.push(traveledMeters + d);
    return pointsAlongRoute(route.points, distances);
  }

  // ^ 모양 셰브론 하나를 그림 - 바깥쪽 흐린 글로우 + 안쪽 밝은 선, 두 번 겹쳐 그려서 네온처럼 보이게 함
  function drawChevron(ctx, x, y, angleDeg, size, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((angleDeg * Math.PI) / 180);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(-size * 0.55, size * 0.4);
    ctx.lineTo(0, -size * 0.5);
    ctx.lineTo(size * 0.55, size * 0.4);
    // 바깥쪽 흐린 글로우(굵고 연하게)
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(4, size * 0.55);
    ctx.shadowColor = color;
    ctx.shadowBlur = size * 1.4;
    ctx.stroke();
    // 안쪽 밝은 선(가늘고 선명하게, 거의 흰색에 가깝게)
    ctx.globalAlpha = 1;
    ctx.lineWidth = Math.max(2, size * 0.2);
    ctx.strokeStyle = '#EAFFFB';
    ctx.shadowBlur = size * 0.6;
    ctx.stroke();
    ctx.restore();
  }

  // 점들을 부드러운 곡선으로 이어서 그림(각진 꺾임 없이) - 각 점 사이 중점을 이용한 2차 베지어 방식
  function strokeSmoothPath(ctx, pts) {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }

  // 지금 위치·진행방향(나침반) 기준으로, 앞으로 110m 구간을 여러 점으로 쪼개 원근감 있게
  // 계산한 다음 발광 리본 선(부드러운 곡선) + 그 위에 촘촘하게 셰브론들을 띄워서 그림.
  // 걸을수록 지나간 점이 빠지면서 "리본이 줄어드는" 느낌을 냄.
  // 카메라 수평 화각은 기기마다 달라서 실제 값을 알 수 없어 60도로 추정함 - 완벽히 정확하진 않고,
  // 진짜 ARKit처럼 바닥에 달라붙진 않지만(웹에선 그 기능 자체를 못 씀) 방향 감각은 확실히 좋아짐
  function updateArOverlay(cur, headingDeg) {
    if (!arCtx || !route || typeof headingDeg !== 'number') return;
    const canvas = $('ar-canvas');
    const w = canvas.width;
    const h = canvas.height;
    arCtx.clearRect(0, 0, w, h);
    const pathPoints = getLookaheadPathPoints();
    if (!pathPoints.length) return;

    const NEAR = 2;
    const STEP = 2;
    const FAR = 110;
    const FOV = 60; // 후면 카메라 대략적인 수평 화각 추정치(도)
    const half = FOV / 2;
    const horizonY = h * 0.38; // 소실점 높이
    const groundY = h * 0.97;  // 가장 가까운 지점이 나타나는 높이(화면 하단 근처)
    const color = '#38E1FF'; // 참고 이미지처럼 밝은 시안-블루 네온 톤

    const screenPts = pathPoints.map((pt, i) => {
      const dist = NEAR + i * STEP;
      const bearingToPt = RouteEngine.computeBearing(cur, pt);
      const rel = ((bearingToPt - headingDeg + 540) % 360) - 180; // -180..180
      const withinView = Math.abs(rel) <= half * 1.4;
      const depthT = Math.min(dist / FAR, 1); // 0(가까움) ~ 1(멀리) - 제곱을 줘서 먼 쪽은 더 빨리 모이게(원근감 강조)
      const depthCurve = depthT * depthT;
      const y = groundY + (horizonY - groundY) * depthCurve;
      const spread = 1 - depthCurve * 0.82;
      const x = w / 2 + (rel / half) * (w * 0.42) * spread;
      const size = Math.max(w, h) * (0.13 - depthCurve * 0.09);
      return { x, y, withinView, rel, size };
    });

    // 화면 안에 있는 점들만 이어서 부드러운 곡선 리본을 그림 (밖으로 나가면 자연스럽게 끊김)
    const visibleRuns = [];
    let run = [];
    screenPts.forEach((p) => {
      if (p.withinView) { run.push(p); } else if (run.length) { visibleRuns.push(run); run = []; }
    });
    if (run.length) visibleRuns.push(run);

    visibleRuns.forEach((pts) => {
      if (pts.length < 2) return;
      arCtx.save();
      strokeSmoothPath(arCtx, pts);
      // 바깥 글로우
      arCtx.strokeStyle = color;
      arCtx.globalAlpha = 0.45;
      arCtx.lineWidth = Math.max(6, w * 0.028);
      arCtx.lineCap = 'round';
      arCtx.lineJoin = 'round';
      arCtx.shadowColor = color;
      arCtx.shadowBlur = w * 0.035;
      arCtx.stroke();
      // 안쪽 밝은 코어
      arCtx.globalAlpha = 0.9;
      arCtx.lineWidth = Math.max(2, w * 0.008);
      arCtx.strokeStyle = '#EAFFFB';
      arCtx.shadowBlur = w * 0.015;
      arCtx.stroke();
      arCtx.restore();
    });

    // 리본 위에 촘촘하게(6m마다) 셰브론을 띄워서 진행 방향을 표시
    screenPts.forEach((p, i) => {
      if (!p.withinView || i % 3 !== 0) return;
      drawChevron(arCtx, p.x, p.y, p.rel, p.size, color);
    });

    // 목표 방향이 화면 완전히 밖이면(급커브 등) 가장자리에 그쪽으로 돌라는 표시를 추가
    const first = screenPts[0];
    if (first && !first.withinView) {
      const x = first.rel > 0 ? w - first.size : first.size;
      drawChevron(arCtx, x, h * 0.62, first.rel > 0 ? 90 : -90, first.size * 1.4, '#FFB238');
    }
  }

  function updateStats(progress, speedMs) {
    if (!route) return;
    const remainingKm = (route.distanceMeters / 1000) * (1 - progress);
    $('stat-distance').textContent = remainingKm.toFixed(1) + 'km';

    const elapsedMin = (Date.now() - startedAt) / 60000;
    const traveledKm = traveledMeters / 1000;
    $('stat-covered').textContent = traveledKm.toFixed(1) + 'km';
    const paceMinPerKm = traveledKm > 0.05 ? elapsedMin / traveledKm : 0;
    if (paceMinPerKm > 0) {
      const min = Math.floor(paceMinPerKm);
      const sec = Math.round((paceMinPerKm - min) * 60);
      $('stat-pace').textContent = `${min}'${sec.toString().padStart(2, '0')}"`;
    }

    const etaMin = speedMs > 0.3 ? (remainingKm * 1000) / speedMs / 60 : null;
    $('stat-eta').textContent = etaMin ? Math.round(etaMin) + '분' : '-';
  }

  function haversine(a, b) {
    const R = 6371000;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  /* ---------------- 러닝 화면 마이크 (노래 요청 등) ---------------- */
  function handleRunVoice(transcript) {
    const cmd = Voice.parseCommand(transcript);
    if (cmd.type === 'music') {
      Music.playByVoiceQuery(cmd.query).then((name) => {
        if (name) Voice.speak(`${name} 틀어드릴게요`);
      });
    } else {
      Voice.speak('러닝 중에는 노래 요청만 알아들을 수 있어요.');
    }
  }

  /* ---------------- 0. 로그인/회원가입 ---------------- */
  let idChecked = false;
  let checkedIdValue = '';

  function switchAuthTab(which) {
    $('tab-login').classList.toggle('active', which === 'login');
    $('tab-signup').classList.toggle('active', which === 'signup');
    $('form-login').classList.toggle('hidden', which !== 'login');
    $('form-signup').classList.toggle('hidden', which !== 'signup');
    $('auth-error').classList.add('hidden');
  }

  function showAuthError(text) {
    const el = $('auth-error');
    el.textContent = text;
    el.classList.remove('hidden');
  }

  function showIdCheckResult(text, ok) {
    const el = $('id-check-result');
    el.textContent = text;
    el.className = 'id-check-result ' + (ok ? 'ok' : 'taken');
    el.classList.remove('hidden');
  }

  /* ---------------- 1-1. 홈 화면 ---------------- */
  async function loadHomeScreen() {
    if (!currentUser) return;
    renderHomeHero();
    renderRunnerCharacter();
    try {
      const runs = await Auth.listRuns(currentUser.uid, 20);
      renderHomeMap(runs);
      renderPaceChart(runs);
      renderRunHistoryList(runs);
    } catch (err) { console.warn(err); }
    try {
      const top = await Auth.getLeaderboardTop(10);
      renderLeaderboard(top);
    } catch (err) { console.warn(err); }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function renderLeaderboard(list) {
    const el = $('leaderboard-list');
    if (!list.length) {
      el.innerHTML = '<p class="section-empty">아직 순위에 공개한 러너가 없어요. 마이페이지에서 켜보세요!</p>';
      return;
    }
    el.innerHTML = list.map((row, i) => {
      const isMe = currentUser && row.uid === currentUser.uid;
      let paceStr = '-';
      if (row.avgPaceMinPerKm > 0) {
        const pMin = Math.floor(row.avgPaceMinPerKm);
        const pSec = Math.round((row.avgPaceMinPerKm - pMin) * 60);
        paceStr = `${pMin}'${pSec.toString().padStart(2, '0')}"`;
      }
      return `
        <div class="leaderboard-row${isMe ? ' me' : ''}">
          <span class="leaderboard-rank">${i + 1}</span>
          <span class="leaderboard-name">${escapeHtml(row.displayName || '러너')}</span>
          <span class="leaderboard-km">${(row.distanceKm || 0).toFixed(1)}km</span>
          <span class="leaderboard-pace">${paceStr}</span>
        </div>`;
    }).join('');
  }

  function renderHomeHero() {
    const face = localStorage.getItem(FACE_KEY);
    $('home-avatar-img').src = face || '';
    const hour = new Date().getHours();
    const name = cachedProfile?.name ? `${cachedProfile.name}님, ` : '';
    let greeting = `${name}오늘도 좋은 하루예요`;
    if (hour < 11) greeting = `${name}상쾌한 아침이에요`;
    else if (hour < 17) greeting = `${name}오늘도 달려볼까요`;
    else greeting = `${name}오늘 하루도 수고했어요`;
    $('home-greeting').textContent = greeting;

    const goalKm = cachedProfile?.goalKm;
    const doneKm = cachedProfile?.distanceRunKm || 0;
    if (!goalKm) {
      $('home-goal-num').innerHTML = `${doneKm.toFixed(1)}<span>km 누적</span>`;
      $('home-goal-pct').textContent = '';
      $('home-goal-bar').style.width = '0%';
      return;
    }
    const pct = Math.min(Math.round((doneKm / goalKm) * 100), 100);
    $('home-goal-num').innerHTML = `${doneKm.toFixed(1)}<span>/ ${goalKm}km</span>`;
    $('home-goal-pct').textContent = `${pct}%`;
    $('home-goal-bar').style.width = `${pct}%`;
  }

  // 누적 거리에 따라 5단계로 커지는 러닝 캐릭터 - 근육(굵기)과 키(비율)가 단계별로 커짐
  const CHAR_LEVELS = [
    { min: 0, name: '새싹 러너', color: '#8BD9A8',
      quotes: ['처음이 제일 어려워요. 오늘도 나왔다는 게 벌써 대단해요!', '한 걸음씩, 천천히 시작해봐요.'] },
    { min: 5, name: '초보 러너', color: '#5FD98C',
      quotes: ['조금씩 몸이 적응하고 있어요. 이 페이스 그대로!', '벌써 5km 넘게 뛰었어요. 몸이 기억할 거예요.'] },
    { min: 20, name: '성장하는 러너', color: '#2BD97C',
      quotes: ['벌써 20km 넘게 뛰었어요. 다리에 힘이 붙는 게 느껴지죠?', '꾸준함이 실력이 되고 있어요.'] },
    { min: 50, name: '다부진 러너', color: '#16C46E',
      quotes: ['50km 클럽 가입! 이제 진짜 러너 몸이 되어가고 있어요.', '근육이 붙는 게 눈에 보여요, 계속 가봐요.'] },
    { min: 100, name: '레전드 러너', color: '#0FAE5F',
      quotes: ['100km 이상! 동네에서 소문난 러너 아닐까요?', '여기까지 온 당신, 이미 레전드예요.'] },
  ];

  function getCharacterLevel(distanceKm) {
    let level = CHAR_LEVELS[0];
    let idx = 0;
    CHAR_LEVELS.forEach((l, i) => { if (distanceKm >= l.min) { level = l; idx = i; } });
    return { ...level, idx };
  }

  function renderRunnerCharacter() {
    const box = $('runner-character-box');
    if (!box) return;
    const distanceKm = cachedProfile?.distanceRunKm || 0;
    const level = getCharacterLevel(distanceKm);
    const nextLevel = CHAR_LEVELS[level.idx + 1];
    const muscle = 1 + level.idx * 0.18;   // 레벨이 올라갈수록 팔다리가 굵어짐(근육)
    const heightScale = 1 + level.idx * 0.05; // 레벨이 올라갈수록 키가 살짝 커짐
    const legW = (10 * muscle).toFixed(1);
    const armW = (7 * muscle).toFixed(1);
    const torsoW = (32 * muscle).toFixed(1);
    const quote = level.quotes[Math.floor(Math.random() * level.quotes.length)];

    let progressHtml;
    if (nextLevel) {
      const span = nextLevel.min - level.min;
      const pct = Math.min(Math.round(((distanceKm - level.min) / span) * 100), 100);
      const remain = Math.max(nextLevel.min - distanceKm, 0);
      progressHtml = `
        <div class="runner-progress-row">
          <div class="goal-bar-track"><div class="goal-bar-fill" style="width:${pct}%;"></div></div>
          <span class="runner-progress-text">${nextLevel.name}까지 ${remain.toFixed(1)}km</span>
        </div>`;
    } else {
      progressHtml = `<div class="runner-progress-text" style="margin-top:8px;">누적 ${distanceKm.toFixed(1)}km · 최고 단계예요!</div>`;
    }

    // 3km마다 얻은 아이템 중 부위별로 가장 최근 것만 캐릭터에 장착해서 보여줌
    const equipped = getEquippedItems();
    let accessorySvg = '';
    if (equipped.torso) accessorySvg += `<rect x="${(100 - torsoW / 2).toFixed(1)}" y="78" width="${torsoW}" height="10" fill="${equipped.torso.color}" opacity="0.9"/>`;
    if (equipped.arms) accessorySvg += `<rect x="${(100 - armW / 2 - 2).toFixed(1)}" y="70" width="${(Number(armW) + 4).toFixed(1)}" height="18" rx="4" fill="${equipped.arms.color}" opacity="0.85"/>`;
    if (equipped.neck) accessorySvg += `<rect x="88" y="57" width="24" height="6" rx="3" fill="${equipped.neck.color}"/>`;
    if (equipped.head) accessorySvg += `<rect x="82" y="27" width="36" height="7" rx="3.5" fill="${equipped.head.color}"/>`;
    if (equipped.hand) accessorySvg += `<rect x="66" y="88" width="9" height="15" rx="3" fill="${equipped.hand.color}"/>`;
    if (equipped.wrist) accessorySvg += `<circle cx="70" cy="105" r="5" fill="${equipped.wrist.color}"/>`;
    if (equipped.legs) accessorySvg += `<rect x="${(100 - legW / 2 - 2).toFixed(1)}" y="140" width="${(Number(legW) + 4).toFixed(1)}" height="9" rx="4" fill="${equipped.legs.color}"/>`;

    const ownedCount = getOwnedItemIds().length;

    box.innerHTML = `
      <svg viewBox="0 0 200 200" width="110" height="110" style="transform: scaleY(${heightScale}); transform-origin: bottom center;">
        <g class="runner-bob">
          <g class="runner-leg-back" style="transform-origin:100px 118px;">
            <rect x="${(100 - legW / 2).toFixed(1)}" y="118" width="${legW}" height="55" rx="${legW / 2}" fill="${level.color}"/>
          </g>
          <g class="runner-leg-front" style="transform-origin:100px 118px;">
            <rect x="${(100 - legW / 2).toFixed(1)}" y="118" width="${legW}" height="55" rx="${legW / 2}" fill="${level.color}"/>
          </g>
          <rect x="${(100 - torsoW / 2).toFixed(1)}" y="60" width="${torsoW}" height="60" rx="16" fill="${level.color}"/>
          <g class="runner-arm-back" style="transform-origin:100px 68px;">
            <rect x="${(100 - armW / 2).toFixed(1)}" y="68" width="${armW}" height="45" rx="${armW / 2}" fill="#F4C6A0"/>
          </g>
          <g class="runner-arm-front" style="transform-origin:100px 68px;">
            <rect x="${(100 - armW / 2).toFixed(1)}" y="68" width="${armW}" height="45" rx="${armW / 2}" fill="#F4C6A0"/>
          </g>
          <circle cx="100" cy="42" r="20" fill="#F4C6A0"/>
          ${accessorySvg}
        </g>
      </svg>
      <div class="runner-level-name">${level.name}</div>
      ${progressHtml}
      <div class="runner-quote">${quote}</div>
      <div class="runner-items-count">보유 아이템 ${ownedCount}/${ITEM_CATALOG.length}</div>
    `;
  }

  function renderHomeMap(runs) {
    const container = $('home-map');
    if (homeMapObj) { homeMapObj.remove(); homeMapObj = null; }
    container.innerHTML = '';

    const withPoints = runs.filter((r) => r.points && r.points.length > 1);
    if (!withPoints.length) {
      container.innerHTML = '<p class="onboard-sub" style="padding:16px;">아직 뛴 기록이 없어요</p>';
      return;
    }

    const allCoords = withPoints.flatMap((r) => r.points.map((p) => [p.lng, p.lat]));
    const lons = allCoords.map((c) => c[0]);
    const lats = allCoords.map((c) => c[1]);

    homeMapObj = new maplibregl.Map({
      container,
      style: 'https://tiles.openfreemap.org/styles/bright',
      center: [lons[0], lats[0]],
      zoom: 12,
      pitch: 0,
      interactive: false,
      attributionControl: false,
    });

    homeMapObj.on('load', () => {
      homeMapObj.addSource('past-runs', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: withPoints.map((r) => ({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: r.points.map((p) => [p.lng, p.lat]) },
          })),
        },
      });
      homeMapObj.addLayer({
        id: 'past-runs-line',
        type: 'line',
        source: 'past-runs',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2BD97C', 'line-width': 3, 'line-opacity': 0.85 },
      });
      homeMapObj.fitBounds(
        [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
        { padding: 24, duration: 0 }
      );
    });
  }

  function renderPaceChart(runs) {
    const container = $('pace-chart');
    const withPace = runs.filter((r) => r.paceMinPerKm > 0).slice(0, 10).reverse();
    if (!withPace.length) {
      container.innerHTML = '<p class="onboard-sub" style="padding:8px 0;">아직 데이터가 없어요</p>';
      return;
    }
    const paces = withPace.map((r) => r.paceMinPerKm);
    const minP = Math.min(...paces), maxP = Math.max(...paces);
    const W = 300, H = 100, PAD = 10;
    const pts = paces.map((p, i) => {
      const x = PAD + (i / Math.max(paces.length - 1, 1)) * (W - PAD * 2);
      const y = maxP === minP ? H / 2 : PAD + ((p - minP) / (maxP - minP)) * (H - PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%">
      <polyline points="${pts}" fill="none" stroke="#2BD97C" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  function renderRunHistoryList(runs) {
    const container = $('run-history-list');
    if (!runs.length) {
      container.innerHTML = '<p class="onboard-sub">아직 뛴 기록이 없어요</p>';
      return;
    }
    container.innerHTML = '';
    runs.slice(0, 10).forEach((r) => {
      const row = document.createElement('div');
      row.className = 'run-history-item';
      const date = r.completedAt?.toDate ? r.completedAt.toDate() : new Date();
      const dateStr = `${date.getMonth() + 1}/${date.getDate()}`;
      const paceStr = r.paceMinPerKm
        ? `${Math.floor(r.paceMinPerKm)}'${Math.round((r.paceMinPerKm % 1) * 60).toString().padStart(2, '0')}"/km`
        : '-';
      row.innerHTML = `
        <span class="run-icon"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg></span>
        <span class="date">${dateStr}</span>
        <span class="stats">${(r.distanceKm || 0).toFixed(1)}km · ${paceStr}</span>`;
      container.appendChild(row);
    });
  }

  /* ---------------- 이벤트 바인딩 ---------------- */
  window.addEventListener('DOMContentLoaded', () => {
    Music.openDB().catch(console.warn);
    Voice.setComedyMode(localStorage.getItem(COMEDY_KEY) === '1');
    Voice.setVoiceKey(localStorage.getItem(VOICE_KEY) || null);
    arModeEnabled = localStorage.getItem(ARROW_MODE_KEY) === 'ar';

    const introVideo = $('intro-video');
    function leaveIntro() {
      introVideo.pause();
      showScreen('screen-auth');
    }
    introVideo.addEventListener('ended', leaveIntro);
    $('btn-skip-intro').addEventListener('click', leaveIntro);
    // 자동재생이 브라우저 정책으로 막히는 경우, 검은 화면에 갇히지 말고 바로 다음 화면으로
    introVideo.play().catch(() => leaveIntro());

    $('tab-login').addEventListener('click', () => switchAuthTab('login'));
    $('tab-signup').addEventListener('click', () => switchAuthTab('signup'));

    $('form-login').addEventListener('submit', async (e) => {
      e.preventDefault();
      interactiveAuthInProgress = true;
      try {
        await Auth.setRememberMe($('login-remember').checked);
        const user = await Auth.logIn({ id: $('login-id').value.trim(), password: $('login-pw').value });
        currentUser = user;
        cachedProfile = await Auth.getProfile(user.uid).catch(() => null);
        refreshGoalHeader();
        goToPostAuthFlow();
      } catch (err) {
        showAuthError(Auth.toKoreanError(err));
      } finally {
        interactiveAuthInProgress = false;
      }
    });

    $('form-signup').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = $('signup-id').value.trim();
      if (!idChecked || checkedIdValue !== id) {
        showAuthError('아이디 중복확인을 먼저 해주세요');
        return;
      }
      interactiveAuthInProgress = true;
      try {
        const user = await Auth.signUp({
          id,
          password: $('signup-pw').value,
          name: $('signup-name').value.trim(),
          age: $('signup-age').value,
          gender: $('signup-gender').value,
        });
        currentUser = user;
        cachedProfile = await Auth.getProfile(user.uid).catch(() => null);
        refreshGoalHeader();
        showScreen('screen-goal'); // 가입 직후 목표거리 설정 화면으로
      } catch (err) {
        showAuthError(err.message || Auth.toKoreanError(err));
      } finally {
        interactiveAuthInProgress = false;
      }
    });

    $('btn-check-id').addEventListener('click', async () => {
      const id = $('signup-id').value.trim();
      if (!Auth.isValidId(id)) {
        showIdCheckResult('아이디는 영문+숫자 조합 8~14자여야 해요', false);
        idChecked = false;
        return;
      }
      try {
        const available = await Auth.checkUsernameAvailable(id);
        showIdCheckResult(available ? '사용 가능한 아이디예요' : '이미 사용 중인 아이디예요', available);
        idChecked = available;
        checkedIdValue = id;
      } catch (err) {
        showIdCheckResult('중복 확인에 실패했어요. 다시 시도해주세요', false);
        idChecked = false;
      }
    });

    $('signup-id').addEventListener('input', () => {
      idChecked = false;
      $('id-check-result').classList.add('hidden');
    });

    $('btn-google-login').addEventListener('click', async () => {
      interactiveAuthInProgress = true;
      try {
        await Auth.setRememberMe($('login-remember').checked);
        const { user, isNew } = await Auth.logInWithGoogle();
        currentUser = user;
        cachedProfile = await Auth.getProfile(user.uid).catch(() => null);
        refreshGoalHeader();
        if (isNew) {
          showScreen('screen-goal');
        } else {
          goToPostAuthFlow();
        }
      } catch (err) {
        showAuthError(Auth.toKoreanError(err));
      } finally {
        interactiveAuthInProgress = false;
      }
    });

    $('btn-goal-save').addEventListener('click', async () => {
      const val = parseFloat($('goal-input').value);
      if (currentUser && val > 0) {
        try {
          await Auth.saveGoal(currentUser.uid, val);
          cachedProfile = cachedProfile || {};
          cachedProfile.goalKm = val;
          refreshGoalHeader();
        } catch (err) { console.warn(err); }
      }
      goToPostAuthFlow();
    });

    $('btn-goal-skip').addEventListener('click', () => {
      goToPostAuthFlow();
    });

    // 새로고침 등으로 이미 로그인된 세션이 복원된 경우에만 처리
    // (로그인/가입 버튼으로 진행 중일 때는 위 핸들러들이 화면 전환을 직접 담당함)
    // 앱이 맨 처음 뜨는 화면은 "인트로 영상"이라, 로그인 화면뿐 아니라 인트로 화면일 때도 확인해야 함
    Auth.onAuthChange(async (user) => {
      currentUser = user;
      if (!user || interactiveAuthInProgress) return;
      const onIntro = $('screen-intro').classList.contains('active');
      const onAuth = $('screen-auth').classList.contains('active');
      if (onIntro || onAuth) {
        if (onIntro) $('intro-video').pause();
        cachedProfile = await Auth.getProfile(user.uid).catch(() => null);
        refreshGoalHeader();
        goToPostAuthFlow();
      }
    });

    $('btn-shoot').addEventListener('click', shootSelfie);
    $('btn-retake').addEventListener('click', retakeSelfie);
    $('btn-confirm').addEventListener('click', confirmSelfie);
    $('btn-skip').addEventListener('click', () => {
      stopCamera();
      showScreen(onboardReturnScreen);
      if (onboardReturnScreen === 'screen-profile') refreshProfileScreen();
      if (onboardReturnScreen === 'screen-home') loadHomeScreen();
    });

    $('btn-setup-mic').addEventListener('click', () => {
      requestCompassPermission();
      Voice.listenOnce(handleSetupVoice);
    });
    $('btn-setup-manual').addEventListener('click', () => {
      requestCompassPermission();
      const destination = prompt('목적지 (없으면 비워두기)') || null;
      const distance = parseFloat(prompt('거리(km)')) || null;
      if (destination && distance) prepareRoute({ type: 'destination_with_distance', destination, distance });
      else if (distance) prepareRoute({ type: 'distance_only', distance });
      else if (destination) prepareRoute({ type: 'destination_only', destination });
    });

    $('btn-start-run').addEventListener('click', () => {
      $('btn-start-run').classList.add('hidden');
      requestCompassPermission();
      runCountdown();
    });

    $('mic-btn').addEventListener('click', () => Voice.listenOnce(handleRunVoice));
    $('btn-next-song').addEventListener('click', async () => {
      const name = await Music.playNext();
      if (name) announce(`다음 곡, ${name}`);
    });
    $('btn-end-run').addEventListener('click', () => {
      if (goalCountedForThisRun) return; // 이미 도착 처리로 종료 중이면 중복 방지
      goalCountedForThisRun = true;
      finishRun(true);
    });
    $('btn-finish-home').addEventListener('click', () => {
      showScreen('screen-home');
      loadHomeScreen();
    });

    $('btn-add-music').addEventListener('click', () => $('music-file-input').click());
    $('music-file-input').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      for (const f of files) await Music.addTrack(f);
      if (files.length) Voice.speak(`${files.length}곡 추가했어요`);
    });

    $('btn-open-profile').addEventListener('click', () => {
      profileReturnScreen = 'screen-setup';
      refreshProfileScreen();
      showScreen('screen-profile');
    });
    $('btn-home-profile').addEventListener('click', () => {
      profileReturnScreen = 'screen-home';
      refreshProfileScreen();
      showScreen('screen-profile');
    });
    $('btn-profile-close').addEventListener('click', () => {
      showScreen(profileReturnScreen);
      if (profileReturnScreen === 'screen-home') loadHomeScreen();
    });
    $('btn-go-run').addEventListener('click', () => showScreen('screen-setup'));
    $('btn-setup-back').addEventListener('click', () => {
      showScreen('screen-home');
      loadHomeScreen();
    });
    $('btn-logout').addEventListener('click', async () => {
      await Auth.signOut().catch(console.warn);
      currentUser = null;
      cachedProfile = null;
      showScreen('screen-auth');
    });
    $('btn-change-photo').addEventListener('click', () => {
      onboardReturnScreen = 'screen-profile';
      showScreen('screen-onboard');
      startCamera();
    });
    $('btn-profile-goal-save').addEventListener('click', async () => {
      const val = parseFloat($('profile-goal-input').value);
      if (!currentUser || !(val > 0)) return;
      try {
        await Auth.saveGoal(currentUser.uid, val);
        cachedProfile = cachedProfile || {};
        cachedProfile.goalKm = val;
        refreshGoalHeader();
        Voice.speak('목표 거리를 저장했어요');
      } catch (err) { console.warn(err); }
    });
    $('profile-comedy-toggle').addEventListener('change', (e) => {
      const on = e.target.checked;
      localStorage.setItem(COMEDY_KEY, on ? '1' : '0');
      Voice.setComedyMode(on);
      Voice.speak(on ? '웃긴 모드 켰습니다' : '웃긴 모드 껐어요');
    });
    $('btn-shuffle-nickname').addEventListener('click', async () => {
      const nick = generateRandomNickname();
      localStorage.setItem(NICKNAME_KEY, nick);
      $('profile-nickname-display').textContent = nick;
      Voice.speak(`새 닉네임, ${nick}`);
      if (currentUser) {
        const pub = await Auth.isPublished(currentUser.uid).catch(() => false);
        if (pub) Auth.publishLeaderboard(currentUser.uid, nick).catch(console.warn);
      }
    });
    $('profile-publish-toggle').addEventListener('change', async (e) => {
      if (!currentUser) { e.target.checked = false; return; }
      const wantPublish = e.target.checked;
      e.target.disabled = true;
      try {
        if (wantPublish) {
          await Auth.publishLeaderboard(currentUser.uid, getOrCreateNickname());
          Voice.speak('이번년도 기록을 공개했어요');
        } else {
          await Auth.unpublishLeaderboard(currentUser.uid);
          Voice.speak('기록 공개를 껐어요');
        }
      } catch (err) {
        e.target.checked = !wantPublish; // 실패하면 되돌림
        console.warn(err);
      } finally {
        e.target.disabled = false;
      }
    });

    /* ---------------- 유튜브 / Spotify 노래 검색-추가 ---------------- */
    function renderSearchResults(containerId, items, onAdd) {
      const el = $(containerId);
      el.innerHTML = '';
      (items || []).forEach((item) => {
        const row = document.createElement('div');
        row.className = 'search-result-item';
        const label = document.createElement('span');
        label.textContent = item.title || `${item.name} - ${item.artist}`;
        const btn = document.createElement('button');
        btn.textContent = '추가';
        btn.addEventListener('click', () => { onAdd(item); btn.textContent = '추가됨'; btn.disabled = true; });
        row.appendChild(label);
        row.appendChild(btn);
        el.appendChild(row);
      });
    }

    $('btn-youtube-search').addEventListener('click', async () => {
      const q = $('youtube-search-input').value.trim();
      if (!q) return;
      try {
        const res = await fetch('/api/youtube-search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q }),
        });
        const results = await res.json();
        renderSearchResults('youtube-search-results', results, async (item) => {
          await Music.addYoutubeTrack(item.videoId, item.title);
        });
      } catch (err) { console.warn(err); }
    });

    $('btn-spotify-connect').addEventListener('click', () => SpotifyBackend.login());

    $('btn-spotify-search').addEventListener('click', async () => {
      const q = $('spotify-search-input').value.trim();
      if (!q) return;
      try {
        const results = await SpotifyBackend.search(q);
        renderSearchResults('spotify-search-results', results, async (item) => {
          await Music.addSpotifyTrack(item.uri, `${item.name} - ${item.artist}`);
        });
      } catch (err) { console.warn(err); }
    });

    // Spotify 로그인 콜백(주소에 ?code=...) 처리 + 연결 상태 반영
    SpotifyBackend.handleRedirectCallback().then((justConnected) => {
      if (justConnected || SpotifyBackend.isConnected()) {
        $('btn-spotify-connect').classList.add('hidden');
        $('spotify-search-box').classList.remove('hidden');
      }
    });

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.warn);
  });
})();
