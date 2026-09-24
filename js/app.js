// 화면 전환 + 셀카 온보딩 + GPS 추적 + 통계 업데이트를 묶는 메인 컨트롤러
(function () {
  const FACE_KEY = 'run-pacer-face-photo';
  const COMEDY_KEY = 'run-pacer-comedy-mode';
  const VOICE_KEY = 'run-pacer-voice-key';
  const VOICE_MUTE_KEY = 'run-pacer-voice-muted';
  const PACE_INTERVAL_KEY = 'run-pacer-pace-interval-min'; // 0 = 끄기
  let voiceMuted = false;
  const ARROW_MODE_KEY = 'run-pacer-arrow-mode'; // 'map' | 'ar'
  const NICKNAME_KEY = 'run-pacer-leaderboard-nickname';
  let analysisToken = 0;      // 러닝 분석(장소 조회) 비동기 결과가 오래된 화면을 덮어쓰지 않게 하는 토큰
  let itemsFilter = 'all';    // 아이템 창 필터: 'all' | '3' | '5'
  let premiumRun = null;      // 고급 아이템 도전 중이면 { id, name, km, routeKm } - 완주하면 아이템 지급

  /* ================= 아이템 시스템 (누적 거리로 해금, 부위별로 진화) =================
   * - 러닝 중에는 아이템을 주지 않아요. 누적 러닝 거리(Firestore distanceRunKm)가 쌓이면 순서대로 해금돼요.
   * - 아이템마다 "이 아이템을 얻으려면 앞 아이템에서 더 달려야 하는 거리(stepKm)"가 3km 또는 5km로 정해져 있어요.
   * - 같은 부위(slot)에서는 등급(tier)이 높은 아이템이 해금되면 자동으로 그걸로 진화(교체)돼요.
   * - 거리는 서버(Firestore)에 저장된 누적 거리로 계산하니까 기기를 바꿔도 아이템이 그대로 유지돼요.
   */
  const TIER_INFO = {
    1: { name: '일반', color: '#9AA7B2' },
    2: { name: '레어', color: '#4FA8FF' },
    3: { name: '에픽', color: '#B57BFF' },
    4: { name: '전설', color: '#FFD60A' },
  };
  const SLOT_INFO = {
    head: '머리', face: '얼굴', neck: '목', torso: '상의', arms: '팔', wrist: '손목', hand: '손', legs: '다리', feet: '신발',
  };
  const SLOT_ORDER = ['head', 'face', 'neck', 'torso', 'arms', 'wrist', 'hand', 'legs', 'feet'];

  // 해금 순서대로 나열 - stepKm는 "앞 아이템 해금 후 이만큼 더 달리면 해금"이라는 뜻(3km짜리 / 5km짜리)
  const ITEM_SEQUENCE = [
    { id: 'headband', name: '머리띠', slot: 'head', tier: 1, stepKm: 3, color: '#FF6B5E' },
    { id: 'wristband', name: '손목밴드', slot: 'wrist', tier: 1, stepKm: 3, color: '#FFD60A' },
    { id: 'waterbottle', name: '물병', slot: 'hand', tier: 1, stepKm: 3, color: '#4FA8FF' },
    { id: 'socks', name: '러닝 양말', slot: 'feet', tier: 1, stepKm: 3, color: '#E8ECEF' },
    { id: 'armsleeve', name: '팔토시', slot: 'arms', tier: 1, stepKm: 3, color: '#38E1FF' },
    { id: 'vest', name: '조끼', slot: 'torso', tier: 1, stepKm: 3, color: '#2BD97C' },
    { id: 'glasses', name: '스포츠 안경', slot: 'face', tier: 1, stepKm: 3, color: '#8FD3FF' },
    { id: 'neckwarmer', name: '넥워머', slot: 'neck', tier: 1, stepKm: 3, color: '#FF9FB2' },
    { id: 'kneepads', name: '무릎보호대', slot: 'legs', tier: 1, stepKm: 3, color: '#8B5CF6' },
    { id: 'cap', name: '러닝 캡', slot: 'head', tier: 2, stepKm: 5, color: '#4FD8FF' },
    { id: 'smartwatch', name: '스마트워치', slot: 'wrist', tier: 2, stepKm: 5, color: '#4FE3A0' },
    { id: 'energydrink', name: '에너지드링크', slot: 'hand', tier: 2, stepKm: 3, color: '#FFB238' },
    { id: 'runshoes', name: '러닝화', slot: 'feet', tier: 2, stepKm: 5, color: '#FF7A45' },
    { id: 'compsleeve', name: '압박 슬리브', slot: 'arms', tier: 2, stepKm: 3, color: '#7C8CFF' },
    { id: 'tee', name: '기능성 티', slot: 'torso', tier: 2, stepKm: 5, color: '#4FA8FF' },
    { id: 'sunglasses', name: '선글라스', slot: 'face', tier: 2, stepKm: 3, color: '#3A3F47' },
    { id: 'scarf', name: '스카프', slot: 'neck', tier: 2, stepKm: 3, color: '#FF6B9D' },
    { id: 'tights', name: '압박 타이츠', slot: 'legs', tier: 2, stepKm: 5, color: '#5B6CFF' },
    { id: 'visor', name: '바이저 캡', slot: 'head', tier: 3, stepKm: 5, color: '#B57BFF' },
    { id: 'mirrorgoggle', name: '미러 고글', slot: 'face', tier: 3, stepKm: 5, color: '#7DF9FF' },
    { id: 'windbreaker', name: '바람막이', slot: 'torso', tier: 3, stepKm: 5, color: '#B57BFF' },
    { id: 'carbonshoes', name: '카본 러닝화', slot: 'feet', tier: 3, stepKm: 5, color: '#C58BFF' },
    { id: 'crown', name: '황금 왕관', slot: 'head', tier: 4, stepKm: 5, color: '#FFD60A' },
    { id: 'cape', name: '히어로 망토', slot: 'torso', tier: 4, stepKm: 5, color: '#FF4D6D' },
  ];
  const ITEM_CATALOG = (() => {
    let acc = 0;
    return ITEM_SEQUENCE.map((it, i) => {
      acc += it.stepKm;
      return { ...it, order: i + 1, unlockKm: acc };
    });
  })();
  const TOTAL_ITEM_KM = ITEM_CATALOG[ITEM_CATALOG.length - 1].unlockKm;

  /* ================= 고급 아이템 (5km / 7km 코스 완주로 획득) =================
   * - 아이템 창에서 코스를 고르면 내 주변에 그 거리만큼의 순환 경로를 만들어서 바로 러닝을 준비해요.
   * - 끝까지 완주하면(수동 종료는 목표의 98% 이상) 그 아이템을 얻어요. 기본 아이템(누적 거리 해금)과는 별개예요.
   * - 고급 아이템은 등급이 5(신화)/6(초월)이라 같은 부위의 기본 아이템보다 항상 우선해서 장착돼요.
   * - 보유 목록은 Firestore users/{uid}.premiumItems(배열)에 저장하고, 실패에 대비해 기기(localStorage)에도 같이 둬요.
   */
  TIER_INFO[5] = { name: '신화', color: '#FF5CCB' };
  TIER_INFO[6] = { name: '초월', color: '#38F2FF' };
  SLOT_INFO.halo = '후광'; SLOT_INFO.back = '등'; SLOT_INFO.aura = '오라';
  const PREMIUM_ITEMS = [
    { id: 'p_halo', name: '천사의 링', slot: 'halo', tier: 5, runKm: 5, color: '#FFE98A', desc: '머리 위에 떠 있는 빛의 고리' },
    { id: 'p_holovisor', name: '홀로 바이저', slot: 'face', tier: 5, runKm: 5, color: '#00E5FF', desc: '앞길을 스캔하는 홀로그램 바이저' },
    { id: 'p_lightboots', name: '번개 부츠', slot: 'feet', tier: 5, runKm: 5, color: '#FFE066', desc: '한 걸음마다 번개가 튀는 부츠' },
    { id: 'p_wings', name: '은빛 날개', slot: 'back', tier: 5, runKm: 5, color: '#EAF2FF', desc: '등 뒤에서 펄럭이는 날개' },
    { id: 'p_nebula', name: '성운 왕관', slot: 'halo', tier: 6, runKm: 7, color: '#7C5CFF', desc: '천사의 링보다 한 단계 위, 우주의 왕관' },
    { id: 'p_cybersuit', name: '사이버 슈트', slot: 'torso', tier: 6, runKm: 7, color: '#38F2FF', desc: '에너지 코어가 빛나는 슈트' },
    { id: 'p_baton', name: '플라즈마 배턴', slot: 'hand', tier: 6, runKm: 7, color: '#C58BFF', desc: '손에 쥔 빛의 배턴' },
    { id: 'p_flameaura', name: '불꽃 오라', slot: 'aura', tier: 6, runKm: 7, color: '#FF7A45', desc: '온몸을 감싸는 불꽃' },
  ].map((it) => ({ ...it, premium: true, stepKm: it.runKm }));
  const PREMIUM_MIN_RATIO = 0.9;      // 이 비율 이상 달려야 완주로 인정 (경로가 목표 거리와 살짝 다를 수 있어서)
  const PREMIUM_MANUAL_RATIO = 0.98;  // 직접 "종료하기"를 눌렀다면 이 비율 이상 달렸어야 인정

  function premiumKey() { return 'run-pacer-premium-' + (currentUser?.uid || 'anon'); }
  function getOwnedPremiumIds() {
    const set = new Set(Array.isArray(cachedProfile?.premiumItems) ? cachedProfile.premiumItems : []);
    try { (JSON.parse(localStorage.getItem(premiumKey()) || '[]') || []).forEach((id) => set.add(id)); } catch (e) { /* 저장소 못 쓰면 서버 값만 */ }
    return set;
  }
  function getOwnedPremium() {
    const s = getOwnedPremiumIds();
    return PREMIUM_ITEMS.filter((i) => s.has(i.id));
  }
  function grantPremium(id) {
    const ids = getOwnedPremiumIds();
    if (ids.has(id)) return;
    ids.add(id);
    cachedProfile = cachedProfile || {};
    cachedProfile.premiumItems = Array.from(ids);
    try { localStorage.setItem(premiumKey(), JSON.stringify(Array.from(ids))); } catch (e) { /* ignore */ }
    if (currentUser && typeof Auth.addPremiumItem === 'function') Auth.addPremiumItem(currentUser.uid, id).catch(console.warn);
  }

  /* ================= 걷는 캐릭터 =================
   * - 캐릭터는 앱을 켜든 폰을 끄든 계속 걸어요: 기본 하루 3m. 웹앱은 꺼져 있으면 실제로 실행되지 못하니까
   *   "마지막으로 확정한 시각(walkAt)부터 지금까지 흐른 실제 시간"으로 계산해서, 다시 열었을 때 그만큼 걸어 있어요.
   * - 아이템이 많을수록(등급이 높을수록) 걷는 속도가 빨라져요. 속도가 바뀌기 직전(러닝 종료로 아이템을 얻을 때)에
   *   그때까지 걸은 거리를 확정(settleWalk)해서, 예전 속도로 걸은 만큼은 그대로 인정돼요.
   * - 값은 Firestore users/{uid}.walkMeters / walkAt(ms)에 저장하고 기기(localStorage)에도 같이 둬요.
   */
  const WALK_BASE_M_PER_DAY = 3; // 아이템이 없을 때 하루에 걷는 거리(m)
  const WALK_BASE_M_PER_HOUR = WALK_BASE_M_PER_DAY / 24;
  const WALK_TIER_BONUS = { 1: 0.04, 2: 0.06, 3: 0.09, 4: 0.12, 5: 0.25, 6: 0.35 }; // 아이템 하나당 걷기 속도 증가분

  function walkMultiplierFor(km, premiumIds) {
    let m = 1;
    getUnlockedItems(km).forEach((i) => { m += WALK_TIER_BONUS[i.tier] || 0; });
    PREMIUM_ITEMS.forEach((i) => { if (premiumIds && premiumIds.has(i.id)) m += WALK_TIER_BONUS[i.tier] || 0; });
    return m;
  }
  function walkMultiplier() { return walkMultiplierFor(getTotalRunKm(), getOwnedPremiumIds()); }

  function walkLocalKey() { return 'run-pacer-walk-' + (currentUser?.uid || 'anon'); }
  function readWalkLocal() {
    try {
      const o = JSON.parse(localStorage.getItem(walkLocalKey()) || 'null');
      if (o && isFinite(o.m) && isFinite(o.at) && o.at > 0) return { m: Number(o.m), at: Number(o.at) };
    } catch (e) { /* ignore */ }
    return null;
  }
  function saveWalkState(s) {
    if (cachedProfile) { cachedProfile.walkMeters = s.m; cachedProfile.walkAt = s.at; }
    try { localStorage.setItem(walkLocalKey(), JSON.stringify(s)); } catch (e) { /* ignore */ }
    if (currentUser && typeof Auth.saveWalk === 'function') Auth.saveWalk(currentUser.uid, s.m, s.at).catch(console.warn);
  }
  // 저장된 "확정된 걸음 거리"와 그 시각. 둘 중(서버/기기) 더 최근에 확정된 값을 써요. 아무것도 없으면 지금부터 걷기 시작.
  function getWalkState() {
    const p = cachedProfile || {};
    const remote = (Number(p.walkAt) > 0 && isFinite(Number(p.walkMeters))) ? { m: Number(p.walkMeters), at: Number(p.walkAt) } : null;
    const local = readWalkLocal();
    let s = remote && local ? (local.at > remote.at ? local : remote) : (remote || local);
    if (!s) {
      s = { m: 0, at: Date.now() };
      if (cachedProfile || !currentUser) saveWalkState(s); // 프로필을 아직 못 불러왔으면 저장은 미룸(서버 값을 덮어쓰지 않으려고)
    }
    return s;
  }
  function currentWalkMeters() {
    const s = getWalkState();
    const hours = Math.max(Date.now() - s.at, 0) / 3600000;
    return Math.max(s.m + hours * WALK_BASE_M_PER_HOUR * walkMultiplier(), 0);
  }
  function settleWalk() {
    if (currentUser && !cachedProfile) return; // 프로필을 못 불러온 상태에선 확정을 미룸
    const now = Date.now();
    saveWalkState({ m: currentWalkMeters(), at: now });
  }
  function fmtWalkDist(m) { return m < 1000 ? m.toFixed(2) + 'm' : (m / 1000).toFixed(3) + 'km'; }
  function tickWalk() {
    const els = document.querySelectorAll('[data-walk-dist]');
    if (!els.length) return;
    const txt = fmtWalkDist(currentWalkMeters());
    els.forEach((el) => { el.textContent = txt; });
  }

  function getTotalRunKm() { return Math.max(cachedProfile?.distanceRunKm || 0, 0); }

  function getUnlockedItems(km) {
    return ITEM_CATALOG.filter((i) => i.unlockKm <= km + 1e-9);
  }

  // 부위별로 해금된 것 중 가장 높은 등급 하나가 장착됨 (같은 부위에서 더 좋은 게 나오면 자동 진화)
  function getEquippedItems(km) {
    const equipped = {};
    getUnlockedItems(km).concat(getOwnedPremium()).forEach((it) => {
      if (!equipped[it.slot] || it.tier >= equipped[it.slot].tier) equipped[it.slot] = it;
    });
    return equipped;
  }

  function getNextItem(km) {
    return ITEM_CATALOG.find((i) => i.unlockKm > km + 1e-9) || null;
  }

  // 이번 러닝으로 (prevKm → prevKm+gainKm) 새로 해금된 아이템들
  function getNewlyUnlocked(prevKm, gainKm) {
    return ITEM_CATALOG.filter((i) => i.unlockKm > prevKm + 1e-9 && i.unlockKm <= prevKm + gainKm + 1e-9);
  }

  // 고급 아이템 아이콘
  function premiumGlyphSvg(item) {
    let inner = '';
    switch (item.id) {
      case 'p_halo':
        inner = '<ellipse cx="24" cy="27" rx="17" ry="7" fill="none" stroke="#FFE98A" stroke-width="4.5"/><ellipse cx="24" cy="25.6" rx="17" ry="7" fill="none" stroke="#fff" stroke-width="1.2" opacity=".75"/><path d="M8 10l1.4 3 3 1.4-3 1.4L8 19l-1.4-3.2-3-1.4 3-1.4z" fill="#FFF3B0"/><path d="M40 33l1 2.2 2.2 1-2.2 1L40 39.5l-1-2.3-2.2-1 2.2-1z" fill="#FFF3B0"/>';
        break;
      case 'p_holovisor':
        inner = '<rect x="3" y="15" width="42" height="19" rx="9.5" fill="#00E5FF"/><rect x="7" y="19" width="34" height="11" rx="5.5" fill="#052033"/><path d="M11 24.5h26" stroke="#7DF9FF" stroke-width="1.6"/><path d="M12 21.5h9M27 27.5h9" stroke="#fff" stroke-width="1.6" opacity=".55" stroke-linecap="round"/>';
        break;
      case 'p_lightboots':
        inner = '<path d="M14 5h15v22l13 7v9H8z" fill="#FFE066"/><rect x="8" y="38" width="34" height="5" rx="2" fill="#fff"/><path d="M27 8l-8 14h6l-4 12 12-17h-7z" fill="#B45309"/><rect x="14" y="5" width="15" height="4" fill="#fff" opacity=".5"/>';
        break;
      case 'p_wings':
        inner = '<path d="M22 36C10 36 4 24 3 8c9 3 15 9 19 20z" fill="#EAF2FF"/><path d="M26 36c12 0 18-12 19-28-9 3-15 9-19 20z" fill="#EAF2FF"/><path d="M20 30C14 24 10 18 8 13M28 30c6-6 10-12 12-17" stroke="#9DB8FF" stroke-width="1.6" fill="none" stroke-linecap="round"/><circle cx="24" cy="38" r="3" fill="#FFE98A"/>';
        break;
      case 'p_nebula':
        inner = '<path d="M6 36L8 12l10 10 6-15 6 15 10-10 2 24z" fill="#7C5CFF" stroke="#38F2FF" stroke-width="1.8" stroke-linejoin="round"/><circle cx="24" cy="27" r="3.4" fill="#FFF3B0"/><circle cx="13" cy="30" r="2" fill="#38F2FF"/><circle cx="35" cy="30" r="2" fill="#FF5CCB"/>';
        break;
      case 'p_cybersuit':
        inner = '<path d="M15 6Q24 13 33 6L45 15L39 22L35 19V42H13V19L9 22L3 15z" fill="#141B3A" stroke="#38F2FF" stroke-width="1.8" stroke-linejoin="round"/><path d="M24 12v30" stroke="#38F2FF" stroke-width="1.6"/><circle cx="24" cy="26" r="4.5" fill="#38F2FF"/><circle cx="24" cy="26" r="2" fill="#fff"/>';
        break;
      case 'p_baton':
        inner = '<rect x="20" y="4" width="8" height="40" rx="4" fill="#C58BFF"/><rect x="22.5" y="6" width="3" height="36" rx="1.5" fill="#fff" opacity=".85"/><path d="M14 14l-4 4 4 4M34 26l4 4-4 4" stroke="#FFF3B0" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
        break;
      case 'p_flameaura':
        inner = '<path d="M24 3C29 12 38 16 36 28C35 37 29 44 24 45C19 44 13 37 12 28C10 18 19 14 24 3z" fill="#FF7A45"/><path d="M24 17C27 23 32 26 31 32C30 37 27 40 24 41C21 40 18 37 17 32C16 26 21 23 24 17z" fill="#FFD60A"/><path d="M24 28c2 3 3 5 2 8-1 1-3 1-4 0-1-3 0-5 2-8z" fill="#fff" opacity=".8"/>';
        break;
      default:
        inner = `<circle cx="24" cy="24" r="12" fill="${item.color}"/>`;
    }
    const sparkle = '<path d="M41 4l1.6 3.6L46 9l-3.4 1.4L41 14l-1.6-3.6L36 9l3.4-1.4z" fill="#FFF3B0"/><path d="M6 6l1.1 2.4L9.5 9.5 7.1 10.6 6 13l-1.1-2.4L2.5 9.5l2.4-1.1z" fill="#FFF3B0"/>';
    return `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><defs><filter id="ig-glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><g filter="url(#ig-glow)">${inner}</g>${sparkle}</svg>`;
  }

  // 아이템 하나를 작은 아이콘(SVG)으로 그림 - 부위와 등급에 따라 모양이 달라짐
  function itemGlyphSvg(item) {
    if (item.premium) return premiumGlyphSvg(item);
    const c = item.color;
    const dark = 'rgba(0,0,0,0.3)';
    let inner = '';
    switch (item.slot) {
      case 'head':
        if (item.tier === 1) inner = `<rect x="7" y="20" width="34" height="9" rx="4.5" fill="${c}"/><rect x="7" y="24" width="34" height="2" fill="#fff" opacity=".35"/>`;
        else if (item.tier === 2) inner = `<path d="M9 31a15 15 0 0 1 30 0z" fill="${c}"/><rect x="24" y="29" width="20" height="4" rx="2" fill="${c}" opacity=".7"/><circle cx="24" cy="17" r="2" fill="#fff" opacity=".6"/>`;
        else if (item.tier === 3) inner = `<path d="M9 29a15 13 0 0 1 30 0z" fill="${c}"/><rect x="8" y="28" width="32" height="3" fill="${dark}"/><rect x="22" y="29" width="24" height="4" rx="2" fill="#fff" opacity=".9"/>`;
        else inner = `<path d="M7 35 L10 14 L19 24 L24 9 L29 24 L38 14 L41 35z" fill="${c}" stroke="#B8860B" stroke-width="1.6" stroke-linejoin="round"/><circle cx="24" cy="27" r="3" fill="#FF4D6D"/><circle cx="14" cy="29" r="2" fill="#4FD8FF"/><circle cx="34" cy="29" r="2" fill="#4FD8FF"/>`;
        break;
      case 'face':
        if (item.tier === 1) inner = `<circle cx="15" cy="26" r="7.5" fill="none" stroke="${c}" stroke-width="3"/><circle cx="33" cy="26" r="7.5" fill="none" stroke="${c}" stroke-width="3"/><path d="M22 25h4" stroke="${c}" stroke-width="3"/>`;
        else if (item.tier === 2) inner = `<rect x="5" y="19" width="17" height="13" rx="5.5" fill="${c}"/><rect x="26" y="19" width="17" height="13" rx="5.5" fill="${c}"/><rect x="21" y="23" width="6" height="3" fill="${c}"/><path d="M9 23h6M30 23h6" stroke="#fff" stroke-width="2" opacity=".4"/>`;
        else inner = `<rect x="4" y="16" width="40" height="20" rx="10" fill="${c}"/><rect x="8" y="20" width="32" height="12" rx="6" fill="#0d2233"/><path d="M12 24h8M28 24h6" stroke="#fff" stroke-width="2" opacity=".6"/>`;
        break;
      case 'neck':
        if (item.tier === 1) inner = `<rect x="8" y="17" width="32" height="15" rx="7.5" fill="${c}"/><path d="M15 17v15M24 17v15M33 17v15" stroke="${dark}" stroke-width="2"/>`;
        else inner = `<rect x="7" y="14" width="34" height="11" rx="5.5" fill="${c}"/><path d="M29 22l6 20h-9l-1-20z" fill="${c}"/><path d="M27 32h8" stroke="#fff" stroke-width="2" opacity=".5"/>`;
        break;
      case 'torso':
        if (item.tier === 1) inner = `<path d="M12 9L20 7Q24 14 28 7L36 9L35 41H13z" fill="${c}"/><path d="M24 12v29" stroke="${dark}" stroke-width="2"/>`;
        else if (item.tier === 2) inner = `<path d="M16 7Q24 14 32 7L44 15L38 22L34 19V41H14V19L10 22L4 15z" fill="${c}"/><rect x="14" y="30" width="20" height="3" fill="#fff" opacity=".4"/>`;
        else if (item.tier === 3) inner = `<path d="M16 7Q24 14 32 7L44 15L38 22L34 19V41H14V19L10 22L4 15z" fill="${c}"/><path d="M24 11v30" stroke="#fff" stroke-width="2" opacity=".8"/><rect x="16" y="30" width="6" height="5" rx="1" fill="${dark}"/><rect x="26" y="30" width="6" height="5" rx="1" fill="${dark}"/>`;
        else inner = `<path d="M13 7Q24 12 35 7L45 43Q24 34 3 43z" fill="${c}"/><circle cx="24" cy="10" r="3.2" fill="#FFD60A"/><path d="M14 30Q24 36 34 30" stroke="#fff" stroke-width="2" fill="none" opacity=".4"/>`;
        break;
      case 'arms':
        inner = `<rect x="16" y="5" width="16" height="38" rx="8" fill="${c}"/><rect x="16" y="14" width="16" height="3" fill="#fff" opacity=".5"/>` +
          (item.tier >= 2 ? `<rect x="16" y="24" width="16" height="3" fill="#fff" opacity=".5"/><rect x="16" y="34" width="16" height="3" fill="#fff" opacity=".5"/>` : '');
        break;
      case 'wrist':
        if (item.tier === 1) inner = `<rect x="7" y="19" width="34" height="11" rx="5.5" fill="${c}"/><rect x="7" y="23" width="34" height="2.5" fill="#fff" opacity=".4"/>`;
        else inner = `<rect x="17" y="5" width="14" height="38" rx="4" fill="#2b2f36"/><rect x="12" y="14" width="24" height="20" rx="6" fill="#111" stroke="${c}" stroke-width="2.5"/><path d="M17 27l4-5 3 3 4-6" stroke="${c}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
        break;
      case 'hand':
        if (item.tier === 1) inner = `<rect x="16" y="12" width="16" height="31" rx="5" fill="${c}"/><rect x="20" y="5" width="8" height="9" rx="2" fill="#fff" opacity=".85"/><rect x="16" y="23" width="16" height="7" fill="#fff" opacity=".35"/>`;
        else inner = `<rect x="14" y="7" width="20" height="35" rx="5" fill="${c}"/><rect x="14" y="7" width="20" height="5" rx="2" fill="#fff" opacity=".5"/><path d="M26 15l-7 12h6l-3 11 10-14h-6z" fill="#1a1a1a"/>`;
        break;
      case 'legs':
        if (item.tier === 1) inner = `<rect x="6" y="14" width="15" height="19" rx="7" fill="${c}"/><rect x="27" y="14" width="15" height="19" rx="7" fill="${c}"/><rect x="6" y="21" width="15" height="3" fill="#fff" opacity=".4"/><rect x="27" y="21" width="15" height="3" fill="#fff" opacity=".4"/>`;
        else inner = `<path d="M11 6H37L35 43H27L24 21L21 43H13z" fill="${c}"/><path d="M11 12H37" stroke="#fff" stroke-width="2" opacity=".4"/>`;
        break;
      case 'feet':
        if (item.tier === 1) inner = `<path d="M16 5h15v24l11 7v7H12z" fill="${c}"/><rect x="16" y="9" width="15" height="4" fill="#FF6B5E"/><rect x="16" y="15" width="15" height="4" fill="#FF6B5E"/>`;
        else if (item.tier === 2) inner = `<path d="M6 26L21 22L28 29L43 32Q45 40 40 40H6z" fill="${c}"/><rect x="6" y="36" width="37" height="5" rx="2" fill="#fff"/><path d="M14 30l8-2" stroke="#fff" stroke-width="2" opacity=".6"/>`;
        else inner = `<path d="M6 24L21 19L29 27L44 30Q46 39 41 39H6z" fill="${c}"/><rect x="6" y="35" width="38" height="6" rx="3" fill="#fff"/><path d="M12 30Q22 22 32 31" stroke="#FFD60A" stroke-width="2.4" fill="none" stroke-linecap="round"/>`;
        break;
      default:
        inner = `<circle cx="24" cy="24" r="12" fill="${c}"/>`;
    }
    const glow = item.tier >= 3 ? ' filter="url(#ig-glow)"' : '';
    const sparkle = item.tier >= 4
      ? '<path d="M41 4l1.6 3.6L46 9l-3.4 1.4L41 14l-1.6-3.6L36 9l3.4-1.4z" fill="#FFF3B0"/><path d="M6 6l1.1 2.4L9.5 9.5 7.1 10.6 6 13l-1.1-2.4L2.5 9.5l2.4-1.1z" fill="#FFF3B0"/>'
      : '';
    return `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><defs><filter id="ig-glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><g${glow}>${inner}</g>${sparkle}</svg>`;
  }

  // 캐릭터(뛰는 러너)를 그림 - 장착 아이템은 부위별 최고 등급이 반영돼서 진화할수록 화려해짐
  function buildRunnerSvg(level, equipped, px) {
    const muscle = 1 + level.idx * 0.18;   // 레벨이 올라갈수록 팔다리가 굵어짐(근육)
    const heightScale = 1 + level.idx * 0.05; // 레벨이 올라갈수록 키가 살짝 커짐
    const legW = +(10 * muscle).toFixed(1);
    const armW = +(7 * muscle).toFixed(1);
    const torsoW = +(32 * muscle).toFixed(1);
    // 고급 아이템(ep)은 기본 아이템(e)과 따로 그려서 같은 부위의 기본 아이템을 대체해요
    const eAll = equipped || {};
    const e = {};
    const ep = {};
    Object.keys(eAll).forEach((s) => { (eAll[s].premium ? ep : e)[s] = eAll[s]; });
    if (ep.halo && ep.halo.id === 'p_nebula' && e.head && e.head.tier >= 3) delete e.head; // 왕관끼리 겹치지 않게
    const glow = (item, s) => (item && item.tier >= 3 ? `<g filter="url(#rg-glow)">${s}</g>` : s);

    // 몸통 뒤 (망토)
    let behind = '';
    if (e.torso && e.torso.tier >= 4) {
      behind = `<path d="M${100 - torsoW / 2 - 2} 64 Q100 58 ${100 + torsoW / 2 + 2} 64 L${100 + torsoW / 2 + 24} 140 Q100 152 ${100 - torsoW / 2 - 24} 140Z" fill="${e.torso.color}" opacity="0.95"/>`;
    }

    // 몸통 뒤에 깔리는 효과 (오라 / 날개)
    let behindFx = '';
    if (ep.aura) {
      behindFx += `<ellipse class="runner-aura" cx="100" cy="112" rx="60" ry="94" fill="url(#rg-aura)"/><path class="runner-aura" d="M54 152C46 122 60 102 52 76C70 90 72 108 70 130z M146 152C154 122 140 102 148 76C130 90 128 108 130 130z" fill="#FF7A45" opacity=".6"/>`;
    }
    if (ep.back) {
      const wing = `<g class="runner-wing" style="transform-origin:96px 82px;"><path d="M96 78C74 70 50 66 30 42C28 66 40 92 66 102C78 106 90 100 96 96z" fill="#EAF2FF" opacity=".96"/><path d="M92 84C76 80 58 74 42 58M90 92C76 92 62 88 50 78" stroke="#B8CCFF" stroke-width="2" fill="none" stroke-linecap="round"/></g>`;
      behindFx += `<g filter="url(#rg-glow)">${wing}<g transform="translate(200 0) scale(-1 1)">${wing}</g></g>`;
    }

    // 다리에 붙는 것들 (다리 애니메이션 그룹 안에 넣어서 같이 움직임)
    const legX = 100 - legW / 2;
    let legExtra = '';
    if (e.legs) {
      if (e.legs.tier === 1) legExtra += `<rect x="${legX - 2}" y="138" width="${legW + 4}" height="13" rx="5" fill="${e.legs.color}"/><rect x="${legX - 2}" y="143" width="${legW + 4}" height="2.5" fill="#fff" opacity=".4"/>`;
      else legExtra += `<rect x="${legX - 1}" y="118" width="${legW + 2}" height="52" rx="${(legW + 2) / 2}" fill="${e.legs.color}" opacity=".95"/><rect x="${legX - 1}" y="140" width="${legW + 2}" height="2.5" fill="#fff" opacity=".4"/>`;
    }
    if (ep.feet) {
      legExtra += glow(ep.feet, `<rect x="${legX - 2}" y="160" width="${legW + 14}" height="14" rx="6" fill="#FFE066"/><rect x="${legX - 2}" y="170" width="${legW + 14}" height="4" rx="2" fill="#fff"/><path d="M${(legX + legW / 2 + 2).toFixed(1)} 161l-5 8h4l-3 6 8-9h-4z" fill="#B45309"/>`);
    } else if (e.feet) {
      const f = e.feet;
      if (f.tier === 1) legExtra += `<rect x="${legX - 1}" y="155" width="${legW + 2}" height="18" rx="4" fill="${f.color}"/><rect x="${legX - 1}" y="158" width="${legW + 2}" height="3" fill="#FF6B5E"/>`;
      else legExtra += glow(f, `<rect x="${legX - 2}" y="163" width="${legW + 13}" height="11" rx="5" fill="${f.color}"/><rect x="${legX - 2}" y="171" width="${legW + 13}" height="4" rx="2" fill="#fff"/>` +
        (f.tier >= 3 ? `<path d="M${legX + 1} 168Q${legX + legW / 2 + 5} 164 ${legX + legW + 8} 169" stroke="#FFD60A" stroke-width="2" fill="none" stroke-linecap="round"/>` : ''));
    }
    const legGroup = (cls) => `<g class="${cls}" style="transform-origin:100px 118px;"><rect x="${legX.toFixed(1)}" y="118" width="${legW}" height="55" rx="${legW / 2}" fill="${level.color}"/>${legExtra}</g>`;

    // 몸통 위에 덮는 옷
    let torsoOverlay = '';
    if (ep.torso) {
      const x = (100 - torsoW / 2).toFixed(1);
      torsoOverlay = glow(ep.torso, `<rect x="${x}" y="60" width="${torsoW}" height="60" rx="16" fill="#141B3A" stroke="#38F2FF" stroke-width="1.6"/><path d="M100 64V118M${(100 - torsoW / 2 + 6).toFixed(1)} 76L100 84L${(100 + torsoW / 2 - 6).toFixed(1)} 76" stroke="#38F2FF" stroke-width="1.6" fill="none"/><circle cx="100" cy="92" r="6" fill="#38F2FF"/><circle cx="100" cy="92" r="2.6" fill="#fff"/>`);
    } else if (e.torso) {
      const t = e.torso;
      const x = (100 - torsoW / 2).toFixed(1);
      if (t.tier === 1) {
        torsoOverlay = `<rect x="${x}" y="66" width="${torsoW}" height="46" rx="12" fill="${t.color}" opacity="0.93"/><line x1="100" y1="68" x2="100" y2="110" stroke="rgba(0,0,0,.25)" stroke-width="2"/>`;
      } else {
        torsoOverlay = glow(t, `<rect x="${x}" y="60" width="${torsoW}" height="60" rx="16" fill="${t.color}"/><rect x="${x}" y="88" width="${torsoW}" height="5" fill="#fff" opacity=".35"/>` +
          (t.tier >= 3 ? `<line x1="100" y1="62" x2="100" y2="118" stroke="#fff" stroke-opacity=".75" stroke-width="2"/>` : '') +
          (t.tier >= 4 ? `<circle cx="100" cy="64" r="4.5" fill="#FFD60A"/>` : ''));
      }
    }

    // 팔에 붙는 것들 (팔토시 / 손목 / 손에 든 것)
    const armX = 100 - armW / 2;
    let armExtra = '';
    if (e.arms) {
      armExtra += `<rect x="${(armX - 1.5).toFixed(1)}" y="70" width="${armW + 3}" height="26" rx="${(armW + 3) / 2}" fill="${e.arms.color}" opacity=".93"/>` +
        (e.arms.tier >= 2 ? `<rect x="${(armX - 1.5).toFixed(1)}" y="80" width="${armW + 3}" height="3" fill="#fff" opacity=".6"/>` : '');
    }
    if (e.wrist) {
      armExtra += e.wrist.tier === 1
        ? `<rect x="${(armX - 2).toFixed(1)}" y="100" width="${armW + 4}" height="6" rx="3" fill="${e.wrist.color}"/>`
        : `<rect x="${(armX - 2).toFixed(1)}" y="99" width="${armW + 4}" height="9" rx="3" fill="#111" stroke="${e.wrist.color}" stroke-width="1.6"/>`;
    }
    const handItem = ep.hand
      ? glow(ep.hand, `<rect x="97" y="94" width="6" height="36" rx="3" fill="#C58BFF"/><rect x="98.6" y="96" width="2.8" height="32" rx="1.4" fill="#fff" opacity=".85"/>`)
      : e.hand
      ? (e.hand.tier === 1
        ? `<rect x="96" y="108" width="8" height="15" rx="3" fill="${e.hand.color}"/><rect x="97.5" y="105" width="5" height="4" rx="1.5" fill="#fff" opacity=".85"/>`
        : `<rect x="95.5" y="108" width="9" height="16" rx="2.5" fill="${e.hand.color}"/><path d="M101 111l-3 5h2.5l-1.5 5 4.5-6.5h-3z" fill="#1a1a1a"/>`)
      : '';

    // 머리 위 / 얼굴 / 목
    let headItem = '';
    if (e.head) {
      const h = e.head;
      if (h.tier === 1) headItem = `<rect x="80" y="27" width="40" height="7" rx="3.5" fill="${h.color}"/>`;
      else if (h.tier === 2) headItem = `<path d="M79 33A21 19 0 0 1 121 33Z" fill="${h.color}"/><rect x="99" y="31" width="30" height="5" rx="2.5" fill="${h.color}" opacity=".8"/>`;
      else if (h.tier === 3) headItem = glow(h, `<path d="M79 31A21 17 0 0 1 121 31Z" fill="${h.color}"/><rect x="78" y="30" width="44" height="3" fill="rgba(0,0,0,.3)"/><rect x="99" y="30" width="32" height="5" rx="2.5" fill="#fff"/>`);
      else headItem = glow(h, `<path d="M80 31L82 12L91 21L100 6L109 21L118 12L120 31Z" fill="#FFD60A" stroke="#B8860B" stroke-width="1.5" stroke-linejoin="round"/><circle cx="100" cy="22" r="2.6" fill="#FF4D6D"/>`);
    }
    let faceItem = '';
    if (ep.face) {
      faceItem = glow(ep.face, `<rect x="77" y="34" width="46" height="14" rx="7" fill="#00E5FF" opacity=".92"/><rect x="81" y="37" width="38" height="8" rx="4" fill="#052033"/><path d="M84 41h32" stroke="#7DF9FF" stroke-width="1.6"/>`);
    } else if (e.face) {
      const f = e.face;
      if (f.tier === 1) faceItem = `<circle cx="91" cy="41" r="5.5" fill="none" stroke="${f.color}" stroke-width="2"/><circle cx="109" cy="41" r="5.5" fill="none" stroke="${f.color}" stroke-width="2"/><line x1="96" y1="41" x2="104" y2="41" stroke="${f.color}" stroke-width="2"/>`;
      else if (f.tier === 2) faceItem = `<rect x="80" y="36" width="40" height="10" rx="5" fill="${f.color}"/><rect x="84" y="38" width="10" height="2" fill="#fff" opacity=".4"/>`;
      else faceItem = glow(f, `<rect x="78" y="34" width="44" height="14" rx="7" fill="${f.color}"/><rect x="81" y="37" width="38" height="8" rx="4" fill="#0d2233"/><rect x="86" y="39" width="10" height="2" fill="#fff" opacity=".6"/>`);
    }
    let neckItem = '';
    if (e.neck) {
      neckItem = `<rect x="88" y="56" width="24" height="8" rx="4" fill="${e.neck.color}"/>` +
        (e.neck.tier >= 2 ? `<rect x="104" y="60" width="7" height="22" rx="3" fill="${e.neck.color}"/>` : '');
    }

    // 머리 위 후광 / 왕관 (고급)
    let haloItem = '';
    if (ep.halo) {
      haloItem = ep.halo.id === 'p_nebula'
        ? `<g filter="url(#rg-glow)"><path d="M79 28L79 6L90 17L100 2L110 17L121 6L121 28z" fill="#7C5CFF" stroke="#38F2FF" stroke-width="1.6" stroke-linejoin="round"/><circle cx="100" cy="15" r="3" fill="#FFF3B0"/><circle cx="87" cy="21" r="1.8" fill="#38F2FF"/><circle cx="113" cy="21" r="1.8" fill="#FF5CCB"/></g>`
        : `<ellipse cx="100" cy="13" rx="21" ry="6" fill="none" stroke="#FFE98A" stroke-width="4" filter="url(#rg-glow)"/><ellipse cx="100" cy="12" rx="21" ry="6" fill="none" stroke="#fff" stroke-width="1" opacity=".7"/>`;
    }

    return `<svg viewBox="0 0 200 200" width="${px}" height="${px}" style="transform: scaleY(${heightScale}); transform-origin: bottom center;">
      <defs><filter id="rg-glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <radialGradient id="rg-aura" cx="50%" cy="55%" r="50%"><stop offset="50%" stop-color="#FF7A45" stop-opacity="0"/><stop offset="85%" stop-color="#FF7A45" stop-opacity=".5"/><stop offset="100%" stop-color="#FFD60A" stop-opacity="0"/></radialGradient></defs>
      <g class="runner-bob">
        ${behindFx}${behind}
        ${legGroup('runner-leg-back')}
        ${legGroup('runner-leg-front')}
        <rect x="${(100 - torsoW / 2).toFixed(1)}" y="60" width="${torsoW}" height="60" rx="16" fill="${level.color}"/>
        ${torsoOverlay}
        <g class="runner-arm-back" style="transform-origin:100px 68px;">
          <rect x="${armX.toFixed(1)}" y="68" width="${armW}" height="45" rx="${armW / 2}" fill="#F4C6A0"/>${armExtra}
        </g>
        <g class="runner-arm-front" style="transform-origin:100px 68px;">
          <rect x="${armX.toFixed(1)}" y="68" width="${armW}" height="45" rx="${armW / 2}" fill="#F4C6A0"/>${armExtra}${handItem}
        </g>
        <circle cx="100" cy="42" r="20" fill="#F4C6A0"/>
        ${neckItem}${faceItem}${headItem}${haloItem}
      </g>
    </svg>`;
  }

  // 받침 여부에 따라 조사를 붙여요 (예: 홀로 바이저 + 를 / 배턴 + 을)
  function josa(word, withBatchim, without) {
    const c = String(word || '').trim().slice(-1).charCodeAt(0);
    const has = c >= 0xAC00 && c <= 0xD7A3 && (c - 0xAC00) % 28 !== 0;
    return has ? withBatchim : without;
  }

  function fmtKm(km) { return (Math.round(km * 10) / 10).toFixed(1); }

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
  let xwWant = 0, xwBaseline = 0, xwToken = 0, xwTimer = null, xwPending = false, xwDir = 0, xwPrevCount = 0; // 횡단보도 개수 스테퍼 상태
  let mapHelper = null;   // route.js의 renderOnMap 결과 (MapLibre)
  let watchId = null;
  let elapsedTimer = null; // 러닝 중 경과시간(스톱워치) 1초마다 갱신하는 인터벌
  let paceAnnounceTimer = null; // 설정한 간격마다 페이스/거리를 음성으로 알려주는 인터벌
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
  // 경로 위 "내 진짜 위치" 추적: GPS 위치를 경로에 붙여서(스냅) 진행 위치를 정함
  let navProgressM = 0;      // 경로 시작부터 지금까지 온 거리(m) - 뒤로는 줄어들지 않음
  let navPos = null;         // 지도/AR에서 "내 위치"로 쓰는 좌표 (경로 위에 붙었으면 경로 위 점, 벗어났으면 실제 GPS)
  let offRouteM = 0;         // 경로에서 떨어진 거리(m)
  let offRouteCount = 0;     // 연속으로 경로에서 벗어난 GPS 횟수
  let lastSnapAt = 0;
  let lastOffRouteWarnAt = 0;
  let distAnchor = null;     // 달린 거리 계산용 기준점 (노이즈 기준을 넘게 움직였을 때만 갱신)
  let homeMapObj = null;     // 홈 화면 지도(지난 경로 겹쳐보기) MapLibre 인스턴스
  let finishMapObj = null;   // 완료 화면 지도 MapLibre 인스턴스
  let paceSplits = [];       // 이번 러닝의 구간별 페이스 기록 (완료 화면 그래프용)
  let lastSplitMeters = 0;
  let lastSplitTime = 0;
  let splitMeta = [];        // 구간별 { startM, endM, start:{lat,lng}, end:{lat,lng} } - 러닝 분석(느려진 위치 찾기)용
  let stopEvents = [];       // 멈춰 섰던 곳 { lat, lng, sec, atM }
  let lastSplitPos = null;
  let lastMovingAt = null;
  let lastMovingPos = null;
  let stopSecSinceSplit = 0; // 현재 구간에서 멈춰 있던 시간(초) - 구간 "이동 페이스" 계산용

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
    $('profile-voice-toggle').checked = localStorage.getItem(VOICE_MUTE_KEY) !== '1';
    renderPaceIntervalChips();
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

  // 페이스/거리 음성 안내 간격 선택 칩 - 러닝 중이면 즉시 타이머를 다시 맞춤
  function renderPaceIntervalChips() {
    const saved = parseInt(localStorage.getItem(PACE_INTERVAL_KEY), 10) || 0;
    const chipsEl = $('pace-interval-chips');
    chipsEl.innerHTML = '';
    const options = [{ key: 0, label: '끄기' }, { key: 1, label: '1분' }, { key: 3, label: '3분' }, { key: 5, label: '5분' }, { key: 10, label: '10분' }];
    options.forEach((opt) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'crosswalk-chip' + (opt.key === saved ? ' active' : '');
      chip.textContent = opt.label;
      chip.addEventListener('click', () => {
        localStorage.setItem(PACE_INTERVAL_KEY, String(opt.key));
        renderPaceIntervalChips();
        if (paceAnnounceTimer !== null || document.querySelector('.screen.active')?.id === 'screen-run') startPaceAnnounceTimer();
      });
      chipsEl.appendChild(chip);
    });
  }

  /* ---------------- 2. 목적지/거리 설정 ---------------- */
  function announce(text) {
    if (!voiceMuted) Voice.speak(text);
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

  function resetNavState() {
    navProgressM = 0; navPos = null; offRouteM = 0; offRouteCount = 0; lastSnapAt = 0; lastOffRouteWarnAt = 0; distAnchor = null;
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
        resetNavState();
        goalCountedForThisRun = false;
        announcedTurnCount = 0;
        paceSplits = [];
        lastSplitMeters = 0;
        lastSplitTime = Date.now();
        splitMeta = [];
        stopEvents = [];
        lastSplitPos = lastPos ? { lat: lastPos.lat, lng: lastPos.lng } : null;
        lastMovingAt = null;
        lastMovingPos = null;
        stopSecSinceSplit = 0;
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
      // 센서 값이 떨리니까 이전 값과 섞어서 부드럽게 (0°/360° 경계는 짧은 쪽으로 돌게 계산)
      if (compassHeading !== null) {
        const diff = ((heading - compassHeading + 540) % 360) - 180;
        heading = (compassHeading + diff * 0.45 + 360) % 360;
      }
      compassHeading = heading;

      const now = Date.now();
      if (now - lastCompassApply < 100) return; // 너무 잦은 갱신은 성능상 스킵
      lastCompassApply = now;
      currentBearing = heading;

      // 움직이는 중이든 서 있든, 몸을 돌리면 지도가 바로 같이 돌게 함 (카메라는 내 위치 앞쪽을 계속 보게)
      if (mapHelper) {
        const here = navPos || lastPos;
        if (here) {
          const la = RouteEngine.destinationPoint(here, heading, 38);
          mapHelper.map.jumpTo({ center: [la.lng, la.lat], bearing: heading });
        } else {
          mapHelper.map.setBearing(heading);
        }
      }
      // AR 모드면 GPS 갱신을 기다리지 않고 방향이 바뀔 때마다 바로 다시 그림 -
      // 안 그러면 제자리에서 몸만 돌렸을 때 다음 GPS 신호가 올 때까지 화살표가 그대로 있게 됨
      if (arModeEnabled && lastPos) {
        if (arUsingXr) ArXR.updatePath(getLookaheadPathPoints());
        else updateArOverlay(navPos || lastPos, heading);
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
  function renderPremiumBanner() {
    const el = $('premium-run-banner');
    if (!el) return;
    if (!premiumRun) { el.classList.add('hidden'); return; }
    const need = premiumRun.km;
    let sub = `${need}km 코스를 완주하면 받아요`;
    if (premiumRun.routeKm && premiumRun.routeKm < need * PREMIUM_MIN_RATIO) {
      sub = `이 경로는 ${premiumRun.routeKm.toFixed(1)}km라 ${need}km 조건에 못 미쳐요. 뒤로 가서 다시 만들어 보세요`;
    } else if (premiumRun.routeKm) {
      sub = `경로 ${premiumRun.routeKm.toFixed(1)}km · 끝까지 완주하면 받아요`;
    } else {
      sub = `${need}km 경로를 만드는 중이에요`;
    }
    el.innerHTML = `<div class="pm-banner-title">고급 아이템 도전 · ${escapeHtml(premiumRun.name)}</div><div class="pm-banner-sub">${escapeHtml(sub)}</div>`;
    el.classList.remove('hidden');
  }

  // 고급 아이템 코스 시작: 근처에 그 거리만큼의 순환 경로를 만들고 러닝 준비 화면으로
  function startPremiumRun(id) {
    const it = PREMIUM_ITEMS.find((i) => i.id === id);
    if (!it || getOwnedPremiumIds().has(id)) return;
    prepareRoute({ type: 'distance_only', distance: it.runKm }, { premium: it });
  }

  async function prepareRoute(cmd, opts = {}) {
    premiumRun = opts.premium ? { id: opts.premium.id, name: opts.premium.name, km: opts.premium.runKm, routeKm: 0 } : null;
    showScreen('screen-run');
    renderPremiumBanner();
    announce('경로를 준비하고 있어요.');
    faceMarkerObj = null;
    traveledMeters = 0;
    resetNavState();
    $('turn-banner').classList.add('hidden');
    $('btn-start-run').classList.add('hidden');
    $('btn-start-run').disabled = false;
    $('route-ready-sub').textContent = '경로가 준비됐어요';
    $('crosswalk-selector').classList.add('hidden');
    xwToken += 1;
    xwPending = false;
    clearTimeout(xwTimer);

    navigator.geolocation.getCurrentPosition(async (pos) => {
      const start = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      lastPos = start; // 검색 기준점을 내 실제 현재 위치로 즉시 반영
      try {
        if (cmd.type === 'destination_with_distance') {
          // destPoint: 목적지 검색 화면에서 사용자가 직접 고른 장소(좌표). 음성 입력일 때만 이름으로 다시 검색함
          const dest = cmd.destPoint || await geocode(cmd.destination, start);
          route = await RouteEngine.buildRouteToDestination(start, dest, cmd.distance);
        } else if (cmd.type === 'distance_only') {
          route = await RouteEngine.buildLoopRoute(start, cmd.distance);
          // 고급 아이템 코스는 목표 거리에 충분히 가까워야 하니, 많이 짧게 나오면 한 번 더 길게 만들어 봄
          if (premiumRun && route.distanceMeters < premiumRun.km * 1000 * 0.92) {
            try {
              const scaled = Math.min(cmd.distance * (cmd.distance * 1000 / Math.max(route.distanceMeters, 1000)), cmd.distance * 1.3);
              const retry = await RouteEngine.buildLoopRoute(start, scaled);
              if (retry && retry.distanceMeters > route.distanceMeters) route = retry;
            } catch (e) { /* 재시도 실패하면 처음 경로 그대로 */ }
          }
        } else if (cmd.type === 'destination_only') {
          const dest = cmd.destPoint || await geocode(cmd.destination, start);
          route = await RouteEngine.buildDestinationRoute(start, dest);
        }
        drawRoute(route);

        // 경로가 이미 채점된 경우(공원 경유/왕복 후보 비교)엔 crosswalkCount가 붙어있고,
        // 아니면 여기서 한 번 계산해서 시작 전에 미리 보여줌
        if (typeof route.crosswalkCount !== 'number') {
          const result = await RouteEngine.countCrosswalksNear(route.points);
          route.crosswalkCount = result.count;
          route.crosswalkDataOk = result.ok;
          route.crosswalkTmap = result.tmap;
        }
        xwBaseline = route.crosswalkCount;
        xwWant = route.crosswalkCount;
        showCrosswalkInfo(route);
        $('xw-status').textContent = crosswalkMessage(route);
        renderXwWarn();
        announce(`경로 준비됐어요. ${crosswalkMessage(route)}. 시작 버튼을 눌러주세요.`);
        $('btn-start-run').classList.remove('hidden');
      } catch (e) {
        announce('경로를 만드는 데 실패했어요. ' + e.message);
      }
    }, () => announce('위치 정보를 가져올 수 없어요. GPS를 켜주세요.'), { enableHighAccuracy: true });
  }

  // 지도/마커/거리 표시를 현재 route로 갱신
  function drawRoute(r) {
    mapHelper = RouteEngine.renderOnMap($('map-canvas'), r.points, mapHelper?.map);
    currentBearing = mapHelper.initialBearing || 0;
    updateMarker(0, currentBearing, false);
    $('stat-distance').textContent = (r.distanceMeters / 1000).toFixed(1) + 'km';
    if (premiumRun) { premiumRun.routeKm = r.distanceMeters / 1000; renderPremiumBanner(); }
  }

  // 횡단보도 안내 문구: 티맵 경로가 알려주는 횡단보도는 지도 데이터가 실패해도 세기 때문에,
  // "확인 못했다"는 말은 정말로 아무 정보도 없을 때(0개 + 데이터 실패)만 씀
  function crosswalkMessage(r) {
    const n = r.crosswalkCount;
    if (n > 0) return r.crosswalkDataOk === false ? `횡단보도 ${n}개 이상 예상돼요` : `횡단보도 ${n}개 예상돼요`;
    if (r.crosswalkDataOk === false) return '횡단보도 정보를 확인하지 못했어요 - 직접 살펴보며 뛰어주세요';
    return '횡단보도 없이 갈 수 있어요';
  }

  // 러닝 시작 버튼 문구/개수 스테퍼 표시
  function showCrosswalkInfo(r) {
    $('route-ready-sub').textContent = crosswalkMessage(r);
    $('xw-count').textContent = r.crosswalkCount;
    $('crosswalk-selector').classList.remove('hidden');
  }

  // 원래 경로보다 개수를 줄일수록 돌아가는/같은 곳을 도는 경로가 나오기 쉬워서, 줄인 정도에 따라 경고 강도를 올림
  function renderXwWarn() {
    const el = $('xw-warn');
    const diff = xwBaseline - xwWant;
    if (diff <= 0) { el.classList.add('hidden'); el.classList.remove('strong'); return; }
    const strong = diff >= 3 || (xwBaseline > 0 && diff / xwBaseline >= 0.5);
    el.classList.toggle('strong', strong);
    el.textContent = strong
      ? '주의: 개수를 많이 줄이면 같은 위치를 계속 빙빙 도는 경로가 나올 수 있어요. 지도에서 경로를 꼭 확인하세요.'
      : '개수를 줄이면 돌아가는 길이 늘거나 같은 곳을 다시 지나는 경로가 나올 수 있어요.';
    el.classList.remove('hidden');
  }

  // +/- 누를 때마다 숫자만 바로 바꾸고, 잠깐 멈추면(0.6초) 그 개수에 맞는 경로를 자동으로 다시 찾음
  function changeXw(delta) {
    if (!route) return;
    const next = Math.max(0, Math.min(40, xwWant + delta));
    if (next === xwWant) return;
    if (!xwPending) { xwPrevCount = route.crosswalkCount; } // 연타 중이면 맨 처음 실제 개수를 기준으로 유지
    xwPending = true;
    xwDir = delta;
    xwWant = next;
    $('xw-count').textContent = next;
    $('xw-status').textContent = '경로 다시 찾는 중…';
    $('btn-start-run').disabled = true;
    renderXwWarn();
    clearTimeout(xwTimer);
    xwTimer = setTimeout(applyXwWant, 600);
  }

  async function applyXwWant() {
    const token = ++xwToken;
    const want = xwWant;
    try {
      let next = await RouteEngine.refindRoute(route, want);
      if (token !== xwToken) return; // 그 사이에 또 바꿨으면 이 결과는 버림
      // 원하는 개수가 없어서 눌렀던 방향과 반대로 스냅됐다면(+를 눌렀는데 오히려 줄어드는 식), 그 방향으로 가장 가까운 다음 개수로 이동
      if (!next.exact && next.ctx?.pool) {
        const counts = next.ctx.pool.map((p) => p.crosswalkCount);
        const wrong = xwDir > 0 ? next.crosswalkCount <= xwPrevCount : next.crosswalkCount >= xwPrevCount;
        const dirCands = counts.filter((c) => (xwDir > 0 ? c > xwPrevCount : c < xwPrevCount));
        if (wrong && dirCands.length) {
          const alt = xwDir > 0 ? Math.min(...dirCands) : Math.max(...dirCands);
          next = await RouteEngine.refindRoute(next, alt);
          if (token !== xwToken) return;
        }
      }
      xwPending = false;
      route = next;
      drawRoute(route);
      const got = route.crosswalkCount;
      let msg = crosswalkMessage(route);
      if (got !== want) {
        // 정확히 그 개수인 경로가 없으면 가장 가까운 걸로 맞추고 숫자도 실제 값으로 되돌림
        xwWant = got;
        $('xw-count').textContent = got;
        msg = `${want}개인 경로는 못 찾아서 ${got}개 경로로 바꿨어요`;
      }
      $('xw-status').textContent = msg;
      $('route-ready-sub').textContent = crosswalkMessage(route);
      renderXwWarn();
      announce(got !== want ? msg : `횡단보도 ${got}개인 경로로 바꿨어요.`);
    } catch (e) {
      if (token !== xwToken) return;
      xwPending = false;
      $('xw-status').textContent = '경로를 다시 찾지 못했어요. 잠시 후 다시 시도해 주세요';
    } finally {
      if (token === xwToken) $('btn-start-run').disabled = false;
    }
  }

  /* ---------------- 목적지 검색 화면 (카카오 장소 자동완성) ---------------- */
  let destPicked = null;   // { name, address, lat, lng }
  let destWalkKm = null;   // 현재 위치 -> 목적지 걸어서 거리(km)
  let destTimer = null, destToken = 0;

  function destShowStep(step) {
    ['search', 'choice', 'distance'].forEach((s) => $('dest-step-' + s).classList.toggle('hidden', s !== step));
  }

  function openDestScreen() {
    showScreen('screen-dest');
    destShowStep('search');
    $('dest-input').value = '';
    $('dest-list').innerHTML = '';
    $('dest-status').textContent = '';
    $('dest-extra').value = '';
    $('dest-dist-input').value = '';
    $('dest-choice-err').textContent = '';
    $('dest-dist-err').textContent = '';
    destPicked = null; destWalkKm = null;
    // 검색 결과를 내 주변 기준으로 정렬하려고 현재 위치를 미리 받아둠
    if (!lastPos && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((p) => { lastPos = { lat: p.coords.latitude, lng: p.coords.longitude }; }, () => {}, { enableHighAccuracy: true, timeout: 8000 });
    }
    setTimeout(() => $('dest-input').focus(), 120);
  }

  async function fetchPlaceSuggestions(q) {
    try {
      const res = await fetch('/api/place-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: q, lat: lastPos?.lat, lng: lastPos?.lng }),
      });
      if (!res.ok) throw new Error('suggest ' + res.status);
      return (await res.json()).places || [];
    } catch (e) {
      // 새 API가 아직 배포 안 됐거나 실패하면 기존 주변 검색으로 대신함 (주소/거리 표시는 없음)
      const list = await RouteEngine.searchNearby(q, lastPos || { lat: 37.5665, lng: 126.978 });
      return (list || []).map((p) => ({ name: p.name, address: '', category: '', lat: p.lat, lng: p.lng, distance: null }));
    }
  }

  async function runDestSearch(q) {
    const token = ++destToken;
    const status = $('dest-status');
    const listEl = $('dest-list');
    q = q.trim();
    if (!q) { listEl.innerHTML = ''; status.textContent = ''; return; }
    status.textContent = '검색 중…';
    try {
      const places = await fetchPlaceSuggestions(q);
      if (token !== destToken) return;
      listEl.innerHTML = '';
      status.textContent = places.length ? '' : '검색 결과가 없어요. 다른 이름으로 검색해 보세요';
      places.forEach((p) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dest-item';
        const main = document.createElement('div');
        main.className = 'dest-item-main';
        const nm = document.createElement('div');
        nm.className = 'dest-item-name';
        nm.textContent = p.name;
        const sub = document.createElement('div');
        sub.className = 'dest-item-sub';
        sub.textContent = [p.category, p.address].filter(Boolean).join(' · ');
        main.appendChild(nm);
        if (sub.textContent) main.appendChild(sub);
        b.appendChild(main);
        if (typeof p.distance === 'number') {
          const km = document.createElement('div');
          km.className = 'dest-item-km';
          km.textContent = p.distance >= 1000 ? (p.distance / 1000).toFixed(1) + 'km' : p.distance + 'm';
          b.appendChild(km);
        }
        b.addEventListener('click', () => pickDest(p));
        listEl.appendChild(b);
      });
    } catch (e) {
      if (token !== destToken) return;
      status.textContent = '검색에 실패했어요. 잠시 후 다시 시도해 주세요';
    }
  }

  async function pickDest(p) {
    destPicked = p;
    destWalkKm = null;
    $('dest-picked-name').textContent = p.name;
    $('dest-picked-addr').textContent = p.address || '';
    $('dest-picked-dist').textContent = '걸어서 거리 계산 중…';
    $('dest-extra').value = '';
    $('dest-choice-err').textContent = '';
    destShowStep('choice');
    const token = ++destToken;
    try {
      let start = lastPos;
      if (!start) {
        start = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
          (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }), reject, { enableHighAccuracy: true, timeout: 8000 }));
        lastPos = start;
      }
      const r = await RouteEngine.fetchWalkRoute(start, { lat: p.lat, lng: p.lng });
      if (token !== destToken || destPicked !== p) return;
      destWalkKm = r.distanceMeters / 1000;
      $('dest-picked-dist').textContent = `걸어서 약 ${destWalkKm.toFixed(1)}km`;
      $('dest-extra').placeholder = `${destWalkKm.toFixed(1)}km보다 길게 입력`;
    } catch (e) {
      if (token !== destToken || destPicked !== p) return;
      $('dest-picked-dist').textContent = '거리를 계산하지 못했어요 (경로는 그대로 만들 수 있어요)';
    }
  }

  function startDestRoute(withDistance) {
    if (!destPicked) return;
    const point = { lat: destPicked.lat, lng: destPicked.lng };
    if (withDistance) {
      const km = parseFloat($('dest-extra').value);
      const err = $('dest-choice-err');
      if (!(km > 0)) { err.textContent = '거리를 숫자로 입력하거나, 건너뛰기를 눌러주세요'; return; }
      if (destWalkKm !== null && km <= destWalkKm + 0.2) {
        err.textContent = `목적지까지 이미 약 ${destWalkKm.toFixed(1)}km예요. 그보다 길게 입력하거나 건너뛰기를 눌러주세요`;
        return;
      }
      prepareRoute({ type: 'destination_with_distance', destination: destPicked.name, destPoint: point, distance: km });
    } else {
      prepareRoute({ type: 'destination_only', destination: destPicked.name, destPoint: point });
    }
  }

  function setupDestScreen() {
    $('btn-dest-back').addEventListener('click', () => {
      const choiceOpen = !$('dest-step-choice').classList.contains('hidden');
      const distOpen = !$('dest-step-distance').classList.contains('hidden');
      if (choiceOpen || distOpen) destShowStep('search');
      else showScreen('screen-setup');
    });
    $('dest-input').addEventListener('input', () => {
      clearTimeout(destTimer);
      destTimer = setTimeout(() => runDestSearch($('dest-input').value), 300);
    });
    $('dest-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(destTimer); runDestSearch($('dest-input').value); $('dest-input').blur(); }
    });
    $('btn-dest-skip-place').addEventListener('click', () => { $('dest-dist-err').textContent = ''; destShowStep('distance'); });
    $('btn-dest-to-search').addEventListener('click', () => destShowStep('search'));
    $('btn-dest-repick').addEventListener('click', () => destShowStep('search'));
    $('btn-dest-go').addEventListener('click', () => startDestRoute(true));
    $('btn-dest-skip-dist').addEventListener('click', () => startDestRoute(false));
    document.querySelectorAll('#dest-step-distance [data-km]').forEach((b) => {
      b.addEventListener('click', () => { $('dest-dist-input').value = b.dataset.km; });
    });
    $('btn-dest-dist-go').addEventListener('click', () => {
      const km = parseFloat($('dest-dist-input').value);
      if (!(km > 0) || km > 60) { $('dest-dist-err').textContent = '0.5 ~ 60 사이의 거리(km)를 입력해주세요'; return; }
      prepareRoute({ type: 'distance_only', distance: km });
    });
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

    // 달린 거리 후보: 바로 앞 GPS 대비가 아니라 "마지막으로 인정한 위치"에서 노이즈 기준 넘게 움직였을 때만 인정.
    // (러닝 속도에선 1초에 3m쯤 가서 '앞 GPS 대비' 방식은 5m 기준을 못 넘어 거리가 거의 안 쌓였음)
    const speedKnown = typeof pos.coords.speed === 'number' && !Number.isNaN(pos.coords.speed);
    const stationary = speedKnown && speed < 0.3;
    let candDist = 0;
    if (!distAnchor) distAnchor = cur;
    const anchorMoved = haversine(distAnchor, cur);
    if (anchorMoved > noiseFloor && !stationary) {
      candDist = anchorMoved;
      distAnchor = cur;
    } else if (stationary && anchorMoved > noiseFloor * 3) {
      distAnchor = cur; // 가만히 있는데 GPS만 크게 튄 경우엔 기준점만 옮김
    }

    // 내 실제 위치를 경로 위에 붙여서(스냅) 진행 위치를 정함 - 그래서 실제로 이동한 만큼 남은 경로선이 줄어듦.
    // 경로 위에서 달릴 땐 "경로상 진행 거리"를 달린 거리로 써서 GPS 흔들림 때문에 거리가 부풀려지지 않게 함
    let progress = 0;
    let addedDist = candDist;
    if (route && mapHelper && mapHelper.snapToRoute) {
      const total = mapHelper.totalMeters || route.distanceMeters;
      const nowMs = Date.now();
      const gapSec = lastSnapAt ? Math.min((nowMs - lastSnapAt) / 1000, 60) : 1;
      lastSnapAt = nowMs;
      const snap = mapHelper.snapToRoute(cur, Math.max(navProgressM - 25, 0), Math.min(navProgressM + 250 + gapSec * 6, total));
      const tol = Math.max(40, accuracy * 1.2);
      if (snap && snap.dist <= tol) {
        const advance = stationary ? 0 : Math.max(snap.along - navProgressM, 0); // 서 있을 땐 GPS가 흔들려도 진행 안 함
        navProgressM += advance;
        addedDist = advance;
        offRouteM = snap.dist;
        offRouteCount = 0;
        navPos = snap.dist <= 20 ? snap.point : cur;
      } else {
        offRouteCount++;
        offRouteM = snap ? snap.dist : 999;
        navPos = cur;
        // 한동안 계속 경로 밖이면(GPS 오차·공사 우회 등) 진행이 멈춰 보이지 않게 달린 거리만큼은 진행으로 침
        if (offRouteCount >= 6 && candDist > 0) navProgressM = Math.min(total, navProgressM + candDist);
        if (offRouteCount >= 3 && offRouteM > 40 && nowMs - lastOffRouteWarnAt > 30000) {
          lastOffRouteWarnAt = nowMs;
          announce('경로에서 벗어났어요. 초록 선을 따라 돌아와 주세요.');
        }
      }
      progress = Math.min(navProgressM / total, 1);
    } else if (route) {
      progress = Math.min((traveledMeters + candDist) / route.distanceMeters, 1);
    }
    traveledMeters += addedDist;

    // 멈춰 섰다가 다시 움직인 경우(신호 대기·잠깐 쉬기 등)를 기록 - 러닝 종료 후 "어디서 멈췄는지" 분석에 씀.
    // 정지 중엔 GPS 값이 안 올 수도 있어서, "다시 움직인 순간의 시간 공백"으로 판단함
    if (isMoving) {
      const nowMs = Date.now();
      if (lastMovingAt && lastMovingPos) {
        const gapSec = (nowMs - lastMovingAt) / 1000;
        const gapDist = haversine(lastMovingPos, cur);
        if (gapSec >= 8 && gapDist / gapSec < 1.0) {
          stopEvents.push({ lat: lastMovingPos.lat, lng: lastMovingPos.lng, sec: Math.round(gapSec), atM: traveledMeters });
          stopSecSinceSplit += gapSec;
        }
      }
      lastMovingAt = nowMs;
      lastMovingPos = { lat: cur.lat, lng: cur.lng };
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

    // 250m마다 그 구간 페이스와 위치를 기록해서 완료 화면 그래프/분석에 씀
    if (traveledMeters - lastSplitMeters >= 250) {
      const segKm = (traveledMeters - lastSplitMeters) / 1000;
      const segMin = (Date.now() - lastSplitTime) / 60000;
      if (segKm > 0 && segMin > 0) {
        paceSplits.push(segMin / segKm);
        // 멈춰 있던 시간을 뺀 "달린 페이스" - 신호 대기 때문이 아니라 진짜로 속도가 떨어진 구간을 찾을 때 씀
        const movingMin = Math.max(segMin - stopSecSinceSplit / 60, segMin * 0.3);
        splitMeta.push({
          startM: lastSplitMeters, endM: traveledMeters, movingPace: movingMin / segKm,
          start: lastSplitPos || { lat: cur.lat, lng: cur.lng }, end: { lat: cur.lat, lng: cur.lng },
        });
      }
      stopSecSinceSplit = 0;
      lastSplitMeters = traveledMeters;
      lastSplitTime = Date.now();
      lastSplitPos = { lat: cur.lat, lng: cur.lng };
    }

    updateMarker(progress, currentBearing, isMoving);
    if (arModeEnabled) {
      if (arUsingXr) ArXR.updatePath(getLookaheadPathPoints());
      else updateArOverlay(navPos || cur, currentBearing);
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
    if (paceAnnounceTimer) { clearInterval(paceAnnounceTimer); paceAnnounceTimer = null; }
    stopArCamera();
    const km = traveledMeters / 1000;
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    const elapsedMin = elapsedSec / 60;
    const paceMinPerKm = km > 0.05 ? elapsedMin / km : 0;

    // 걷는 캐릭터: 아이템이 늘어 속도가 바뀌기 전에, 지금까지 걸은 거리를 옛 속도로 확정
    settleWalk();

    // 아이템은 러닝 "중"에는 주지 않고, 끝난 뒤 누적 거리에 따라 해금돼요 (누적 거리는 아래에서 서버에 더하기 전 값 기준)
    const prevKm = getTotalRunKm();
    const gainedKm = km > 0.02 ? km : 0;
    const newItems = getNewlyUnlocked(prevKm, gainedKm);

    // 고급 아이템 도전 결과: 코스를 (거의) 다 달렸을 때만 지급
    const ownedBefore = getOwnedPremiumIds();
    const walkBefore = walkMultiplierFor(prevKm, ownedBefore);
    let pr = null;
    if (premiumRun) {
      const item = PREMIUM_ITEMS.find((i) => i.id === premiumRun.id);
      const target = premiumRun.km;
      const done = !!item && !ownedBefore.has(item.id) && km >= target * PREMIUM_MIN_RATIO && (!manual || km >= target * PREMIUM_MANUAL_RATIO);
      pr = { item, done, km, target };
      if (done && currentUser) grantPremium(item.id);
      else pr.done = false;
      premiumRun = null;
    }
    const walk = { before: walkBefore, after: walkMultiplierFor(prevKm + gainedKm, getOwnedPremiumIds()) };

    if (currentUser && km > 0.02) {
      Auth.addDistance(currentUser.uid, km).then(() => {
        cachedProfile = cachedProfile || {};
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

    let doneText = manual ? '러닝을 종료했어요. 수고했어요.' : '목표 거리에 도착했어요! 수고했어요.';
    if (newItems.length) doneText += ` 새 아이템, ${newItems.map((i) => i.name).join(', ')} 해금했어요!`;
    if (pr && pr.done) doneText += ` 고급 아이템, ${pr.item.name} 획득했어요!`;
    else if (pr) doneText += ` 코스를 다 못 채워서 고급 아이템은 받지 못했어요.`;
    announce(doneText);
    Music.pause();

    renderFinishNewItems(newItems, prevKm, gainedKm, pr, walk);
    showFinishScreen({ km, elapsedSec, paceMinPerKm });
  }

  /* ---------------- 러닝 분석: 느려진 곳 / 멈춘 곳 + 그 근처 가게·건물 ----------------
   * 250m 구간마다 페이스와 GPS 위치를 기록해두고(paceSplits / splitMeta),
   * 러닝이 끝나면 "속도가 점점 느려진 구간"과 "멈춰 섰던 곳"을 찾아서
   * 그 위치 근처의 가게·건물 이름(카카오 로컬 API, /api/place-near)으로 설명해줘요.
   */
  function meanOf(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

  // 앞뒤 한 칸씩 평균 - 250m 구간 페이스의 GPS 잡음을 줄여서 "진짜로 점점 느려지는 흐름"만 찾기 위함
  function smoothArr(arr) {
    return arr.map((_, i) => meanOf(arr.slice(Math.max(0, i - 1), Math.min(arr.length, i + 2))));
  }

  function buildRunInsights() {
    const n = paceSplits.length;
    const metas = splitMeta;
    const list = [];
    const mid = (m) => ({ lat: (m.start.lat + m.end.lat) / 2, lng: (m.start.lng + m.end.lng) / 2 });

    if (n >= 3 && metas.length === n) {
      // 1) 속도가 점점 느려진 구간: 페이스 값이 계속 커지는(=느려지는) 흐름이 10% 이상 이어진 곳
      const moving = metas.map((m, i) => m.movingPace || paceSplits[i]); // 멈춘 시간 뺀 페이스
      const sm = smoothArr(moving);
      const slowdowns = [];
      let i = 0;
      while (i < n - 1) {
        let j = i;
        while (j + 1 < n && sm[j + 1] >= sm[j] * 0.985) j++;
        let lo = i;
        for (let k = i; k <= j; k++) if (sm[k] < sm[lo]) lo = k;
        let hi = lo;
        for (let k = lo; k <= j; k++) if (sm[k] > sm[hi]) hi = k;
        const rise = sm[hi] / sm[lo];
        if ((hi - lo >= 2 && rise >= 1.10) || (hi - lo >= 1 && rise >= 1.22)) {
          slowdowns.push({ from: lo, to: hi, rise, startPace: sm[lo], endPace: sm[hi] });
        }
        i = j + 1;
      }
      slowdowns.sort((a, b) => b.rise - a.rise).slice(0, 3).forEach((s) => {
        const m = metas[s.to]; // 가장 느려진 지점(끝)의 위치 근처를 설명에 씀
        list.push({
          kind: 'slow', ...mid(m),
          fromM: metas[s.from].startM, toM: m.endM, atM: (m.startM + m.endM) / 2,
          startPace: s.startPace, endPace: s.endPace,
        });
      });

      // 2) 가장 빨랐던 곳 (평균보다 8% 이상 빠를 때만)
      const avg = meanOf(moving);
      const minIdx = moving.indexOf(Math.min(...moving));
      if (n >= 4 && moving[minIdx] < avg * 0.92) {
        const m = metas[minIdx];
        list.push({ kind: 'fast', ...mid(m), atM: (m.startM + m.endM) / 2, pace: moving[minIdx] });
      }
    }

    // 3) 멈춰 섰던 곳 (신호 대기 등) - 가까운 것끼리 합치고, 느려진 구간과 겹치면 그 설명에 합침
    const merged = [];
    stopEvents.forEach((s) => {
      const prev = merged[merged.length - 1];
      if (prev && haversine(prev, s) < 40) prev.sec += s.sec;
      else merged.push({ ...s });
    });
    merged.filter((s) => s.sec >= 10).sort((a, b) => b.sec - a.sec).slice(0, 2).forEach((s) => {
      const near = list.find((x) => x.kind === 'slow' && haversine(x, s) < 100);
      if (near) near.stopSec = (near.stopSec || 0) + s.sec;
      else list.push({ kind: 'stop', lat: s.lat, lng: s.lng, atM: s.atM, sec: s.sec });
    });

    list.sort((a, b) => a.atM - b.atM);
    return list.slice(0, 5);
  }

  async function fetchPlacesNear(points) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const res = await fetch('/api/place-near', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points }),
        signal: controller.signal,
      });
      if (!res.ok) return [];
      const json = await res.json();
      return Array.isArray(json.places) ? json.places : [];
    } catch (e) {
      console.warn('[러닝 분석] 주변 장소 조회 실패', e);
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  // "GS25 과천점(편의점) 근처" / 장소를 못 찾으면 "1.25km 지점 부근"
  function insightWhereHtml(ins, place) {
    if (place && place.name) {
      const showCat = place.category && place.category !== '건물' && !place.name.includes(place.category);
      const cat = showCat ? ` <span class="cat">${escapeHtml(place.category)}</span>` : '';
      const close = ins.kind === 'stop' && place.distance <= 30;
      return `<b>${escapeHtml(place.name)}</b>${cat} ${close ? '앞' : '근처'}`;
    }
    return `<b>${(ins.atM / 1000).toFixed(2)}km</b> 지점 부근`;
  }

  function insightTextHtml(ins, place) {
    const where = insightWhereHtml(ins, place);
    if (ins.kind === 'slow') {
      const range = `${(ins.fromM / 1000).toFixed(2)}~${(ins.toM / 1000).toFixed(2)}km 구간`;
      let t = `${where}에서 속도가 점점 느려졌어요 <span class="sub">${range}에서 ${fmtPace(ins.startPace)} → ${fmtPace(ins.endPace)}/km</span>`;
      if (ins.stopSec) t += ` <span class="sub">(중간에 ${ins.stopSec}초 멈추기도 했어요)</span>`;
      return t;
    }
    if (ins.kind === 'stop') {
      return `${where}에서 <b>${ins.sec}초</b> 멈춰 섰어요 <span class="sub">신호 대기나 잠깐 쉰 구간으로 보여요</span>`;
    }
    return `${where}에서 가장 빠르게 달렸어요 <span class="sub">${fmtPace(ins.pace)}/km</span>`;
  }

  const INSIGHT_COLOR = { slow: 'var(--amber)', stop: 'var(--alert)', fast: 'var(--go)' };

  function renderInsightRows(container, insights, places, loading) {
    const rows = [];
    insights.forEach((ins, i) => {
      rows.push(`<div class="row"><span class="insight-num" style="background:${INSIGHT_COLOR[ins.kind]}">${i + 1}</span><span class="text">${insightTextHtml(ins, places[i])}</span></div>`);
    });
    if (!insights.some((x) => x.kind === 'slow' || x.kind === 'stop')) {
      rows.push('<div class="row"><span class="dot" style="background:var(--go)"></span><span class="text">눈에 띄게 느려지거나 멈춘 구간 없이 <b>꾸준히</b> 달렸어요</span></div>');
    }

    // 전반 vs 후반 흐름
    const n = paceSplits.length;
    if (n >= 4) {
      const half = Math.floor(n / 2);
      const first = meanOf(paceSplits.slice(0, half));
      const second = meanOf(paceSplits.slice(half));
      if (second >= first * 1.05) {
        rows.push(`<div class="row"><span class="dot" style="background:var(--amber)"></span><span class="text">후반으로 갈수록 속도가 점점 느려졌어요 <span class="sub">전반 ${fmtPace(first)} → 후반 ${fmtPace(second)}/km</span></span></div>`);
      } else if (second <= first * 0.95) {
        rows.push(`<div class="row"><span class="dot" style="background:var(--go)"></span><span class="text">후반에 오히려 속도를 끌어올렸어요 <span class="sub">전반 ${fmtPace(first)} → 후반 ${fmtPace(second)}/km</span></span></div>`);
      }
    }
    rows.push(`<div class="row"><span class="dot" style="background:var(--mute)"></span><span class="text">전체 평균 페이스는 <b>${fmtPace(meanOf(paceSplits))}/km</b>였어요</span></div>`);
    if (loading) rows.push('<div class="analysis-loading">주변 가게·건물을 확인하는 중…</div>');
    container.innerHTML = rows.join('');
  }

  function startPlaceLookup(insights, token, container) {
    if (!insights.length) return;
    fetchPlacesNear(insights.map((x) => ({ lat: x.lat, lng: x.lng }))).then((places) => {
      if (token !== analysisToken) return; // 그 사이에 새 러닝이 시작됐거나 화면이 바뀜
      renderInsightRows(container, insights, places, false);
    });
  }

  // A) 거리별 페이스 - 곡선 + 영역, 눈금/축, 평균선, 250m마다 점, 느려진/멈춘/빠른 곳에 번호 표시 (위로 갈수록 빠름)
  function renderFinishChartA(insights) {
    const el = $('finish-chart-a');
    const n = paceSplits.length;
    const metas = splitMeta.length === n
      ? splitMeta
      : paceSplits.map((_, i) => ({ startM: i * 250, endM: (i + 1) * 250 }));
    const totalM = Math.max(metas[n - 1].endM, 1);
    const avg = meanOf(paceSplits);
    const minP = Math.min(...paceSplits), maxP = Math.max(...paceSplits);

    const W = 340, H = 200, PADL = 40, PADR = 40, PADT = 26, PADB = 28;
    const plotW = W - PADL - PADR, plotH = H - PADT - PADB;
    const pad = Math.max((maxP - minP) * 0.25, 0.2);
    const lo = minP - pad, hi = maxP + pad;
    const xFor = (m) => PADL + (Math.min(Math.max(m, 0), totalM) / totalM) * plotW;
    const yFor = (p) => PADT + ((p - lo) / (hi - lo)) * plotH;
    const uid = 'fa' + Math.random().toString(36).slice(2, 7);

    const dotPts = metas.map((m, i) => ({ x: xFor((m.startM + m.endM) / 2), y: yFor(paceSplits[i]) }));
    const linePts = [{ x: PADL, y: dotPts[0].y }, ...dotPts, { x: PADL + plotW, y: dotPts[n - 1].y }];
    const linePath = monotonePath(linePts);
    const baseY = PADT + plotH;
    const areaPath = `${linePath} L${(PADL + plotW).toFixed(1)} ${baseY} L${PADL} ${baseY} Z`;

    const grid = [0, 1 / 3, 2 / 3, 1].map((t) => {
      const y = PADT + t * plotH;
      return `<line x1="${PADL}" y1="${y.toFixed(1)}" x2="${W - PADR}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
              <text x="${PADL - 6}" y="${(y + 3).toFixed(1)}" font-size="9" fill="var(--mute)" text-anchor="end">${fmtPace(lo + t * (hi - lo))}</text>`;
    }).join('');
    const hint = `<text x="4" y="${PADT - 10}" font-size="8.5" fill="var(--mute)">▲ 빠름</text>
                  <text x="4" y="${PADT + plotH + 19}" font-size="8.5" fill="var(--mute)">▼ 느림</text>`;

    // x축: 거리 눈금
    const step = totalM >= 3000 ? 1000 : totalM >= 1200 ? 500 : 250;
    let ticks = '';
    for (let m = 0; m <= totalM + 1; m += step) {
      const x = xFor(m);
      ticks += `<line x1="${x.toFixed(1)}" y1="${PADT}" x2="${x.toFixed(1)}" y2="${baseY}" stroke="var(--line)" stroke-width="1" opacity=".55"/>
        <text x="${x.toFixed(1)}" y="${H - 8}" font-size="9" fill="var(--mute)" text-anchor="${m === 0 ? 'start' : 'middle'}">${m === 0 ? '0' : `${+(m / 1000).toFixed(2)}km`}</text>`;
    }

    // 느려진 구간 음영 + 멈춘 지점 세로선
    let shades = '';
    insights.forEach((ins) => {
      if (ins.kind === 'slow') {
        const x1 = xFor(ins.fromM), x2 = xFor(ins.toM);
        shades += `<rect x="${x1.toFixed(1)}" y="${PADT}" width="${Math.max(x2 - x1, 3).toFixed(1)}" height="${plotH}" fill="#FFB238" opacity=".13"/>`;
      } else if (ins.kind === 'stop') {
        const x = xFor(ins.atM);
        shades += `<line x1="${x.toFixed(1)}" y1="${PADT}" x2="${x.toFixed(1)}" y2="${baseY}" stroke="#FF6B5E" stroke-width="1.4" stroke-dasharray="3 3"/>`;
      }
    });

    const avgY = yFor(avg);
    const avgLine = `<line x1="${PADL}" y1="${avgY.toFixed(1)}" x2="${W - PADR + 2}" y2="${avgY.toFixed(1)}" stroke="var(--amber)" stroke-width="1.2" stroke-dasharray="4 4" opacity=".9"/>
      <text x="${W - PADR + 5}" y="${(avgY - 1).toFixed(1)}" font-size="8.5" font-weight="800" fill="var(--amber)">평균</text>
      <text x="${W - PADR + 5}" y="${(avgY + 9).toFixed(1)}" font-size="8.5" font-weight="700" fill="var(--amber)">${fmtPace(avg)}</text>`;

    const dots = dotPts.map((p, i) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${paceSplits[i] <= avg ? 3 : 3}" fill="${paceSplits[i] <= avg ? 'var(--go)' : 'var(--amber)'}" stroke="var(--surface)" stroke-width="1.5"/>`).join('');

    // 번호 마커 (분석 문장의 번호와 같음)
    const markers = insights.map((ins, i) => {
      let idx = metas.findIndex((m) => ins.atM >= m.startM && ins.atM <= m.endM);
      if (idx < 0) idx = ins.atM > metas[n - 1].endM ? n - 1 : 0;
      const x = xFor(ins.atM);
      const y = Math.max(PADT + 8, yFor(paceSplits[idx]) - 13);
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="8" fill="${INSIGHT_COLOR[ins.kind]}" stroke="var(--surface)" stroke-width="2"/>
        <text x="${x.toFixed(1)}" y="${(y + 3.4).toFixed(1)}" font-size="9.5" font-weight="800" fill="#10151A" text-anchor="middle">${i + 1}</text>`;
    }).join('');

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;">
      <defs><linearGradient id="${uid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#2BD97C" stop-opacity=".36"/><stop offset="100%" stop-color="#2BD97C" stop-opacity="0"/>
      </linearGradient></defs>
      ${grid}${hint}${ticks}${shades}
      <path d="${areaPath}" fill="url(#${uid})"/>
      ${avgLine}
      <path d="${linePath}" fill="none" stroke="var(--go)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
      ${dots}${markers}
    </svg>
    <div class="chart-legend">
      <span><i style="background:var(--go)"></i>평균보다 빠름</span>
      <span><i style="background:var(--amber)"></i>평균보다 느림</span>
      <span><i class="shade"></i>점점 느려진 구간</span>
      <span><i class="stopline"></i>멈춘 곳</span>
    </div>`;
  }
  function showFinishScreen({ km, elapsedSec, paceMinPerKm }) {
    const token = ++analysisToken;
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
      const formatPace = fmtPace;
      const avg = meanOf(paceSplits);

      // 느려진 곳/멈춘 곳/빨랐던 곳을 찾아서 그래프에 번호로 표시하고, 아래 설명 문장과 짝지음
      const insights = buildRunInsights();
      renderFinishChartA(insights);

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

      renderInsightRows(analysisContainer, insights, [], insights.length > 0);
      startPlaceLookup(insights, token, analysisContainer); // 가게·건물 이름은 조금 뒤에 채워짐
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
      if (!voiceMuted) Voice.speak(desc);
    }
  }

  // pos: 진행률로 계산한 좌표, bearing: 화면 위쪽이 향해야 할 방향, isMoving: false면 카메라를 그대로 둠(정지)
  function updateMarker(progress, bearing, isMoving) {
    if (!mapHelper) return;
    const pos = navPos || mapHelper.pointAtProgress(progress);
    const face = localStorage.getItem(FACE_KEY);
    mapHelper.updateChevrons(progress, mapHelper.map);
    // 지나온 길은 흐리게, 남은 길만 초록으로 (경로에서 벗어났으면 내 위치에서 경로로 돌아오는 선도 함께)
    if (mapHelper.updateRoute) mapHelper.updateRoute(progress, offRouteM > 25 ? navPos : null);

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
    const base = (mapHelper && mapHelper.snapToRoute) ? navProgressM : traveledMeters; // 실제 위치를 붙인 경로상 거리
    for (let d = NEAR; d <= FAR; d += STEP) distances.push(base + d);
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

  // 설정한 분 간격마다 "N.N킬로미터, 페이스 M분 S초" 같은 문구를 음성으로 알려줌 (0분=끄기)
  function startPaceAnnounceTimer() {
    if (paceAnnounceTimer) { clearInterval(paceAnnounceTimer); paceAnnounceTimer = null; }
    const min = parseInt(localStorage.getItem(PACE_INTERVAL_KEY), 10) || 0;
    if (min <= 0) return;
    paceAnnounceTimer = setInterval(() => {
      if (!route || traveledMeters < 30) return;
      const km = traveledMeters / 1000;
      const elapsedMin = (Date.now() - startedAt) / 60000;
      const pace = km > 0.05 ? elapsedMin / km : 0;
      const distText = km < 1 ? `${Math.round(traveledMeters)}미터` : `${km.toFixed(1)}킬로미터`;
      const paceText = pace > 0 ? `, 페이스 ${fmtPace(pace)}` : '';
      announce(`${distText} 달렸어요${paceText}`);
    }, min * 60000);
  }

  function updateStats(progress, speedMs) {
    if (!route) return;
    const remainingKm = (route.distanceMeters / 1000) * (1 - progress);
    $('stat-distance').textContent = remainingKm.toFixed(1) + 'km';

    const elapsedMin = (Date.now() - startedAt) / 60000;
    const traveledKm = traveledMeters / 1000;
    $('stat-covered').textContent = traveledKm.toFixed(1) + 'km';
    const paceMinPerKm = traveledKm > 0.05 ? elapsedMin / traveledKm : 0;
    // 처음 50m까지는 누적 평균을 못 내니까, 그동안은 GPS가 알려주는 현재 속도로 페이스를 바로 보여줌
    const livePace = paceMinPerKm > 0 ? paceMinPerKm : (speedMs > 0.5 ? 1000 / speedMs / 60 : 0);
    if (livePace > 0) $('stat-pace').textContent = fmtPace(livePace);

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
    premiumRun = null; // 홈으로 돌아오면 고급 아이템 도전 상태는 해제
    renderHomeHero();
    renderRunnerCharacter();
    paintCachedHomePace(); // 앱을 켜자마자 지난번 계산한 페이스부터 바로 보여줌
    try {
      const runs = await Auth.listRuns(currentUser.uid, 20);
      renderHomeMap(runs);
      renderPaceChart(runs);
      updateHomePace(runs);
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
    const distanceKm = getTotalRunKm();
    const level = getCharacterLevel(distanceKm);
    const nextLevel = CHAR_LEVELS[level.idx + 1];
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

    // 누적 거리로 해금된 아이템 중 부위별 최고 등급이 캐릭터에 장착돼서 보임
    const equipped = getEquippedItems(distanceKm);
    const unlockedCount = getUnlockedItems(distanceKm).length + getOwnedPremium().length;
    const next = getNextItem(distanceKm);
    const nextText = next
      ? `다음 아이템 <b>${escapeHtml(next.name)}</b>까지 ${fmtKm(next.unlockKm - distanceKm)}km`
      : '모든 아이템을 해금했어요!';

    const wmult = walkMultiplier();
    const walkDur = Math.max(0.75, 2.4 / wmult).toFixed(2);
    box.innerHTML = `
      <div class="walker-top">
        <div class="walker-label">걸어서 모은 거리</div>
        <div class="walker-dist" data-walk-dist>${fmtWalkDist(currentWalkMeters())}</div>
        <div class="walker-rate">하루 ${(WALK_BASE_M_PER_DAY * wmult).toFixed(1)}m · 아이템 ×${wmult.toFixed(2)}</div>
      </div>
      <div class="runner-walk" style="--walk-dur:${walkDur}s;">${buildRunnerSvg(level, equipped, 110)}</div>
      <div class="runner-level-name">${level.name}</div>
      ${progressHtml}
      <div class="runner-quote">${quote}</div>
      <button type="button" class="items-open-btn" data-open-items="1">
        <span class="items-open-icon">${itemsBagIcon()}</span>
        <span class="items-open-text">
          <span class="items-open-title">아이템 창 · ${unlockedCount}/${ITEM_CATALOG.length + PREMIUM_ITEMS.length}</span>
          <span class="items-open-sub">${nextText}</span>
        </span>
        <span class="items-open-arrow">›</span>
      </button>
    `;
  }

  function itemsBagIcon() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8h12l1.5 12.5a1 1 0 0 1-1 1.1h-13a1 1 0 0 1-1-1.1z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>';
  }

  /* ---------------- 아이템 창 ---------------- */
  function openItemsScreen() {
    itemsFilter = 'all';
    renderItemsScreen();
    showScreen('screen-items');
  }

  function premiumCardHtml(it, owned, equipped) {
    const isOwned = owned.has(it.id);
    const isEq = equipped[it.slot] && equipped[it.slot].id === it.id;
    const tierInfo = TIER_INFO[it.tier];
    const bonus = Math.round((WALK_TIER_BONUS[it.tier] || 0) * 100);
    const state = isOwned
      ? `<div class="pm-state${isEq ? ' on' : ''}">${isEq ? '보유 · 장착중' : '보유 · 다른 아이템 장착'}</div>`
      : `<button type="button" class="pm-btn" data-pm-start="${it.id}">${it.runKm}km 달리고 받기</button>`;
    return `
      <div class="pm-card tier-${it.tier}${isOwned ? ' owned' : ''}">
        <div class="pm-glyph">${itemGlyphSvg(it)}</div>
        <div class="pm-body">
          <div class="pm-name">${escapeHtml(it.name)} <span class="item-step-badge inline km${it.runKm}">${it.runKm}km</span></div>
          <div class="pm-tier" style="color:${tierInfo.color}">${tierInfo.name} · ${SLOT_INFO[it.slot]} · 걷기 +${bonus}%</div>
          <div class="pm-desc">${escapeHtml(it.desc)}</div>
          ${state}
        </div>
      </div>`;
  }

  function renderPremiumSection() {
    const box = $('items-premium');
    if (!box) return;
    const owned = getOwnedPremiumIds();
    const equipped = getEquippedItems(getTotalRunKm());
    const count = PREMIUM_ITEMS.filter((i) => owned.has(i.id)).length;
    const group = (km) => `
      <div class="pm-group-title"><span class="item-step-badge inline km${km}">${km}km</span> 코스</div>
      <div class="pm-list">${PREMIUM_ITEMS.filter((i) => i.runKm === km).map((i) => premiumCardHtml(i, owned, equipped)).join('')}</div>`;
    box.innerHTML = `
      <div class="items-section-head">
        <div class="items-section-title">고급 아이템 <small>${count}/${PREMIUM_ITEMS.length}</small></div>
        <div class="items-section-sub">5km · 7km 코스를 끝까지 완주하면 받아요. 버튼을 누르면 내 주변에 그 거리만큼 경로를 만들어서 러닝을 준비해요.</div>
      </div>
      ${group(5)}${group(7)}
      <div class="items-section-head" style="margin-top:22px;">
        <div class="items-section-title">기본 아이템 <small>달릴 때마다 누적 거리로 자동 해금</small></div>
      </div>`;
  }

  function itemCardHtml(item, ctx) {
    const { km, equipped, filter } = ctx;
    const unlocked = item.unlockKm <= km + 1e-9;
    const isEquipped = equipped[item.slot] && equipped[item.slot].id === item.id;
    const tierInfo = TIER_INFO[item.tier];
    const dimmed = filter !== 'all' && String(item.stepKm) !== filter;
    let state;
    if (isEquipped) state = '<div class="item-state on">장착중</div>';
    else if (unlocked) state = '<div class="item-state evolved">진화됨</div>';
    else state = `<div class="item-state lock">누적 ${item.unlockKm}km</div>`;
    const remain = item.unlockKm - km;
    const remainText = !unlocked && remain > 0 && remain <= 5 ? `<div class="item-meta">${fmtKm(remain)}km 남음</div>` : '';
    return `
      <div class="item-card tier-${item.tier}${unlocked ? '' : ' locked'}${isEquipped ? ' equipped' : ''}${dimmed ? ' dimmed' : ''}">
        <span class="item-step-badge${item.stepKm === 5 ? ' km5' : ''}">${item.stepKm}km</span>
        <div class="item-glyph">${itemGlyphSvg(item)}</div>
        <div class="item-name">${escapeHtml(item.name)}</div>
        <div class="item-tier-tag" style="color:${tierInfo.color}">${tierInfo.name}</div>
        ${state}${remainText}
      </div>`;
  }

  function renderItemsScreen() {
    const km = getTotalRunKm();
    const equipped = getEquippedItems(km);
    const unlocked = getUnlockedItems(km);
    const level = getCharacterLevel(km);
    const next = getNextItem(km);
    const wmult = walkMultiplier();
    const walkDur = Math.max(0.75, 2.4 / wmult).toFixed(2);
    renderPremiumSection();

    // 위쪽: 캐릭터 + 해금 현황 + 다음 아이템까지 진행도
    let nextHtml;
    if (next) {
      const prevUnlock = next.order > 1 ? ITEM_CATALOG[next.order - 2].unlockKm : 0;
      const pct = Math.max(0, Math.min(100, Math.round(((km - prevUnlock) / (next.unlockKm - prevUnlock)) * 100)));
      nextHtml = `
        <div class="items-next">
          <div class="items-next-glyph">${itemGlyphSvg(next)}</div>
          <div class="items-next-body">
            <div class="items-next-title">다음 · ${escapeHtml(next.name)} <span class="item-step-badge inline${next.stepKm === 5 ? ' km5' : ''}">${next.stepKm}km</span></div>
            <div class="goal-bar-track" style="height:8px;"><div class="goal-bar-fill" style="width:${pct}%;"></div></div>
            <div class="items-next-sub">${fmtKm(next.unlockKm - km)}km 더 달리면 해금 (누적 ${next.unlockKm}km)</div>
          </div>
        </div>`;
    } else {
      nextHtml = '<div class="items-next-sub" style="margin-top:8px;">모든 아이템을 해금했어요! 대단해요.</div>';
    }
    $('items-hero').innerHTML = `
      <div class="items-hero-row">
        <div class="items-hero-char"><div class="runner-walk" style="--walk-dur:${walkDur}s;">${buildRunnerSvg(level, equipped, 118)}</div><div class="runner-level-name" style="font-size:15px; margin-top:2px;">${level.name}</div></div>
        <div class="items-hero-info">
          <div class="items-hero-count"><b>${unlocked.length + getOwnedPremium().length}</b><span>/${ITEM_CATALOG.length + PREMIUM_ITEMS.length} 보유</span></div>
          <div class="items-hero-km">누적 ${km.toFixed(1)}km 달렸어요</div>
          <div class="items-hero-walk">걷는 거리 <b data-walk-dist>${fmtWalkDist(currentWalkMeters())}</b><br/>하루 ${(WALK_BASE_M_PER_DAY * wmult).toFixed(1)}m (×${wmult.toFixed(2)})</div>
          <div class="items-hero-hint">아이템이 많고 등급이 높을수록 캐릭터가 더 빨리 걸어요.</div>
        </div>
      </div>
      ${nextHtml}`;

    // 필터 칩 (3km 아이템 / 5km 아이템 강조)
    const chips = [
      { key: 'all', label: '전체' },
      { key: '3', label: `3km 아이템 ${ITEM_CATALOG.filter((i) => i.stepKm === 3).length}` },
      { key: '5', label: `5km 아이템 ${ITEM_CATALOG.filter((i) => i.stepKm === 5).length}` },
    ];
    const chipsEl = $('items-filter-chips');
    chipsEl.innerHTML = '';
    chips.forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'crosswalk-chip' + (c.key === itemsFilter ? ' active' : '');
      b.textContent = c.label;
      b.addEventListener('click', () => { itemsFilter = c.key; renderItemsScreen(); });
      chipsEl.appendChild(b);
    });

    // 등급 범례
    $('items-tier-legend').innerHTML = [1, 2, 3, 4].map((t) =>
      `<span class="tier-legend-item"><i style="background:${TIER_INFO[t].color}"></i>${TIER_INFO[t].name}</span>`).join('');

    // 부위별 진화 라인 (왼쪽이 낮은 등급 → 오른쪽으로 갈수록 좋은 아이템)
    const ctx = { km, equipped, filter: itemsFilter };
    $('items-slot-list').innerHTML = SLOT_ORDER.map((slot) => {
      const chain = ITEM_CATALOG.filter((i) => i.slot === slot).sort((a, b) => a.tier - b.tier);
      const have = chain.filter((i) => i.unlockKm <= km + 1e-9).length;
      return `
        <div class="items-slot-row">
          <div class="items-slot-title">${SLOT_INFO[slot]} <small>${have}/${chain.length} 진화</small></div>
          <div class="items-chain">
            ${chain.map((it) => itemCardHtml(it, ctx)).join('<span class="chain-arrow">›</span>')}
          </div>
        </div>`;
    }).join('');
  }

  // 러닝 완료 화면 - 이번 러닝으로 새로 해금된 아이템 / 고급 아이템 도전 결과 / 걷기 속도 변화
  function renderFinishNewItems(newItems, prevKm, gainKm, pr, walk) {
    const card = $('finish-new-items');
    if (!card) return;
    const mini = (it) => `
      <div class="item-card tier-${it.tier} equipped">
        <span class="item-step-badge km${it.premium ? it.runKm : it.stepKm}">${it.premium ? it.runKm : it.stepKm}km</span>
        <div class="item-glyph">${itemGlyphSvg(it)}</div>
        <div class="item-name">${escapeHtml(it.name)}</div>
        <div class="item-tier-tag" style="color:${TIER_INFO[it.tier].color}">${TIER_INFO[it.tier].name}</div>
      </div>`;
    const speedLine = walk && walk.after > walk.before + 1e-9
      ? `<div class="new-items-next" style="margin-top:10px;">캐릭터 걷는 속도 <b>×${walk.before.toFixed(2)} → ×${walk.after.toFixed(2)}</b></div>` : '';
    let html = '';
    if (pr && pr.done) {
      html += `<div class="section-card-head"><span class="badge">${itemsBagIcon()}</span>고급 아이템 획득!</div>
        <div class="new-items-row">${mini(pr.item)}</div>
        <div class="new-items-next" style="margin-top:8px;">${pr.target}km 코스를 완주해서 <b>${escapeHtml(pr.item.name)}</b>${josa(pr.item.name, '을', '를')} 받았어요.</div>`;
    } else if (pr) {
      const remain = Math.max(pr.target * PREMIUM_MIN_RATIO - pr.km, 0);
      html += `<div class="section-card-head"><span class="badge">${itemsBagIcon()}</span>고급 아이템 도전</div>
        <div class="new-items-next">${escapeHtml(pr.item ? pr.item.name : '고급 아이템')}${josa(pr.item ? pr.item.name : '고급 아이템', '은', '는')} 아직이에요. ${pr.target}km 코스를 완주해야 받아요${remain > 0 ? ` (<b>${fmtKm(remain)}km</b> 더)` : ''}. 다음에 다시 도전해 보세요!</div>`;
    }
    if (newItems.length) {
      html += `<div class="section-card-head"${html ? ' style="margin-top:16px;"' : ''}><span class="badge">${itemsBagIcon()}</span>새 아이템 해금!</div>
        <div class="new-items-row">${newItems.map(mini).join('')}</div>`;
    } else if (!pr) {
      const next = getNextItem(prevKm + gainKm);
      if (next && gainKm > 0) {
        const remain = next.unlockKm - (prevKm + gainKm);
        html += `<div class="section-card-head"><span class="badge">${itemsBagIcon()}</span>다음 아이템</div>
          <div class="new-items-next">${escapeHtml(next.name)}까지 <b>${fmtKm(remain)}km</b> 남았어요</div>`;
      }
    }
    if (!html) { card.classList.add('hidden'); return; }
    html += speedLine;
    if (newItems.length || (pr && pr.done)) {
      html += '<button type="button" class="btn-secondary" id="btn-finish-items" style="margin-top:12px;">아이템 창에서 보기</button>';
    }
    card.innerHTML = html;
    card.classList.remove('hidden');
    const b = $('btn-finish-items');
    if (b) b.addEventListener('click', openItemsScreen);
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

  /* ---------------- 페이스 표시 / 그래프 공용 도구 ---------------- */
  function fmtPace(p) {
    if (!(p > 0) || !isFinite(p)) return `-'--"`;
    let m = Math.floor(p);
    let s = Math.round((p - m) * 60);
    if (s === 60) { m += 1; s = 0; }
    return `${m}'${String(s).padStart(2, '0')}"`;
  }

  function fmtDuration(sec) {
    sec = Math.max(Math.round(sec || 0), 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  // 점들을 부드럽게(튀지 않게) 이어주는 곡선 경로 - 단조 3차 보간이라 그래프가 값 사이에서 출렁이지 않음
  function monotonePath(pts) {
    const n = pts.length;
    if (n === 0) return '';
    const f = (v) => v.toFixed(1);
    if (n === 1) return `M${f(pts[0].x)} ${f(pts[0].y)}`;
    if (n === 2) return `M${f(pts[0].x)} ${f(pts[0].y)} L${f(pts[1].x)} ${f(pts[1].y)}`;
    const dx = [], m = [], t = [];
    for (let i = 0; i < n - 1; i++) {
      dx[i] = pts[i + 1].x - pts[i].x;
      m[i] = dx[i] === 0 ? 0 : (pts[i + 1].y - pts[i].y) / dx[i];
    }
    t[0] = m[0];
    t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (m[i - 1] * m[i] <= 0) t[i] = 0;
      else {
        const w1 = 2 * dx[i] + dx[i - 1], w2 = dx[i] + 2 * dx[i - 1];
        t[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]);
      }
    }
    let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;
      d += ` C${f(pts[i].x + h)} ${f(pts[i].y + t[i] * h)} ${f(pts[i + 1].x - h)} ${f(pts[i + 1].y - t[i + 1] * h)} ${f(pts[i + 1].x)} ${f(pts[i + 1].y)}`;
    }
    return d;
  }

  function runDate(r) {
    return r.completedAt?.toDate ? r.completedAt.toDate() : null;
  }

  // 여러 기록의 거리 가중 평균 페이스 (총시간 / 총거리) - 기록마다 거리가 달라도 공정하게
  function weightedAvgPace(runs) {
    let km = 0, sec = 0;
    runs.forEach((r) => {
      const k = r.distanceKm || 0;
      const s = r.durationSec || (r.paceMinPerKm > 0 ? r.paceMinPerKm * 60 * k : 0);
      if (k > 0 && s > 0) { km += k; sec += s; }
    });
    if (km > 0) return sec / 60 / km;
    const paces = runs.map((r) => r.paceMinPerKm).filter((p) => p > 0);
    return paces.length ? paces.reduce((a, b) => a + b, 0) / paces.length : 0;
  }

  /* ---------------- 홈 화면: 앱을 켜자마자 보이는 페이스 요약 ---------------- */
  const HOME_PACE_CACHE_KEY = 'run-pacer-home-pace-v1';

  function paceSummaryFromRuns(runs) {
    const withPace = runs.filter((r) => r.paceMinPerKm > 0);
    if (!withPace.length) return null;
    const last = withPace[0]; // listRuns는 최신순
    const prev = withPace[1] || null;
    return {
      avg: weightedAvgPace(withPace),
      last: last.paceMinPerKm,
      best: Math.min(...withPace.map((r) => r.paceMinPerKm)),
      deltaSec: prev ? Math.round((prev.paceMinPerKm - last.paceMinPerKm) * 60) : null, // +면 이전보다 빨라짐
      count: withPace.length,
    };
  }

  function paintHomePace(sum) {
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    if (!sum) {
      set('home-pace-avg', `-'--"`); set('home-pace-last', `-'--"`); set('home-pace-best', `-'--"`);
      const d = $('home-pace-delta'); if (d) { d.textContent = ''; d.className = ''; }
      return;
    }
    set('home-pace-avg', fmtPace(sum.avg));
    set('home-pace-last', fmtPace(sum.last));
    set('home-pace-best', fmtPace(sum.best));
    const d = $('home-pace-delta');
    if (d) {
      if (sum.deltaSec === null || Math.abs(sum.deltaSec) < 2) { d.textContent = ''; d.className = ''; }
      else {
        const faster = sum.deltaSec > 0;
        d.textContent = `${faster ? '▲' : '▼'}${Math.abs(sum.deltaSec)}초`;
        d.className = faster ? 'faster' : 'slower';
      }
    }
  }

  // 홈에 들어오자마자(서버 응답 기다리기 전에) 지난번 계산값부터 먼저 보여줌
  function paintCachedHomePace() {
    try {
      const raw = localStorage.getItem(HOME_PACE_CACHE_KEY);
      const c = raw ? JSON.parse(raw) : null;
      if (c && (!currentUser || c.uid === currentUser.uid)) paintHomePace(c.sum);
    } catch { /* 저장값이 깨졌으면 무시 */ }
  }

  function updateHomePace(runs) {
    const sum = paceSummaryFromRuns(runs);
    paintHomePace(sum);
    try {
      localStorage.setItem(HOME_PACE_CACHE_KEY, JSON.stringify({ uid: currentUser?.uid || null, sum }));
    } catch { /* 저장 실패해도 화면엔 이미 표시됨 */ }
  }

  /* ---------------- 홈 화면: 최근 페이스 그래프 (자세한 버전) ----------------
   * - 곡선 + 영역, 눈금선/축 라벨, 평균선, 점마다 페이스 값, 최고 기록 강조
   * - 아래쪽엔 그날 거리 막대 + 날짜, 막대/점을 누르면 그 기록의 자세한 정보가 아래에 뜸
   * (위로 갈수록 빠른 페이스)
   */
  function renderPaceChart(runs) {
    const container = $('pace-chart');
    const detailEl = $('pace-chart-detail');
    const list = runs.filter((r) => r.paceMinPerKm > 0).slice(0, 12).reverse(); // 오래된 → 최신
    if (!list.length) {
      container.innerHTML = '<p class="onboard-sub" style="padding:8px 0; margin:0;">아직 데이터가 없어요. 첫 러닝을 해보세요!</p>';
      if (detailEl) detailEl.innerHTML = '';
      return;
    }
    const n = list.length;
    const paces = list.map((r) => r.paceMinPerKm);
    const avg = weightedAvgPace(list);
    const minP = Math.min(...paces), maxP = Math.max(...paces);
    const bestIdx = paces.indexOf(minP);
    const last = list[n - 1];
    const prev = n > 1 ? list[n - 2] : null;
    const deltaSec = prev ? Math.round((prev.paceMinPerKm - last.paceMinPerKm) * 60) : null;

    const W = 340, H = 216, PADL = 40, PADR = 40, PADT = 24;
    const LINE_H = 116;                       // 페이스 곡선 영역 높이
    const BAR_TOP = PADT + LINE_H + 16;       // 거리 막대 영역 시작
    const BAR_H = 34;
    const DATE_Y = BAR_TOP + BAR_H + 15;
    const plotW = W - PADL - PADR;
    const cw = plotW / n;
    const pad = Math.max((maxP - minP) * 0.25, 0.2);
    const lo = minP - pad, hi = maxP + pad;
    const yFor = (p) => PADT + ((p - lo) / (hi - lo)) * LINE_H; // 빠를수록(작을수록) 위
    const xFor = (i) => PADL + cw * (i + 0.5);
    const maxKm = Math.max(...list.map((r) => r.distanceKm || 0), 0.1);
    const uid = 'pc' + Math.random().toString(36).slice(2, 7);

    const pts = list.map((r, i) => ({ x: xFor(i), y: yFor(r.paceMinPerKm) }));
    const linePath = monotonePath(pts);
    const baseY = PADT + LINE_H;
    const areaPath = n > 1
      ? `${linePath} L${pts[n - 1].x.toFixed(1)} ${baseY} L${pts[0].x.toFixed(1)} ${baseY} Z`
      : '';

    // 눈금선(4줄) + 왼쪽 페이스 라벨
    const grid = [0, 1 / 3, 2 / 3, 1].map((t) => {
      const y = PADT + t * LINE_H;
      const p = lo + t * (hi - lo);
      return `<line x1="${PADL}" y1="${y.toFixed(1)}" x2="${W - PADR}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
              <text x="${PADL - 6}" y="${(y + 3).toFixed(1)}" font-size="9" fill="var(--mute)" text-anchor="end">${fmtPace(p)}</text>`;
    }).join('');
    const arrowHint = `<text x="4" y="${PADT - 10}" font-size="8.5" fill="var(--mute)">▲ 빠름</text>
                       <text x="4" y="${PADT + LINE_H + 19}" font-size="8.5" fill="var(--mute)">▼ 느림</text>`;

    // 평균선
    const avgY = yFor(avg);
    const avgLine = `<line x1="${PADL}" y1="${avgY.toFixed(1)}" x2="${W - PADR + 2}" y2="${avgY.toFixed(1)}" stroke="var(--amber)" stroke-width="1.2" stroke-dasharray="4 4" opacity=".9"/>
      <text x="${W - PADR + 5}" y="${(avgY - 1).toFixed(1)}" font-size="8.5" font-weight="800" fill="var(--amber)">평균</text>
      <text x="${W - PADR + 5}" y="${(avgY + 9).toFixed(1)}" font-size="8.5" font-weight="700" fill="var(--amber)">${fmtPace(avg)}</text>`;

    // 거리 막대 + 날짜
    const bars = list.map((r, i) => {
      const km = r.distanceKm || 0;
      const h = Math.max((km / maxKm) * BAR_H, 2);
      const bw = Math.min(cw * 0.5, 22);
      const d = runDate(r);
      const dateLabel = d ? `${d.getMonth() + 1}/${d.getDate()}` : '-';
      const showKm = n <= 8;
      return `<rect x="${(xFor(i) - bw / 2).toFixed(1)}" y="${(BAR_TOP + BAR_H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="var(--go)" opacity=".28"/>
        ${showKm ? `<text x="${xFor(i).toFixed(1)}" y="${(BAR_TOP + BAR_H - h - 3).toFixed(1)}" font-size="8" fill="var(--mute)" text-anchor="middle">${km.toFixed(1)}</text>` : ''}
        <text x="${xFor(i).toFixed(1)}" y="${DATE_Y}" font-size="8.5" fill="var(--mute)" text-anchor="middle">${dateLabel}</text>`;
    }).join('');
    const barLabel = `<text x="${PADL - 6}" y="${BAR_TOP + BAR_H - 2}" font-size="8" fill="var(--mute)" text-anchor="end">km</text>`;

    // 점 + 값 라벨 (기록이 많으면 최고/최신만 라벨)
    const dots = list.map((r, i) => {
      const p = r.paceMinPerKm;
      const faster = p <= avg;
      const isBest = i === bestIdx;
      const isLast = i === n - 1;
      const showLabel = n <= 7 || isBest || isLast;
      const color = faster ? 'var(--go)' : 'var(--amber)';
      return `${isBest ? `<circle cx="${pts[i].x.toFixed(1)}" cy="${pts[i].y.toFixed(1)}" r="9" fill="none" stroke="#FFD60A" stroke-width="1.5" opacity=".9"/>` : ''}
        <circle cx="${pts[i].x.toFixed(1)}" cy="${pts[i].y.toFixed(1)}" r="4.2" fill="${color}" stroke="var(--surface)" stroke-width="2"/>
        ${showLabel ? `<text x="${pts[i].x.toFixed(1)}" y="${(pts[i].y - (isBest ? 13 : 9)).toFixed(1)}" font-size="9" font-weight="700" fill="${isBest ? '#FFD60A' : 'var(--paper)'}" text-anchor="middle">${isBest ? '★ ' : ''}${fmtPace(p)}</text>` : ''}`;
    }).join('');

    // 터치 영역 + 선택 하이라이트
    const hits = list.map((_, i) =>
      `<rect data-idx="${i}" x="${(PADL + cw * i).toFixed(1)}" y="${PADT - 14}" width="${cw.toFixed(1)}" height="${(DATE_Y - PADT + 20).toFixed(1)}" fill="transparent" style="cursor:pointer"/>`).join('');

    container.innerHTML = `
      <div class="pace-summary">
        <div class="pace-summary-item"><span>${fmtPace(avg)}</span><label>평균 페이스</label></div>
        <div class="pace-summary-item"><span style="color:#FFD60A;">${fmtPace(minP)}</span><label>최고 기록</label></div>
        <div class="pace-summary-item"><span class="${deltaSec === null || Math.abs(deltaSec) < 2 ? '' : deltaSec > 0 ? 'faster' : 'slower'}">${
          deltaSec === null ? '-' : Math.abs(deltaSec) < 2 ? '비슷' : `${deltaSec > 0 ? '▲' : '▼'}${Math.abs(deltaSec)}초`
        }</span><label>직전 대비</label></div>
      </div>
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;">
        <defs>
          <linearGradient id="${uid}-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#2BD97C" stop-opacity=".38"/><stop offset="100%" stop-color="#2BD97C" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${grid}${arrowHint}
        <rect id="${uid}-sel" x="0" y="${PADT - 14}" width="${cw.toFixed(1)}" height="${(DATE_Y - PADT + 20).toFixed(1)}" rx="8" fill="#fff" opacity="0"/>
        ${bars}${barLabel}
        ${n > 1 ? `<path d="${areaPath}" fill="url(#${uid}-fill)"/>` : ''}
        ${avgLine}
        <path d="${linePath}" fill="none" stroke="var(--go)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
        ${dots}
        ${hits}
      </svg>`;

    const selRect = container.querySelector(`#${uid}-sel`);
    function select(i) {
      const r = list[i];
      selRect.setAttribute('x', (PADL + cw * i).toFixed(1));
      selRect.setAttribute('opacity', '0.07');
      const d = runDate(r);
      const wd = ['일', '월', '화', '수', '목', '금', '토'];
      const dateStr = d ? `${d.getMonth() + 1}월 ${d.getDate()}일 (${wd[d.getDay()]})` : '날짜 없음';
      const km = r.distanceKm || 0;
      const sec = r.durationSec || r.paceMinPerKm * 60 * km;
      const diff = Math.round((avg - r.paceMinPerKm) * 60); // +면 평균보다 빠름
      const vsAvg = Math.abs(diff) < 2
        ? '평균과 비슷했어요'
        : `평균보다 <b class="${diff > 0 ? 'faster' : 'slower'}">${Math.abs(diff)}초 ${diff > 0 ? '빨랐어요' : '느렸어요'}</b>`;
      const badge = i === bestIdx ? '<span class="pace-best-tag">최고 기록</span>' : '';
      if (detailEl) {
        detailEl.innerHTML = `
          <div class="pace-detail-head"><b>${dateStr}</b>${badge}</div>
          <div class="pace-detail-grid">
            <div><span>${km.toFixed(2)}km</span><label>거리</label></div>
            <div><span>${fmtPace(r.paceMinPerKm)}</span><label>페이스/km</label></div>
            <div><span>${fmtDuration(sec)}</span><label>시간</label></div>
          </div>
          <div class="pace-detail-vs">${vsAvg}</div>`;
      }
    }
    container.querySelectorAll('rect[data-idx]').forEach((el) => {
      el.addEventListener('click', () => select(Number(el.dataset.idx)));
    });
    select(n - 1);
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
    voiceMuted = localStorage.getItem(VOICE_MUTE_KEY) === '1';
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
      openDestScreen();
    });
    setupDestScreen();
    $('xw-minus').addEventListener('click', () => changeXw(-1));
    $('xw-plus').addEventListener('click', () => changeXw(1));

    $('btn-start-run').addEventListener('click', () => {
      $('btn-start-run').classList.add('hidden');
      $('crosswalk-selector').classList.add('hidden');
      $('premium-run-banner').classList.add('hidden');
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
    $('btn-home-items').addEventListener('click', openItemsScreen);
    $('runner-character-box').addEventListener('click', (e) => {
      if (e.target.closest('[data-open-items]')) openItemsScreen();
    });
    $('items-premium').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pm-start]');
      if (b) startPremiumRun(b.dataset.pmStart);
    });
    setInterval(tickWalk, 1000); // 걷는 캐릭터의 거리 표시를 1초마다 갱신
    $('btn-items-back').addEventListener('click', () => {
      showScreen('screen-home');
      loadHomeScreen();
    });
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
    $('profile-voice-toggle').addEventListener('change', (e) => {
      const on = e.target.checked;
      voiceMuted = !on;
      localStorage.setItem(VOICE_MUTE_KEY, on ? '0' : '1');
      if (on) Voice.speak('음성 안내를 켰어요');
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
