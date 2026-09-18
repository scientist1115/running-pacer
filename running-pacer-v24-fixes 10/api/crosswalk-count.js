// 횡단보도 개수를 두 소스에서 같이 셈:
// (1) 전국횡단보도표준데이터(공공데이터포털) - 지자체가 직접 제출해야 들어가는 데이터라,
//     신도시나 작은 지자체는 아직 반영이 안 돼 있을 수 있음
// (2) OpenStreetMap(Overpass) - 커뮤니티가 직접 매핑해서 새 동네도 비교적 빨리 반영됨
// 둘 중 하나라도 "있다"고 하면 있는 걸로 판단해서, 정부 데이터의 지역 공백을 OSM으로 보완함
function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// 이 정부 API는 좌표/반경 검색을 지원하지 않고 시도명·시군구명 등 필드값 정확 일치(filterKey/filterValues)만
// 지원해서, 필터 없이 받으면 전국 데이터 중 앞쪽 numOfRows건만 오고 그 안에 경로 지역이 없으면 항상 0건이 됨.
// 그래서 카카오 좌표->행정구역 변환으로 경로 중간 지점의 시도/시군구를 먼저 알아내서 필터로 넘김.
async function getRegionFilter(points) {
  if (!process.env.KAKAO_REST_KEY || !points.length) return null;
  const mid = points[Math.floor(points.length / 2)];
  try {
    const url = new URL('https://dapi.kakao.com/v2/local/geo/coord2regioncode.json');
    url.searchParams.set('x', String(mid.lng));
    url.searchParams.set('y', String(mid.lat));
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_KEY}` },
    }, 3000);
    if (!res.ok) return null;
    const data = await res.json();
    const doc = (data.documents || []).find((d) => d.region_type === 'B') || (data.documents || [])[0];
    if (!doc) return null;
    return { sido: doc.region_1depth_name, sigungu: doc.region_2depth_name };
  } catch {
    return null;
  }
}

async function countGovCrosswalks(points, minLat, maxLat, minLng, maxLng) {
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

  function extractList(data) {
    const rows = data?.response?.body?.items?.item ?? data?.items ?? data?.data ?? [];
    return Array.isArray(rows) ? rows : rows ? [rows] : [];
  }

  const regionFilter = await getRegionFilter(points);
  let apiRes = await fetchWithTimeout(buildUrl(regionFilter), {}, 4000);
  let list = extractList(await apiRes.json());

  // 시군구명 표기 방식이 데이터셋마다 조금씩 달라서, 필터를 걸었는데도 결과가 통째로 비어 있으면
  // 필터 없이 한 번 더 시도 (기존 동작으로 폴백)
  if (regionFilter && list.length === 0) {
    apiRes = await fetchWithTimeout(buildUrl(null), {}, 4000);
    list = extractList(await apiRes.json());
  }

  let count = 0;
  for (const row of list) {
    const lat = parseFloat(row['위도'] ?? row.latitude ?? row.lat);
    const lng = parseFloat(row['경도'] ?? row.longitude ?? row.lng);
    if (!Number.isNaN(lat) && !Number.isNaN(lng) && lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng) {
      count++;
    }
  }
  return { count, checkedTotal: list.length };
}

async function countOsmCrosswalks(minLat, maxLat, minLng, maxLng) {
  // highway=crossing: OSM에서 보행자 횡단 지점(신호등 유무 상관없이)에 붙이는 표준 태그
  const query = `[out:json][timeout:15];node["highway"="crossing"](${minLat},${minLng},${maxLat},${maxLng});out tags;`;
  const overpassRes = await fetchWithTimeout('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: query,
  }, 4000);
  if (!overpassRes.ok) throw new Error('Overpass 응답 실패: ' + overpassRes.status);
  const data = await overpassRes.json();
  return (data.elements || []).length;
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

    const [govResult, osmResult] = await Promise.allSettled([
      countGovCrosswalks(points, minLat, maxLat, minLng, maxLng),
      countOsmCrosswalks(minLat, maxLat, minLng, maxLng),
    ]);

    const gov = govResult.status === 'fulfilled' ? govResult.value : null;
    const osm = osmResult.status === 'fulfilled' ? osmResult.value : null;
    if (govResult.status === 'rejected') console.warn('정부 횡단보도 API 실패:', govResult.reason?.message);
    if (osmResult.status === 'rejected') console.warn('OSM 횡단보도 조회 실패:', osmResult.reason?.message);

    // 하나라도 성공했으면 "확인됨"으로 취급하고, 둘 중 더 많이 찾은 쪽 숫자를 씀
    // (지역에 따라 한쪽 데이터가 비어있을 수 있어서, 더 신뢰할 만한 쪽/더 찾은 쪽을 우선)
    const ok = gov !== null || osm !== null;
    const govCount = gov?.count ?? 0;
    const osmCount = osm ?? 0;
    const count = Math.max(govCount, osmCount);

    res.status(200).json({
      count,
      ok,
      sources: { gov: gov ? govCount : null, osm: osm !== null ? osm : null },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
