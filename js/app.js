// 화면 전환 + 셀카 온보딩 + GPS 추적 + 통계 업데이트를 묶는 메인 컨트롤러
(function () {
  const FACE_KEY = 'run-pacer-face-photo';
  let currentStream = null;
  let route = null;       // { points, distanceMeters, turns }
  let mapHelper = null;   // route.js의 renderOnMap 결과 (MapLibre)
  let watchId = null;
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
    beginRun(cmd);
  }

  async function beginRun(cmd) {
    showScreen('screen-run');
    announce('경로를 준비하고 있어요.');
    startedAt = Date.now();
    traveledMeters = 0;
    goalCountedForThisRun = false;
    announcedTurnCount = 0;
    faceMarkerObj = null;
    paceSplits = [];
    lastSplitMeters = 0;
    lastSplitTime = Date.now();

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
        announce('경로 준비됐어요. 출발할게요.');
        Music.startForRun();
        startGpsTracking();
      } catch (e) {
        announce('경로를 만드는 데 실패했어요. ' + e.message);
      }
    }, () => announce('위치 정보를 가져올 수 없어요. GPS를 켜주세요.'), { enableHighAccuracy: true });
  }

  async function geocode(placeName, center) {
    // Kakao 검색으로 지명 -> 좌표 변환 (반드시 실제 현재 위치를 기준으로 검색)
    const results = await RouteEngine.searchNearby(placeName, center || lastPos);
    if (!results.length) throw new Error(`"${placeName}"을(를) 못 찾았어요`);
    return { lat: results[0].lat, lng: results[0].lng };
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

    // 방향: 기기가 준 heading이 있으면 그걸 쓰고, 없으면 직전 위치 대비 이동 방향으로 계산
    if (isMoving) {
      if (typeof pos.coords.heading === 'number' && !Number.isNaN(pos.coords.heading)) {
        currentBearing = pos.coords.heading;
      } else if (isRealMovement) {
        currentBearing = RouteEngine.computeBearing(lastPos, cur);
      }
    }

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
    if (!route?.turns?.length || announcedTurnCount >= route.turns.length) return;
    const next = route.turns[announcedTurnCount];
    if (!next.lat || !next.lng) { announcedTurnCount++; return; }
    const dist = haversine(currentPos, next);
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
      row.innerHTML = `<span class="date">${dateStr}</span><span class="stats">${(r.distanceKm || 0).toFixed(1)}km · ${paceStr}</span>`;
      container.appendChild(row);
    });
  }

  /* ---------------- 이벤트 바인딩 ---------------- */
  window.addEventListener('DOMContentLoaded', () => {
    Music.openDB().catch(console.warn);

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

    $('btn-setup-mic').addEventListener('click', () => Voice.listenOnce(handleSetupVoice));
    $('btn-setup-manual').addEventListener('click', () => {
      const destination = prompt('목적지 (없으면 비워두기)') || null;
      const distance = parseFloat(prompt('거리(km)')) || null;
      if (destination && distance) beginRun({ type: 'destination_with_distance', destination, distance });
      else if (distance) beginRun({ type: 'distance_only', distance });
      else if (destination) beginRun({ type: 'destination_only', destination });
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
