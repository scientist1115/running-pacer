// WebXR(ARCore) 기반 AR 렌더러 - 안드로이드 크롬처럼 immersive-ar를 지원하는 기기에서만 동작.
// 진짜 공간 추적(SLAM)을 브라우저가 대신 해주니, 여기서는 "GPS 좌표 -> XR 로컬 3D 좌표" 변환과
// 그 좌표에 셰브론/리본을 그리는 것만 담당함. 카메라 화면 합성 자체는 브라우저가 자동으로 해줌.
const ArXR = (() => {
  let renderer = null;
  let scene = null;
  let camera = null;
  let xrSession = null;
  let calibrated = false;
  let calibrationRefPos = null;   // XR 세션을 시작한 시점의 GPS 좌표 (이 점을 기준으로 상대 위치를 계산)
  let calibrationYawOffset = 0;   // 세션 시작 시점의 나침반 방향(라디안) - XR의 "정면"을 진북 기준으로 맞추는 보정값
  let pathGroup = null;
  let chevronTexture = null;

  async function isSupported() {
    if (!navigator.xr) return false;
    try {
      return await navigator.xr.isSessionSupported('immersive-ar');
    } catch {
      return false;
    }
  }

  // 캔버스에 그릴 셰브론(^) 모양을 텍스처로 한 번만 만들어서 재사용
  function makeChevronTexture() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.strokeStyle = '#EAFFFB';
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = '#38E1FF';
    ctx.shadowBlur = 24;
    ctx.beginPath();
    ctx.moveTo(20, 46);
    ctx.lineTo(64, 14);
    ctx.lineTo(108, 46);
    ctx.stroke();
    return new THREE.CanvasTexture(canvas);
  }

  // 두 GPS 좌표 사이의 동쪽/북쪽 방향 거리(m) - 짧은 거리(수십~수백m)라 평면 근사로 충분히 정확함
  function enuOffset(from, to) {
    const R = 6371000;
    const dLat = ((to.lat - from.lat) * Math.PI) / 180;
    const dLng = ((to.lng - from.lng) * Math.PI) / 180;
    const north = dLat * R;
    const east = dLng * R * Math.cos((from.lat * Math.PI) / 180);
    return { east, north };
  }

  function init(canvas) {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    renderer.xr.enabled = true;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera();
    scene.add(camera);
    pathGroup = new THREE.Group();
    scene.add(pathGroup);
    chevronTexture = makeChevronTexture();
    scene.add(new THREE.AmbientLight(0xffffff, 1));
  }

  // calibHeadingDeg: 세션 시작 시점의 나침반 방향(도), gpsPos: 세션 시작 시점의 GPS 좌표
  async function start(canvas, calibHeadingDeg, gpsPos) {
    if (!renderer) init(canvas);
    calibrationRefPos = gpsPos;
    calibrationYawOffset = ((calibHeadingDeg || 0) * Math.PI) / 180;
    calibrated = true;

    xrSession = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: document.getElementById('screen-run') },
    });
    await renderer.xr.setSession(xrSession);
    renderer.setAnimationLoop(() => renderer.render(scene, camera));
    xrSession.addEventListener('end', () => { xrSession = null; });
    return xrSession;
  }

  function stop() {
    if (renderer) renderer.setAnimationLoop(null);
    if (xrSession) { xrSession.end().catch(() => {}); xrSession = null; }
    if (pathGroup) pathGroup.clear();
    calibrated = false;
  }

  // pathPoints: 경로 위 앞으로의 지점들 [{lat,lng}, ...] (가까운 것부터 먼 것 순)
  function updatePath(pathPoints) {
    if (!calibrated || !pathGroup || !calibrationRefPos) return;
    pathGroup.clear();
    const linePts = [];
    const cos = Math.cos(-calibrationYawOffset);
    const sin = Math.sin(-calibrationYawOffset);

    pathPoints.forEach((pt, i) => {
      const raw = enuOffset(calibrationRefPos, pt);
      // calibrationYawOffset만큼 회전시켜서, 세션 시작 시점의 나침반 방향을 XR 좌표계의 "정면(-Z)"에 맞춤
      const x = raw.east * cos - raw.north * sin;
      const z = -(raw.east * sin + raw.north * cos);
      const y = 0; // 고도 데이터가 없어 지면 높이로 가정

      if (i % 3 === 0) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
          map: chevronTexture, transparent: true, depthTest: false,
        }));
        sprite.position.set(x, y, z);
        sprite.scale.set(0.7, 0.7, 0.7);
        pathGroup.add(sprite);
      }
      linePts.push(new THREE.Vector3(x, y + 0.02, z));
    });

    if (linePts.length > 1) {
      const geo = new THREE.BufferGeometry().setFromPoints(linePts);
      const mat = new THREE.LineBasicMaterial({ color: 0x38e1ff, transparent: true, opacity: 0.85 });
      pathGroup.add(new THREE.Line(geo, mat));
    }
  }

  return { isSupported, start, stop, updatePath };
})();
