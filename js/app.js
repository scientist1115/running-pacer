// 화면 전환 + 셀카 온보딩 + GPS 추적 + 통계 업데이트를 묶는 메인 컨트롤러
(function () {
  const FACE_KEY = 'run-pacer-face-photo';
  const COMEDY_KEY = 'run-pacer-comedy-mode';
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
    if (currentUser) {
      Auth.isPublished(currentUser.uid).then((pub) => {
        $('profile-publish-toggle').checked = pub;
      }).catch(() => {});
    }
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
        announce('출발할게요.');
        Music.startForRun();
        startGpsTracking();
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

      // 멈춰 서 있을 때는 위치 이동 없이 방향만 바로 반영 (몸을 돌리면 화면도 즉시 도는 VR 느낌)
      if (!lastKnownIsMoving && mapHelper) {
        const now = Date.now();
        if (now - lastCompassApply > 100) {
          lastCompassApply = now;
          currentBearing = heading;
          mapHelper.map.setBearing(heading);
        }
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

    // 위치 정확도가 너무 나쁘면(와이파이 기반 대략 위치 등) 이번 값은 신뢰하지 않고 건너뜀
    if (accuracy > 30) return;

    const movedMeters = lastPos ? haversine(lastPos, cur) : 0;
    const noiseFloor = Math.max(3, accuracy); // GPS 오차 범위 안의 흔들림은 "이동"으로 안 침
    const isRealMovement = lastPos ? movedMeters > noiseFloor : false;
    const isMoving = speed > 0.3 || isRealMovement;

    if (isRealMovement) traveledMeters += movedMeters;

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
        const displayName = cachedProfile?.username || cachedProfile?.name || '러너';
        return Auth.publishLeaderboard(currentUser.uid, displayName);
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

    // 오늘 뛴 경로 지도로 보여주기
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
          paint: { 'line-color': '#2BD97C', 'line-width': 4 },
        });
        finishMapObj.fitBounds(
          [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
          { padding: 24, duration: 0 }
        );
      });
    }

    // 오늘 페이스 변화 그래프 (250m 구간별)
    const chartContainer = $('finish-pace-chart');
    if (paceSplits.length < 2) {
      chartContainer.innerHTML = '<p class="onboard-sub" style="padding:8px 0;">그래프를 그리기엔 너무 짧게 뛰었어요</p>';
    } else {
      const minP = Math.min(...paceSplits), maxP = Math.max(...paceSplits);
      const W = 300, H = 100, PAD = 10;
      const pts = paceSplits.map((p, i) => {
        const x = PAD + (i / (paceSplits.length - 1)) * (W - PAD * 2);
        const y = maxP === minP ? H / 2 : PAD + ((p - minP) / (maxP - minP)) * (H - PAD * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      chartContainer.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%">
        <polyline points="${pts}" fill="none" stroke="#2BD97C" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
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

    // 배너는 매번 최신 거리로 갱신해서 항상 다음 회전까지 얼마나 남았는지 보여줌
    $('turn-dist').textContent = `${Math.round(dist)}m`;
    $('turn-desc').textContent = next.description || '방향 전환';
    $('turn-banner').classList.remove('hidden');

    if (dist < 40) {
      announcedTurnCount++;
      if (next.description) announce(next.description);
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

  function updateStats(progress, speedMs) {
    if (!route) return;
    const remainingKm = (route.distanceMeters / 1000) * (1 - progress);
    $('stat-distance').textContent = remainingKm.toFixed(1) + 'km';

    const elapsedMin = (Date.now() - startedAt) / 60000;
    const traveledKm = traveledMeters / 1000;
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
    Auth.onAuthChange(async (user) => {
      currentUser = user;
      if (!user || interactiveAuthInProgress) return;
      if ($('screen-auth').classList.contains('active')) {
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
    $('profile-publish-toggle').addEventListener('change', async (e) => {
      if (!currentUser) { e.target.checked = false; return; }
      const wantPublish = e.target.checked;
      e.target.disabled = true;
      try {
        if (wantPublish) {
          const displayName = cachedProfile?.username || cachedProfile?.name || '러너';
          await Auth.publishLeaderboard(currentUser.uid, displayName);
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
