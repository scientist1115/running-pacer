// 전국횡단보도표준데이터(공공데이터포털)로 경로 주변 횡단보도 개수를 셈
function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

// 이 API는 좌표/반경 검색을 지원하지 않고 시도명·시군구명 등 필드값 정확 일치(filterKey/filterValues)만
// 지원해서, 필터 없이 받으면 전국 데이터 중 앞쪽 numOfRows건만 오고 그 안에 경로 지역이 없으면 항상 0건이 됨.
// 그래서 카카오 좌표->행정구역 변환으로 경로 중간 지점의 시도/시군구를 먼저 알아내서 필터로 넘김.
async function fetchWithTimeoutAndHeaders(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function getRegionFilter(points) {
  if (!process.env.KAKAO_REST_KEY || !points.length) return null;
  const mid = points[Math.floor(points.length / 2)];
  try {
    const url = new URL('https://dapi.kakao.com/v2/local/geo/coord2regioncode.json');
    url.searchParams.set('x', String(mid.lng));
    url.searchParams.set('y', String(mid.lat));
    const res = await fetchWithTimeoutAndHeaders(url, {
      headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_KEY}` },
    }, 3000);
    if (!res.ok) return null;
    const data = await res.json();
    // region_type 'B'(법정동) 우선, 없으면 첫 결과 사용
    const doc = (data.documents || []).find((d) => d.region_type === 'B') || (data.documents || [])[0];
    if (!doc) return null;
    return { sido: doc.region_1depth_name, sigungu: doc.region_2depth_name };
  } catch {
    return null;
  }
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

    function buildUrl(regionFilter) {
      const u = new URL('https://api.data.go.kr/openapi/tn_pubr_public_crosswalk_api');
      u.searchParams.set('serviceKey', serviceKey);
      u.searchParams.set('type', 'json');
      u.searchParams.set('numOfRows', '1000');
      u.searchParams.set('pageNo', '1');
      if (regionFilter?.sido) {
        u.searchParams.append('filterKey', '시도명');
        u.searchParams.append('filterValues', regionFilter.sido);
      }
      if (regionFilter?.sigungu) {
        u.searchParams.append('filterKey', '시군구명');
        u.searchParams.append('filterValues', regionFilter.sigungu);
      }
      return u;
    }

    const regionFilter = await getRegionFilter(points);

    // 응답 구조가 문서와 다를 수 있어 여러 경로를 다 시도
    function extractList(data) {
      const rows = data?.response?.body?.items?.item ?? data?.items ?? data?.data ?? [];
      return Array.isArray(rows) ? rows : rows ? [rows] : [];
    }

    // 공공데이터포털 서버가 가끔 아주 느리거나 무응답이라, 4초 넘으면 그냥 0으로 처리
    let apiRes = await fetchWithTimeout(buildUrl(regionFilter), 4000);
    let list = extractList(await apiRes.json());

    // 시군구명 표기 방식이 데이터셋마다 조금씩 달라서(예: "성남시 분당구" vs 다른 표기),
    // 필터를 걸었는데도 결과가 통째로 비어 있으면 필터 없이 한 번 더 시도 (기존 동작으로 폴백)
    if (regionFilter && list.length === 0) {
      apiRes = await fetchWithTimeout(buildUrl(null), 4000);
      list = extractList(await apiRes.json());
    }

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
