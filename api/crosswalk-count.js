// 전국횡단보도표준데이터(공공데이터포털)로 경로 주변 횡단보도 개수를 셈
function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 지원해요' });
  try {
    const { points } = req.body || {};
    if (!points || !points.length) return res.status(400).json({ error: 'points가 필요해요' });

    const lats = points.map((p) => p.lat);
    const lngs = points.map((p) => p.lng);
    const minLat = Math.min(...lats) - 0.002;
    const maxLat = Math.max(...lats) + 0.002;
    const minLng = Math.min(...lngs) - 0.002;
    const maxLng = Math.max(...lngs) + 0.002;

    // 서비스키는 공공데이터포털에서 준 "Encoding" 형태 그대로 저장해두고,
    // 여기서 한 번 디코딩한 다음 URLSearchParams가 다시 인코딩하게 함 (이중 인코딩 방지)
    const serviceKey = decodeURIComponent(process.env.DATA_GO_KR_KEY || '');

    const url = new URL('https://api.data.go.kr/openapi/tn_pubr_public_crosswalk_api');
    url.searchParams.set('serviceKey', serviceKey);
    url.searchParams.set('type', 'json');
    url.searchParams.set('numOfRows', '1000');
    url.searchParams.set('pageNo', '1');

    // 공공데이터포털 서버가 가끔 아주 느리거나 무응답이라, 4초 넘으면 그냥 0으로 처리
    const apiRes = await fetchWithTimeout(url, 4000);
    const data = await apiRes.json();

    // 응답 구조가 문서와 다를 수 있어 여러 경로를 다 시도
    const rows =
      data?.response?.body?.items?.item ??
      data?.items ??
      data?.data ??
      [];
    const list = Array.isArray(rows) ? rows : rows ? [rows] : [];

    let count = 0;
    for (const row of list) {
      const lat = parseFloat(row['위도'] ?? row.latitude ?? row.lat);
      const lng = parseFloat(row['경도'] ?? row.longitude ?? row.lng);
      if (
        !Number.isNaN(lat) &&
        !Number.isNaN(lng) &&
        lat >= minLat &&
        lat <= maxLat &&
        lng >= minLng &&
        lng <= maxLng
      ) {
        count++;
      }
    }

    res.status(200).json({ count, checkedTotal: list.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
