// 경로 요청, 횡단보도 최소화 스코어링(추후 확장), SVG 위에 경로 그리기
const RouteEngine = (() => {

  async function fetchWalkRoute(start, end) {
    // start/end: {lat, lng}
    const res = await fetch('/api/tmap-route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start, end }),
    });
    if (!res.ok) throw new Error('경로를 못 가져왔어요');
    return res.json(); // { points: [{lat,lng}, ...], distanceMeters, turns: [...] }
  }

  async function searchNearby(keyword, center) {
    const res = await fetch('/api/kakao-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword, lat: center.lat, lng: center.lng }),
    });
    if (!res.ok) throw new Error('주변 검색에 실패했어요');
    return res.json(); // [{name, lat, lng}, ...]
  }

  // 경로 좌표 근처 횡단보도 개수 (전국횡단보도표준데이터)
  async function countCrosswalksNear(routePoints) {
    try {
      const res = await fetch('/api/crosswalk-count', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: routePoints }),
      });
      if (!res.ok) return 0;
      const data = await res.json();
      return data.count || 0;
    } catch {
      return 0;
    }
  }

  // 경로 주변 도로의 나쁜 노면(모래/흙/자갈 등) 개수 (OpenStreetMap)
  async function countBadSurfaceNear(routePoints) {
    try {
      const res = await fetch('/api/surface-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: routePoints }),
      });
      if (!res.ok) return 0;
      const data = await res.json();
      return data.badSurfaceCount || 0;
    } catch {
      return 0;
    }
  }

  // 후보 경로 여러 개 중 횡단보도+나쁜 노면이 가장 적은 걸 고름 (횡단보도를 더 무겁게 반영)
  async function pickBestRoute(candidates) {
    let best = candidates[0];
    let bestScore = Infinity;
    for (const c of candidates) {
      const [crosswalks, badSurface] = await Promise.all([
        countCrosswalksNear(c.points),
        countBadSurfaceNear(c.points),
      ]);
      const score = crosswalks * 2 + badSurface;
      c._score = score; // 디버깅/표시용으로 남겨둠
      if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  // 목적지 + 목표거리: 직선 경로가 짧으면 근처 공원 후보 몇 곳을 경유하는 경로를 만들어서
  // 그중 횡단보도/나쁜 노면이 가장 적은 경로를 고름. 이미 충분히 길면 최단경로 그대로.
  async function buildRouteToDestination(start, dest, targetKm) {
    const direct = await fetchWalkRoute(start, dest);
    if (direct.distanceMeters / 1000 >= targetKm - 0.3) {
      return direct;
    }
    const parks = await searchNearby('공원', start).catch(() => []);
    if (parks.length === 0) return direct;

    const candidates = [];
    for (const via of parks.slice(0, 3)) {
      try {
        const leg1 = await fetchWalkRoute(start, { lat: via.lat, lng: via.lng });
        const leg2 = await fetchWalkRoute({ lat: via.lat, lng: via.lng }, dest);
        candidates.push({
          points: [...leg1.points, ...leg2.points],
          distanceMeters: leg1.distanceMeters + leg2.distanceMeters,
          turns: [...(leg1.turns || []), ...(leg2.turns || [])],
          via: via.name,
        });
      } catch { /* 이 후보는 건너뜀 */ }
    }
    if (candidates.length === 0) return direct;

    // 목표거리를 채우는 후보들 중에서 고르고, 하나도 없으면 그나마 가장 긴 걸로
    const qualifying = candidates.filter((c) => c.distanceMeters / 1000 >= targetKm - 0.3);
    return pickBestRoute(qualifying.length ? qualifying : candidates);
  }

  // 목적지 없이 거리만: 근처 공원 후보 몇 곳을 반환점으로 삼아 "왕복"(간 길 그대로 되돌아오기) 경로를 만들고,
  // 그중 횡단보도/나쁜 노면이 가장 적은 경로를 고름
  async function buildLoopRoute(start, targetKm) {
    const parks = await searchNearby('공원', start).catch(() => []);
    if (parks.length === 0) throw new Error('근처에 추천할 만한 공원을 못 찾았어요');

    const candidates = [];
    for (const turnaround of parks.slice(0, 3)) {
      try {
        const out = await fetchWalkRoute(start, { lat: turnaround.lat, lng: turnaround.lng });
        const backPoints = [...out.points].reverse(); // 왕복이니 갔던 길 그대로 되돌아옴
        candidates.push({
          points: [...out.points, ...backPoints],
          distanceMeters: out.distanceMeters * 2,
          turns: out.turns || [], // 복귀 구간은 반대 방향이라 회전 안내는 갈 때 것만 사용
          via: turnaround.name,
        });
      } catch { /* 이 후보는 건너뜀 */ }
    }
    if (candidates.length === 0) throw new Error('경로를 만들 수 없었어요');

    // 목표거리(±20%)에 맞는 후보들 중에서 고르고, 없으면 거리가 제일 가까운 걸로
    const qualifying = candidates.filter((c) => Math.abs(c.distanceMeters / 1000 - targetKm) <= targetKm * 0.2);
    if (qualifying.length) return pickBestRoute(qualifying);
    candidates.sort((a, b) => Math.abs(a.distanceMeters / 1000 - targetKm) - Math.abs(b.distanceMeters / 1000 - targetKm));
    return candidates[0];
  }

  // 두 좌표 사이 직선 거리(m)
  function haversineMeters(a, b) {
    const R = 6371000;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function computeBearing(a, b) {
    const toRad = (d) => (d * Math.PI) / 180;
    const toDeg = (r) => (r * 180) / Math.PI;
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  // 특정 지점에서 방향(도)과 거리(m)만큼 떨어진 좌표 계산 - 카메라를 앞으로 밀어서
  // 내 마커가 화면 아래쪽에 오고 앞길이 더 잘 보이는 "로드뷰" 느낌을 내는 데 씀
  function destinationPoint(start, bearingDeg, distanceMeters) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const toDeg = (r) => (r * 180) / Math.PI;
    const brng = toRad(bearingDeg);
    const lat1 = toRad(start.lat), lng1 = toRad(start.lng);
    const angDist = distanceMeters / R;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angDist) + Math.cos(lat1) * Math.sin(angDist) * Math.cos(brng));
    const lng2 = lng1 + Math.atan2(
      Math.sin(brng) * Math.sin(angDist) * Math.cos(lat1),
      Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2)
    );
    return { lat: toDeg(lat2), lng: ((toDeg(lng2) + 540) % 360) - 180 };
  }

  // 실제 3D 지도(MapLibre + OpenFreeMap, 키 필요 없음) 위에 경로를 그리고,
  // 진행률(0~1) -> 좌표 변환 함수, 초기 진행 방향(bearing)도 같이 반환
  function renderOnMap(containerEl, points, existingMap) {
    if (existingMap) {
      existingMap.remove(); // 이전 러닝의 지도 인스턴스를 정리하고 새로 만듦
    }
    containerEl.innerHTML = '';

    const start = points[0];
    const initialBearing = points.length > 1 ? computeBearing(points[0], points[1]) : 0;

    const map = new maplibregl.Map({
      container: containerEl,
      style: 'https://tiles.openfreemap.org/styles/bright',
      center: [start.lng, start.lat],
      zoom: 18.5,
      pitch: 72,
      maxPitch: 85,
      bearing: initialBearing,
      attributionControl: true,
    });

    const routeGeoJson = {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) },
    };

    map.on('load', () => {
      // 라벨 레이어 바로 아래에 3D 건물을 끼워 넣음 (건물이 글자를 안 가리게)
      const layers = map.getStyle().layers;
      let labelLayerId;
      for (const layer of layers) {
        if (layer.type === 'symbol' && layer.layout && layer.layout['text-field']) {
          labelLayerId = layer.id;
          break;
        }
      }
      map.addSource('run-pacer-buildings', {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
      });
      map.addLayer({
        id: '3d-buildings',
        source: 'run-pacer-buildings',
        'source-layer': 'building',
        type: 'fill-extrusion',
        minzoom: 14,
        paint: {
          'fill-extrusion-color': '#2a3b33',
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 15, 0, 15.05, ['coalesce', ['get', 'render_height'], 8]],
          'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 15, 0, 15.05, ['coalesce', ['get', 'render_min_height'], 0]],
          'fill-extrusion-opacity': 0.85,
        },
      }, labelLayerId);

      map.addSource('run-pacer-route', { type: 'geojson', data: routeGeoJson });
      map.addLayer({
        id: 'run-pacer-route-line',
        type: 'line',
        source: 'run-pacer-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#1D9E75', 'line-width': 6 },
      });
    });

    // 누적 거리 기반으로 0~1 진행률을 실제 좌표로 보간
    const cumDist = [0];
    for (let i = 1; i < points.length; i++) {
      cumDist.push(cumDist[i - 1] + haversineMeters(points[i - 1], points[i]));
    }
    const total = cumDist[cumDist.length - 1] || 1;

    function pointAtProgress(t) {
      const target = total * Math.min(Math.max(t, 0), 1);
      let i = 1;
      while (i < cumDist.length && cumDist[i] < target) i++;
      if (i >= cumDist.length) return points[points.length - 1];
      const segStart = cumDist[i - 1];
      const segEnd = cumDist[i];
      const segT = segEnd > segStart ? (target - segStart) / (segEnd - segStart) : 0;
      const a = points[i - 1];
      const b = points[i];
      return { lat: a.lat + (b.lat - a.lat) * segT, lng: a.lng + (b.lng - a.lng) * segT };
    }

    return { map, pointAtProgress, initialBearing };
  }

  return {
    fetchWalkRoute, searchNearby, pickBestRoute, buildRouteToDestination, buildLoopRoute,
    renderOnMap, haversineMeters, computeBearing, destinationPoint,
  };
})();
