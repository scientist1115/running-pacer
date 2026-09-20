// 경로 요청, 횡단보도 최소화 스코어링(추후 확장), SVG 위에 경로 그리기
const RouteEngine = (() => {

  // 지정한 시간(ms) 안에 안 끝나면 포기하는 fetch (느린 외부 API 때문에 전체가 멈추지 않게)
  async function fetchWithTimeout(url, options, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchWalkRoute(start, end) {
    // start/end: {lat, lng}
    const res = await fetchWithTimeout('/api/tmap-route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start, end }),
    }, 8000);
    if (!res.ok) throw new Error('경로를 못 가져왔어요');
    return res.json(); // { points: [{lat,lng}, ...], distanceMeters, turns: [...] }
  }

  async function searchNearby(keyword, center) {
    const res = await fetchWithTimeout('/api/kakao-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword, lat: center.lat, lng: center.lng }),
    }, 6000);
    if (!res.ok) throw new Error('주변 검색에 실패했어요');
    return res.json(); // [{name, lat, lng}, ...]
  }

  // 지정한 범위(bbox) 안의 횡단보도 좌표 목록을 서버에서 가져옴 (정부+OSM 합쳐서)
  async function fetchCrosswalkPointsInBox(minLat, maxLat, minLng, maxLng) {
    const res = await fetchWithTimeout('/api/crosswalk-count', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minLat, maxLat, minLng, maxLng }),
    }, 9000);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      console.warn('횡단보도 계산 실패:', res.status, data.error, data.sources, data.errors);
      return { points: [], ok: false };
    }
    const errText = data.errors?.gov || data.errors?.osm
      ? ` (정부실패: ${data.errors?.gov || '없음'} / OSM실패: ${data.errors?.osm || '없음'})`
      : '';
    console.log(`[횡단보도 확인] 범위 안 ${data.points?.length || 0}개 (정부: ${data.sources?.gov} / OSM: ${data.sources?.osm})${errText}`);
    return { points: data.points || [], ok: true };
  }

  /* ================= 횡단보도(신호등) 세기 =================
   * 세 가지 자료를 합쳐서 "이 경로가 실제로 건너는 횟수"를 셈:
   *  1) 티맵 경로가 직접 알려주는 횡단보도 (경로 계산 결과 - 가장 정확하고 항상 있음)
   *  2) 지자체 횡단보도 자료 + OpenStreetMap (티맵이 놓친 곳 보완)
   * 예전에는 경로가 들어 있는 "네모난 범위" 안의 횡단보도를 전부 셌는데(경로에서 멀리 떨어진 것도 포함),
   * 이제는 경로선에서 18m 안에 있는 것만, 지나가는 순서대로 하나씩 셈. 갔다가 되돌아오는 코스는 두 번 건너니까 두 번으로 셈.
   */
  const CROSS_RADIUS_M = 18;  // 경로에서 이 거리 안의 횡단보도만 "건너는 것"으로 봄
  const DATA_MERGE_M = 15;    // 같은 횡단보도를 가리키는 여러 점(양끝·중심 등)을 하나로 묶는 거리
  const TMAP_MATCH_M = 20;    // 티맵이 알려준 횡단보도와 이 거리 안이면 같은 횡단보도로 봄

  // 경로를 stepM 간격의 점들로 쪼개고, 각 점에 시작부터의 거리 s(m)를 붙임
  function densifyRoute(points, stepM = 5) {
    const out = [];
    if (!points.length) return out;
    let s = 0;
    out.push({ lat: points[0].lat, lng: points[0].lng, s });
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const d = haversineMeters(a, b);
      const n = Math.max(1, Math.round(d / stepM));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        out.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, s: s + d * t });
      }
      s += d;
    }
    return out;
  }

  // 횡단보도 지점들(pts) 근처를 경로가 지나가는 "사건"의 위치(경로상 거리 s)들을 돌려줌.
  // 같은 지점을 두 번 지나가면(왕복) 두 번으로 셈. mergeM > 0이면 그보다 가까운 사건끼리는 하나로 묶음.
  function crossingEvents(samples, pts, radius, mergeM) {
    if (!samples.length || !pts || !pts.length) return [];
    const mx = 111320 * Math.cos((samples[0].lat * Math.PI) / 180);
    const my = 110540;
    const cell = radius * 2;
    const grid = new Map();
    samples.forEach((p, i) => {
      const key = `${Math.floor((p.lng * mx) / cell)}_${Math.floor((p.lat * my) / cell)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(i);
    });
    const events = [];
    for (const c of pts) {
      const cx = c.lng * mx;
      const cy = c.lat * my;
      const gx = Math.floor(cx / cell);
      const gy = Math.floor(cy / cell);
      const hits = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const list = grid.get(`${gx + dx}_${gy + dy}`);
          if (!list) continue;
          for (const i of list) {
            const ex = samples[i].lng * mx - cx;
            const ey = samples[i].lat * my - cy;
            if (ex * ex + ey * ey <= radius * radius) hits.push(i);
          }
        }
      }
      if (!hits.length) continue;
      hits.sort((p, q) => p - q);
      let runStart = hits[0];
      let prev = hits[0];
      for (let k = 1; k < hits.length; k++) {
        if (hits[k] - prev > 6) { // 30m 넘게 떨어져서 다시 만나면 다른 번(왕복의 되돌아오는 길 등)
          events.push((samples[runStart].s + samples[prev].s) / 2);
          runStart = hits[k];
        }
        prev = hits[k];
      }
      events.push((samples[runStart].s + samples[prev].s) / 2);
    }
    events.sort((p, q) => p - q);
    if (!mergeM) return events;
    const merged = [];
    for (const e of events) {
      const last = merged[merged.length - 1];
      if (last && e - last.last <= mergeM) last.last = e;
      else merged.push({ first: e, last: e });
    }
    return merged.map((m) => (m.first + m.last) / 2);
  }

  // 후보 경로 하나의 횡단보도 횟수 계산: 티맵이 알려준 것 + 자료에만 있는 것(티맵과 겹치지 않는 것)
  function annotateCrossings(cand, dataPoints, dataOk) {
    const samples = densifyRoute(cand.points, 5);
    const tm = crossingEvents(samples, cand.crosswalks || [], CROSS_RADIUS_M, 0);
    let extra = 0;
    if (dataOk && dataPoints.length) {
      const dv = crossingEvents(samples, dataPoints, CROSS_RADIUS_M, DATA_MERGE_M);
      extra = dv.filter((s) => !tm.some((t) => Math.abs(t - s) <= TMAP_MATCH_M)).length;
    }
    return { crosswalkCount: tm.length + extra, crosswalkTmap: tm.length, crosswalkDataOk: dataOk };
  }

  // 경로 하나만 확인할 때 쓰는 간단 버전 - count: 횟수, ok: 지도 자료 조회 성공 여부(실패해도 티맵 기준 횟수는 있음)
  async function countCrosswalksNear(routePoints, tmapCrosswalks) {
    try {
      const lats = routePoints.map((p) => p.lat), lngs = routePoints.map((p) => p.lng);
      const { points, ok } = await fetchCrosswalkPointsInBox(
        Math.min(...lats) - 0.002, Math.max(...lats) + 0.002,
        Math.min(...lngs) - 0.002, Math.max(...lngs) + 0.002,
      );
      const a = annotateCrossings({ points: routePoints, crosswalks: tmapCrosswalks || [] }, points, ok);
      return { count: a.crosswalkCount, ok, tmap: a.crosswalkTmap };
    } catch (e) {
      console.warn('횡단보도 계산 실패:', e.message);
      const a = annotateCrossings({ points: routePoints, crosswalks: tmapCrosswalks || [] }, [], false);
      return { count: a.crosswalkCount, ok: false, tmap: a.crosswalkTmap };
    }
  }

  // 경로 주변 도로의 나쁜 노면(모래/흙/자갈 등) 개수 (OpenStreetMap) - 느리면 0점 처리하고 넘어감
  async function countBadSurfaceNear(routePoints) {
    try {
      const res = await fetchWithTimeout('/api/surface-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: routePoints }),
      }, 5000);
      if (!res.ok) return 0;
      const data = await res.json();
      return data.badSurfaceCount || 0;
    } catch {
      return 0;
    }
  }

  // 후보 경로들을 횡단보도+나쁜 노면 점수로 채점해서 좋은 순으로 정렬해 반환.
  // 지도 자료(정부+OSM)는 후보마다 따로 조회하지 않고 전체를 합친 범위로 한 번만 조회함
  // (그래야 무료 공개 Overpass 서버의 요청 제한에 안 걸림). opts.skipSurface: 노면 검사 생략(후보가 하나뿐일 때)
  async function pickBestRoute(candidates, opts = {}) {
    const allPoints = candidates.flatMap((c) => c.points);
    const lats = allPoints.map((p) => p.lat), lngs = allPoints.map((p) => p.lng);
    const [crosswalkResult, badSurfaceCounts] = await Promise.all([
      fetchCrosswalkPointsInBox(
        Math.min(...lats) - 0.003, Math.max(...lats) + 0.003,
        Math.min(...lngs) - 0.003, Math.max(...lngs) + 0.003,
      ).catch(() => ({ points: [], ok: false })),
      opts.skipSurface ? Promise.resolve(candidates.map(() => 0)) : Promise.all(candidates.map((c) => countBadSurfaceNear(c.points))),
    ]);

    const scored = candidates.map((c, i) => {
      const a = annotateCrossings(c, crosswalkResult.points, crosswalkResult.ok);
      // 방향 추정(bearing) 기반 후보는 실제 검증된 장소가 아니라 임의로 잡은 지점이라,
      // 산길/외곽처럼 엉뚱한 곳으로 뻗을 수 있음. 공원 후보보다 약한 페널티를 줘서
      // 점수가 비슷하면 공원 쪽을 우선하도록 함 (그래도 크게 나으면 여전히 bearing 쪽이 이김)
      const sourcePenalty = c.source === 'bearing' ? 1 : 0;
      return { ...c, ...a, score: a.crosswalkCount * 2 + badSurfaceCounts[i] + sourcePenalty };
    });
    scored.sort((a, b) => a.score - b.score);
    return scored;
  }

  /* ================= 경로 후보 풀 + "신호등 N개로 다시 찾기" =================
   * 경로를 만들 때 만든 후보들을 ctx.pool에 모아 두고, 사용자가 신호등 개수를 바꾸면
   * 풀에서 그 개수에 가장 가까운 경로를 바로 고름. 풀에 없으면 후보를 더 넓게 만들어서(한 번만) 다시 고름.
   */
  function pickByCount(ctx, want) {
    const valid = ctx.pool.filter((c) => ctx.isValid(c));
    const list = valid.length ? valid : ctx.pool;
    const key = (c) => [
      Math.abs(c.crosswalkCount - want),            // 원하는 개수에 가장 가까운 것
      c.crosswalkCount > want ? 1 : 0,              // 같은 차이면 더 적은 쪽
      Math.abs(c.distanceMeters - ctx.targetMeters), // 그다음 목표 거리에 가까운 것
      c.score,
    ];
    return list.slice().sort((a, b) => {
      const ka = key(a), kb = key(b);
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
      return 0;
    })[0];
  }

  function withCtx(best, ctx) {
    return { ...best, ctx, routeOptions: ctx.pool };
  }

  // 왕복(갔던 길 그대로 되돌아오기) 후보 하나
  async function outAndBack(start, turn) {
    const out = await fetchWalkRoute(start, { lat: turn.lat, lng: turn.lng });
    const backPoints = [...out.points].reverse();
    return {
      points: [...out.points, ...backPoints],
      distanceMeters: out.distanceMeters * 2,
      turns: out.turns || [], // 복귀 구간은 반대 방향이라 회전 안내는 갈 때 것만 사용
      crosswalks: out.crosswalks || [], // 되돌아올 때도 같은 곳을 지나므로 세는 쪽에서 2번으로 셈
      via: turn.name,
      source: turn.source,
    };
  }

  // A -> via -> B 두 구간을 이은 후보 하나
  async function viaRoute(a, via, b, name) {
    const [leg1, leg2] = await Promise.all([fetchWalkRoute(a, via), fetchWalkRoute(via, b)]);
    return {
      points: [...leg1.points, ...leg2.points],
      distanceMeters: leg1.distanceMeters + leg2.distanceMeters,
      turns: [...(leg1.turns || []), ...(leg2.turns || [])],
      crosswalks: [...(leg1.crosswalks || []), ...(leg2.crosswalks || [])],
      via: name,
    };
  }

  // 목표 거리를 채우도록 경유지를 잡음: 출발→경유→도착 걷는 거리가 목표쯤 되는 지점을 이분탐색으로 찾음
  function viaForTarget(start, dest, targetM, bearing) {
    let lo = 0;
    let hi = targetM / 1.3;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      const v = destinationPoint(start, bearing, mid);
      const len = 1.3 * (mid + haversineMeters(v, dest)); // 실제 도로는 직선보다 30% 정도 더 김
      if (len < targetM) lo = mid; else hi = mid;
    }
    return destinationPoint(start, bearing, (lo + hi) / 2);
  }

  // 풀에 원하는 개수가 없을 때 후보를 넓혀서 더 만듦 (방향/거리를 더 다양하게)
  async function expandPool(ctx) {
    let raw = [];
    if (ctx.mode === 'loop') {
      const half = ctx.targetMeters / 2;
      const specs = [30, 90, 150, 210, 270, 330].map((b) => [b, 0.72]).concat([15, 75, 135, 195, 255, 315].map((b) => [b, 0.85]));
      raw = await Promise.all(specs.map(([b, f], i) => {
        const pt = destinationPoint(ctx.start, b, half * f);
        return outAndBack(ctx.start, { lat: pt.lat, lng: pt.lng, name: `${ctx.targetKm}km 코스 추가${i + 1}`, source: 'bearing' }).catch(() => null);
      }));
    } else if (ctx.targetMeters && ctx.mode === 'destTarget') {
      raw = await Promise.all([0, 60, 120, 180, 240, 300].map((b, i) => {
        const v = viaForTarget(ctx.start, ctx.dest, ctx.targetMeters, b);
        return viaRoute(ctx.start, v, ctx.dest, `경유 ${i + 1}`).catch(() => null);
      }));
    } else {
      // 목적지만: 최단 경로에서 옆으로 살짝 비켜난 경유지로 돌아가는 후보들
      const d = haversineMeters(ctx.start, ctx.dest);
      const brg = computeBearing(ctx.start, ctx.dest);
      const mid = destinationPoint(ctx.start, brg, d / 2);
      const offs = [[-90, 0.22], [90, 0.22], [-90, 0.4], [90, 0.4]];
      raw = await Promise.all(offs.map(([side, f], i) => {
        const v = destinationPoint(mid, (brg + side + 360) % 360, d * f);
        return viaRoute(ctx.start, v, ctx.dest, `우회 ${i + 1}`).catch(() => null);
      }));
    }
    const cands = raw.filter(Boolean);
    if (!cands.length) return [];
    return pickBestRoute(cands);
  }

  // 사용자가 신호등 개수를 want로 바꿨을 때: 그 개수에 가장 가까운 경로를 골라 반환.
  // exact: 정확히 그 개수인 경로를 찾았는지
  async function refindRoute(base, want) {
    const ctx = base.ctx;
    if (!ctx) return { ...base, exact: base.crosswalkCount === want };
    let best = pickByCount(ctx, want);
    if (best.crosswalkCount !== want && !ctx.expanded) {
      ctx.expanded = true;
      const more = await expandPool(ctx).catch(() => []);
      if (more.length) {
        ctx.pool = ctx.pool.concat(more);
        best = pickByCount(ctx, want);
      }
    }
    return { ...withCtx(best, ctx), exact: best.crosswalkCount === want };
  }

  // 목적지만 (거리 지정 없음): 최단 경로를 기본으로, 신호등 수를 바꾸면 우회 후보를 찾음
  async function buildDestinationRoute(start, dest) {
    const direct = await fetchWalkRoute(start, dest);
    const scored = await pickBestRoute([direct], { skipSurface: true });
    const ctx = {
      mode: 'destOnly', start, dest, targetKm: null, targetMeters: direct.distanceMeters, pool: scored, expanded: false,
      isValid: (c) => c.distanceMeters <= direct.distanceMeters * 1.7 + 300,
    };
    return withCtx(scored[0], ctx);
  }

  // 목적지 + 목표거리: 직선 경로가 짧으면 근처 공원 후보 몇 곳을 경유하는 경로를 만들어서
  // 그중 횡단보도/나쁜 노면이 가장 적은 경로를 고름. 이미 충분히 길면 최단경로 그대로.
  async function buildRouteToDestination(start, dest, targetKm) {
    const targetMeters = targetKm * 1000;
    const ctxBase = {
      mode: 'destTarget', start, dest, targetKm, targetMeters, expanded: false,
      isValid: (c) => c.distanceMeters >= targetMeters - 300 && c.distanceMeters <= targetMeters * 1.35 + 300,
    };
    const direct = await fetchWalkRoute(start, dest);
    if (direct.distanceMeters / 1000 >= targetKm - 0.3) {
      const scored = await pickBestRoute([direct], { skipSurface: true });
      return withCtx(scored[0], { ...ctxBase, pool: scored });
    }
    const parks = await searchNearby('공원', start).catch(() => []);
    let candidates = [];
    if (parks.length) {
      const results = await Promise.all(parks.slice(0, 4).map((via) =>
        viaRoute(start, { lat: via.lat, lng: via.lng }, dest, via.name).catch(() => null)));
      candidates = results.filter(Boolean);
    }
    if (candidates.length === 0) {
      // 공원 후보가 없으면 목표 거리에 맞춘 경유지로 직접 만들어 봄
      const results = await Promise.all([0, 90, 180, 270].map((b, i) => {
        const v = viaForTarget(start, dest, targetMeters, b);
        return viaRoute(start, v, dest, `경유 ${i + 1}`).catch(() => null);
      }));
      candidates = results.filter(Boolean);
    }
    if (candidates.length === 0) {
      const scored = await pickBestRoute([direct], { skipSurface: true });
      return withCtx(scored[0], { ...ctxBase, pool: scored });
    }
    // 목표거리를 채우는 후보들 중에서 고르고, 하나도 없으면 그나마 가장 긴 걸로
    const qualifying = candidates.filter((c) => c.distanceMeters / 1000 >= targetKm - 0.3);
    const scored = await pickBestRoute(qualifying.length ? qualifying : candidates);
    return withCtx(scored[0], { ...ctxBase, pool: scored });
  }

  // 목적지 없이 거리만: 근처 공원 몇 곳 + 시작점 기준 6방향으로 목표거리 절반만큼 떨어진 가상 지점들을
  // 반환점 후보로 삼아 "왕복"(간 길 그대로 되돌아오기) 경로를 여러 개 만들고,
  // 그중 목표거리에 맞으면서 횡단보도/나쁜 노면이 가장 적은 경로를 고름.
  // 공원만 후보로 쓰면 근처에 마침 맞는 거리의 공원이 없을 때 목표거리와 크게 어긋난 경로만 나오는
  // 문제가 있어서, 방향 기반 가상 지점을 같이 써서 항상 목표거리에 가까운 후보를 확보함.
  async function buildLoopRoute(start, targetKm) {
    const parks = await searchNearby('공원', start).catch(() => []);
    const parkTurnarounds = parks.slice(0, 3).map((p) => ({ lat: p.lat, lng: p.lng, name: p.name, source: 'park' }));

    const halfMeters = (targetKm * 1000) / 2;
    // 실제 도로를 따라 걷는 거리는 직선거리보다 보통 20~40% 정도 더 길게 나와서(길이 꺾이고 휘어있으니까),
    // 직선거리로 그대로 반환점을 잡으면 왕복 거리가 목표보다 계속 길게 나옴. 0.72를 곱해서 보정.
    const bearingTurnarounds = [0, 60, 120, 180, 240, 300].map((bearing, i) => {
      const pt = destinationPoint(start, bearing, halfMeters * 0.72);
      return { lat: pt.lat, lng: pt.lng, name: `${targetKm}km 코스 ${i + 1}`, source: 'bearing' };
    });

    const allTurnarounds = [...parkTurnarounds, ...bearingTurnarounds];
    if (allTurnarounds.length === 0) throw new Error('근처에 추천할 만한 경로를 못 찾았어요');

    const results = await Promise.all(allTurnarounds.map((t) => outAndBack(start, t).catch(() => null)));
    const candidates = results.filter(Boolean);
    if (candidates.length === 0) throw new Error('경로를 만들 수 없었어요');

    const ctxBase = {
      mode: 'loop', start, targetKm, targetMeters: targetKm * 1000, expanded: false,
      isValid: (c) => Math.abs(c.distanceMeters / 1000 - targetKm) <= targetKm * 0.25,
    };
    // 목표거리(±25%)에 맞는 후보들 중에서 고르고, 없으면 거리가 제일 가까운 걸로
    const qualifying = candidates.filter((c) => ctxBase.isValid(c));
    if (qualifying.length) {
      const scored = await pickBestRoute(qualifying);
      return withCtx(scored[0], { ...ctxBase, pool: scored });
    }
    const scoredAll = await pickBestRoute(candidates);
    const closest = scoredAll.slice().sort((a, b) => Math.abs(a.distanceMeters - ctxBase.targetMeters) - Math.abs(b.distanceMeters - ctxBase.targetMeters))[0];
    return withCtx(closest, { ...ctxBase, pool: scoredAll });
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
      zoom: 18.3,
      pitch: 82,
      maxPitch: 85,
      bearing: initialBearing,
      attributionControl: true,
    });

    const routeGeoJson = {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) },
    };
    let routeReady = false;   // 지도 레이어가 다 만들어졌는지
    let pendingProgress = null; // 지도가 준비되기 전에 들어온 진행 갱신 요청

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
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 15, 0, 15.05, ['*', ['coalesce', ['get', 'render_height'], 14], 1.6]],
          'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 15, 0, 15.05, ['coalesce', ['get', 'render_min_height'], 0]],
          'fill-extrusion-opacity': 0.9,
        },
      }, labelLayerId);

      map.addSource('run-pacer-route', { type: 'geojson', data: routeGeoJson });
      // 이미 지나온 구간은 흐린 회색 선으로 (남은 길만 초록색으로 보이게)
      map.addSource('run-pacer-route-done', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } } });
      map.addLayer({
        id: 'run-pacer-route-done-line',
        type: 'line',
        source: 'run-pacer-route-done',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#8B98A3', 'line-width': 6, 'line-opacity': 0.35 },
      });
      // 은은한 네온 느낌을 위해 흐릿하고 굵은 "발광" 선을 먼저 깔고, 그 위에 선명한 선을 얹음
      map.addLayer({
        id: 'run-pacer-route-glow',
        type: 'line',
        source: 'run-pacer-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2BD97C', 'line-width': 22, 'line-blur': 3, 'line-opacity': 0.35 },
      });
      map.addLayer({
        id: 'run-pacer-route-line',
        type: 'line',
        source: 'run-pacer-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2BD97C', 'line-width': 9 },
      });

      // 진행 방향으로 행진하는 화살표(쉐브론) - 사진 속 AR 안내처럼 앞길을 표시
      map.addSource('run-pacer-chevrons', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'run-pacer-chevrons-glow',
        type: 'fill',
        source: 'run-pacer-chevrons',
        paint: { 'fill-color': '#FFB238', 'fill-opacity': 0.35 },
      });
      map.addLayer({
        id: 'run-pacer-chevrons-fill',
        type: 'fill',
        source: 'run-pacer-chevrons',
        paint: { 'fill-color': '#FFB238', 'fill-opacity': 0.95 },
      });
      routeReady = true;
      if (pendingProgress) {
        applyRouteProgress(pendingProgress.t, pendingProgress.cur);
        pendingProgress = null;
      }
    });

    // 누적 거리 기반으로 0~1 진행률을 실제 좌표로 보간
    const cumDist = [0];
    for (let i = 1; i < points.length; i++) {
      cumDist.push(cumDist[i - 1] + haversineMeters(points[i - 1], points[i]));
    }
    const total = cumDist[cumDist.length - 1] || 1;

    function distToCoord(target) {
      let i = 1;
      while (i < cumDist.length && cumDist[i] < target) i++;
      if (i >= cumDist.length) return { point: points[points.length - 1], bearing: initialBearing };
      const segStart = cumDist[i - 1];
      const segEnd = cumDist[i];
      const segT = segEnd > segStart ? (target - segStart) / (segEnd - segStart) : 0;
      const a = points[i - 1];
      const b = points[i];
      return {
        point: { lat: a.lat + (b.lat - a.lat) * segT, lng: a.lng + (b.lng - a.lng) * segT },
        bearing: computeBearing(a, b),
      };
    }

    function pointAtProgress(t) {
      return distToCoord(total * Math.min(Math.max(t, 0), 1)).point;
    }

    // 작은 화살표(쉐브론) 모양의 폴리곤을 특정 위치·방향으로 만듦 (이미지 로딩 없이 순수 도형으로)
    function makeChevron(center, bearingDeg, sizeMeters) {
      const half = sizeMeters / 2;
      const local = [
        [0, sizeMeters * 0.6],     // 앞 꼭짓점
        [half, -sizeMeters * 0.4], // 오른쪽 뒤
        [0, -sizeMeters * 0.1],    // 가운데 오목한 지점
        [-half, -sizeMeters * 0.4],// 왼쪽 뒤
      ];
      const coords = local.map(([x, y]) => {
        const rotated = RouteEngineDestFromLocal(center, bearingDeg, x, y);
        return [rotated.lng, rotated.lat];
      });
      coords.push(coords[0]);
      return coords;
    }

    function RouteEngineDestFromLocal(center, bearingDeg, xMeters, yMeters) {
      // xMeters: 오른쪽(+)/왼쪽(-), yMeters: 앞(+)/뒤(-) 방향 오프셋을 위경도로 변환
      const dist = Math.sqrt(xMeters * xMeters + yMeters * yMeters);
      if (dist === 0) return center;
      const localBearing = (Math.atan2(xMeters, yMeters) * 180) / Math.PI;
      return destinationPoint(center, (bearingDeg + localBearing + 360) % 360, dist);
    }

    // 진행률 기준 앞으로 120m까지, 15m 간격으로 화살표를 배치해서 지도 위 소스를 갱신
    function updateChevrons(progressT, mapInstance) {
      if (!mapInstance.getSource('run-pacer-chevrons')) return;
      const startDist = total * Math.min(Math.max(progressT, 0), 1);
      const features = [];
      for (let d = startDist + 14; d < Math.min(startDist + 130, total); d += 16) {
        const { point, bearing } = distToCoord(d);
        features.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [makeChevron(point, bearing, 3.4)] },
        });
      }
      mapInstance.getSource('run-pacer-chevrons').setData({ type: 'FeatureCollection', features });
    }

    // 진행률 t(0~1)에 맞춰 "남은 경로"만 초록 선으로 남기고, 지나온 구간은 흐리게 바꿈.
    // cur를 주면(경로에서 벗어난 경우) 내 실제 위치에서 경로로 돌아오는 안내선이 남은 경로 앞에 붙음
    function applyRouteProgress(t, cur) {
      const routeSrc = map.getSource('run-pacer-route');
      const doneSrc = map.getSource('run-pacer-route-done');
      if (!routeSrc || !doneSrc) return;
      const d0 = total * Math.min(Math.max(t, 0), 1);
      let i = 1;
      while (i < cumDist.length && cumDist[i] <= d0) i++;
      const head = distToCoord(d0).point;
      const remaining = [[head.lng, head.lat]].concat(points.slice(i).map((p) => [p.lng, p.lat]));
      const done = points.slice(0, i).map((p) => [p.lng, p.lat]).concat([[head.lng, head.lat]]);
      if (cur) remaining.unshift([cur.lng, cur.lat]);
      if (remaining.length < 2) remaining.push(remaining[0]); // 도착 직전에도 유효한 선 유지
      routeSrc.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: remaining } });
      doneSrc.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: done.length >= 2 ? done : [] } });
    }

    function updateRoute(t, cur) {
      if (!routeReady) { pendingProgress = { t, cur }; return; }
      applyRouteProgress(t, cur);
    }

    // 내 실제 GPS 위치(cur)가 경로의 어디쯤인지 찾음 - 경로 위 fromM~toM(미터) 구간 안에서만 찾아서
    // 갔다가 돌아오는 코스처럼 경로가 겹치는 곳에서 엉뚱한 쪽으로 붙는 걸 막음.
    // 반환: { along: 경로 시작부터의 거리(m), dist: 경로까지 수직 거리(m), point: 경로 위 가장 가까운 점 }
    function snapToRoute(cur, fromM, toM) {
      const mx = 111320 * Math.cos((cur.lat * Math.PI) / 180);
      const my = 110540;
      let best = null;
      for (let i = 1; i < points.length; i++) {
        if (cumDist[i] < fromM) continue;
        if (cumDist[i - 1] > toM) break;
        const a = points[i - 1];
        const b = points[i];
        const ax = (a.lng - cur.lng) * mx;
        const ay = (a.lat - cur.lat) * my;
        const dx = (b.lng - a.lng) * mx;
        const dy = (b.lat - a.lat) * my;
        const len2 = dx * dx + dy * dy;
        const s = len2 > 0 ? Math.min(Math.max(-(ax * dx + ay * dy) / len2, 0), 1) : 0;
        const px = ax + s * dx;
        const py = ay + s * dy;
        const dist = Math.sqrt(px * px + py * py);
        const along = cumDist[i - 1] + s * (cumDist[i] - cumDist[i - 1]);
        if (!best || dist < best.dist - 0.5 || (Math.abs(dist - best.dist) <= 0.5 && along < best.along)) {
          best = { dist, along, point: { lat: cur.lat + py / my, lng: cur.lng + px / mx } };
        }
      }
      return best;
    }

    return { map, pointAtProgress, initialBearing, updateChevrons, updateRoute, snapToRoute, totalMeters: total };
  }

  return {
    fetchWalkRoute, searchNearby, pickBestRoute, buildRouteToDestination, buildLoopRoute, buildDestinationRoute, refindRoute,
    renderOnMap, haversineMeters, computeBearing, destinationPoint, countCrosswalksNear,
  };
})();
