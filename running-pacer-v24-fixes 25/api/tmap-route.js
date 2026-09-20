// Tmap 보행자 경로 API를 프록시해서 CORS 우회 + appKey 숨김 (Vercel 서버리스 함수)
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

    res.status(200).json({ points, distanceMeters, turns });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
