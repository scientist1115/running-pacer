// Tmap 보행자 경로 API를 프록시해서 CORS 우회 + appKey 숨김 (Vercel 서버리스 함수)
//
// 응답에 crosswalks(이 경로가 실제로 건너는 횡단보도 위치들)도 같이 돌려줌:
//  - 경로 구간(LineString)의 facilityType 15 = 횡단보도
//  - 안내 지점(Point)의 turnType 211~217 = 횡단보도 (좌/우측, 8·10·2·4시 방향 포함)
// 티맵은 경로를 직접 계산하는 쪽이라, 지자체 자료나 OSM에 빠진 횡단보도도 이걸로 잡을 수 있음.

function distM(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function extractCrosswalks(features) {
  const groups = []; // 횡단보도 하나 = { coords: [[lng,lat],...] }
  let prevWasCrossing = false;
  for (const f of features) {
    if (f.geometry?.type !== 'LineString') continue;
    const isCrossing = Number(f.properties?.facilityType) === 15;
    if (isCrossing) {
      // 연속된 횡단보도 구간은 하나의 횡단보도로 봄 (긴 횡단보도가 여러 조각으로 올 수 있어서)
      if (prevWasCrossing && groups.length) groups[groups.length - 1].coords.push(...f.geometry.coordinates);
      else groups.push({ coords: [...f.geometry.coordinates] });
    }
    prevWasCrossing = isCrossing;
  }
  const result = groups.map((g) => {
    const [lng, lat] = g.coords[Math.floor(g.coords.length / 2)];
    return { lat, lng, first: { lat: g.coords[0][1], lng: g.coords[0][0] } };
  });

  // 안내 지점 중 횡단보도(211~217): 이미 구간으로 잡은 것과 25m 안이면 같은 횡단보도로 봄
  for (const f of features) {
    if (f.geometry?.type !== 'Point') continue;
    const t = Number(f.properties?.turnType);
    if (!(t >= 211 && t <= 217)) continue;
    const [lng, lat] = f.geometry.coordinates;
    const p = { lat, lng };
    const dup = result.some((r) => distM(r, p) <= 25 || distM(r.first, p) <= 25);
    if (!dup) result.push({ lat, lng, first: p });
  }
  return result.map(({ lat, lng }) => ({ lat, lng }));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 지원해요' });
  }
  try {
    const { start, end } = req.body || {};
    if (!start || !end) {
      return res.status(400).json({ error: 'start, end 좌표가 필요해요' });
    }

    const tmapRes = await fetch('https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        appKey: process.env.TMAP_APP_KEY,
      },
      body: JSON.stringify({
        startX: start.lng, startY: start.lat,
        endX: end.lng, endY: end.lat,
        startName: '출발', endName: '도착',
      }),
    });
    const data = await tmapRes.json();

    const points = [];
    const turns = [];
    for (const f of data.features || []) {
      if (f.geometry.type === 'LineString') {
        for (const [lng, lat] of f.geometry.coordinates) points.push({ lat, lng });
      }
      if (f.geometry.type === 'Point' && f.properties?.turnType) {
        const [lng, lat] = f.geometry.coordinates;
        turns.push({ type: f.properties.turnType, description: f.properties.description, lat, lng });
      }
    }
    const distanceMeters = data.features?.[0]?.properties?.totalDistance || 0;
    const crosswalks = extractCrosswalks(data.features || []);

    res.status(200).json({ points, distanceMeters, turns, crosswalks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
