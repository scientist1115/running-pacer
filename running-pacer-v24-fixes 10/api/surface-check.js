// OpenStreetMap Overpass API로 경로 주변 도로의 surface 태그를 확인 (무료, 키 불필요)
function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 지원해요' });
  try {
    const { points } = req.body || {};
    if (!points || !points.length) return res.status(400).json({ error: 'points가 필요해요' });

    const lats = points.map((p) => p.lat);
    const lngs = points.map((p) => p.lng);
    const south = Math.min(...lats) - 0.002;
    const north = Math.max(...lats) + 0.002;
    const west = Math.min(...lngs) - 0.002;
    const east = Math.max(...lngs) + 0.002;

    const query = `[out:json][timeout:15];way["highway"](${south},${west},${north},${east});out tags;`;

    // Overpass 공용 서버는 혼잡할 때 매우 느릴 수 있어서, 4초 넘으면 그냥 0으로 처리
    const overpassRes = await fetchWithTimeout('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: query,
    }, 4000);
    const data = await overpassRes.json();

    // 러너가 피하고 싶을 만한 노면 재질
    const badSurfaces = ['sand', 'dirt', 'gravel', 'ground', 'mud', 'unpaved', 'grass', 'pebblestone', 'earth', 'fine_gravel'];

    let badCount = 0;
    let taggedTotal = 0;
    for (const el of data.elements || []) {
      const surface = el.tags?.surface;
      if (surface) {
        taggedTotal++;
        if (badSurfaces.includes(surface)) badCount++;
      }
    }

    res.status(200).json({ badSurfaceCount: badCount, taggedTotal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
