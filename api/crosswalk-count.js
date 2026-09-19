// 지정한 범위(bbox) 안의 횡단보도 좌표 목록을 두 소스에서 모아서 돌려줌:
// (1) 전국횡단보도표준데이터(공공데이터포털) - 지자체가 직접 제출해야 들어가는 데이터라,
//     신도시나 작은 지자체는 아직 반영이 안 돼 있을 수 있음
// (2) OpenStreetMap(Overpass) - 커뮤니티가 직접 매핑해서 새 동네도 비교적 빨리 반영됨
// 좌표 목록으로 돌려주는 이유: 경로 후보가 여러 개(최대 9개)일 때, 후보마다 따로 조회하면
// 외부 API(특히 무료 공개 Overpass)를 짧은 시간에 여러 번 두드리게 돼서 요청 제한(429)에 걸림.
// 그래서 호출하는 쪽(route.js)에서 후보 전체를 합친 넓은 범위로 한 번만 조회하고,
// 그 좌표 목록을 갖고 후보별로 몇 개가 걸리는지는 코드 안에서 계산함.
function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// 이 정부 API는 좌표/반경 검색을 지원하지 않고 시도명·시군구명 등 필드값 정확 일치(filterKey/filterValues)만
// 지원해서, 필터 없이 받으면 전국 데이터 중 앞쪽 numOfRows건만 오고 그 안에 요청 지역이 없으면 항상 0건이 됨.
// 그래서 카카오 좌표->행정구역 변환으로 범위 중심의 시도/시군구를 먼저 알아내서 필터로 넘김.
async function getRegionFilter(centerLat, centerLng) {
  if (!process.env.KAKAO_REST_KEY) return null;
  try {
    const url = new URL('https://dapi.kakao.com/v2/local/geo/coord2regioncode.json');
    url.searchParams.set('x', String(centerLng));
    url.searchParams.set('y', String(centerLat));
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

// 정부 데이터에서 bbox 안의 횡단보도 좌표들을 뽑아서 [{lat,lng}, ...]로 돌려줌
async function fetchGovCrosswalks(minLat, maxLat, minLng, maxLng) {
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

  const regionFilter = await getRegionFilter((minLat + maxLat) / 2, (minLng + maxLng) / 2);
  // 필터 버전과 무필터 버전을 순서대로 시도하면 최악의 경우 거의 8초까지 걸릴 수 있어서,
  // 지역필터가 있으면 두 요청을 동시에 보내고 필터 결과가 비어있을 때만 무필터 결과로 대체함
  const [filteredRes, fallbackRes] = await Promise.all([
    fetchWithTimeout(buildUrl(regionFilter), {}, 4000).then((r) => r.json()).catch(() => null),
    regionFilter ? fetchWithTimeout(buildUrl(null), {}, 4000).then((r) => r.json()).catch(() => null) : Promise.resolve(null),
  ]);
  let list = filteredRes ? extractList(filteredRes) : [];
  if (regionFilter && list.length === 0 && fallbackRes) {
    list = extractList(fallbackRes);
  }

  const points = [];
  for (const row of list) {
    const lat = parseFloat(row['위도'] ?? row.latitude ?? row.lat);
    const lng = parseFloat(row['경도'] ?? row.longitude ?? row.lng);
    if (!Number.isNaN(lat) && !Number.isNaN(lng) && lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng) {
      points.push({ lat, lng });
    }
  }
  return points;
}

// OSM에서 bbox 안의 횡단보도 좌표들을 뽑아서 [{lat,lng}, ...]로 돌려줌
async function fetchOsmCrosswalks(minLat, maxLat, minLng, maxLng) {
  // highway=crossing: OSM에서 보행자 횡단 지점(신호등 유무 상관없이)에 붙이는 표준 태그
  const query = `[out:json][timeout:20];node["highway"="crossing"](${minLat},${minLng},${maxLat},${maxLng});out tags;`;

  async function tryEndpoint(url) {
    const overpassRes = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: query,
    }, 6000);
    if (!overpassRes.ok) throw new Error(`Overpass 응답 실패(${url}): ${overpassRes.status}`);
    const data = await overpassRes.json();
    return (data.elements || []).map((el) => ({ lat: el.lat, lng: el.lon }));
  }

  // overpass-api.de(공식 서버)가 최근 널리 보고된 406/429 오류를 자주 내고 있어서 대체 서버도 같이 시도함.
  // 순서대로 하면 둘 다 실패할 때 시간이 두 배로 걸려서, 동시에 보내고 먼저 성공하는 쪽을 씀
  const results = await Promise.allSettled([
    tryEndpoint('https://overpass.private.coffee/api/interpreter'),
    tryEndpoint('https://overpass-api.de/api/interpreter'),
  ]);
  const success = results.find((r) => r.status === 'fulfilled');
  if (success) return success.value;
  const reasons = results.map((r) => r.reason?.message).filter(Boolean).join(' / ');
  throw new Error(reasons || 'Overpass 서버들에 모두 접속하지 못했어요');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 지원해요' });
  try {
    const { minLat, maxLat, minLng, maxLng } = req.body || {};
    if ([minLat, maxLat, minLng, maxLng].some((v) => typeof v !== 'number')) {
      return res.status(400).json({ error: 'minLat/maxLat/minLng/maxLng가 필요해요' });
    }

    const [govResult, osmResult] = await Promise.allSettled([
      fetchGovCrosswalks(minLat, maxLat, minLng, maxLng),
      fetchOsmCrosswalks(minLat, maxLat, minLng, maxLng),
    ]);

    const gov = govResult.status === 'fulfilled' ? govResult.value : null;
    const osm = osmResult.status === 'fulfilled' ? osmResult.value : null;
    const govError = govResult.status === 'rejected' ? govResult.reason?.message : null;
    const osmError = osmResult.status === 'rejected' ? osmResult.reason?.message : null;
    if (govError) console.warn('정부 횡단보도 API 실패:', govError);
    if (osmError) console.warn('OSM 횡단보도 조회 실패:', osmError);

    const ok = gov !== null || osm !== null;
    const points = [...(gov || []), ...(osm || [])];

    res.status(200).json({
      points,
      ok,
      sources: { gov: gov ? gov.length : null, osm: osm ? osm.length : null },
      errors: { gov: govError, osm: osmError },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
