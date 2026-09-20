// 러닝 경로 위 특정 지점 근처의 가게·건물 이름을 찾아주는 프록시 (카카오 로컬 API, Vercel 서버리스 함수)
// 러닝 종료 후 "OO 근처에서 속도가 점점 느려졌어요" 같은 설명을 만들 때 씀.
// 요청: POST { points: [{ lat, lng }, ...] }  (최대 6개)
// 응답: { places: [ { name, category, distance } | null, ... ] }  - points와 같은 순서
// 환경변수: KAKAO_REST_KEY (kakao-search.js와 같은 키)

// [카테고리 코드, 화면에 보여줄 이름] - 러닝 중 사람이 몰리거나 멈추기 쉬운 곳 위주
const CATEGORIES = [
  ['CS2', '편의점'],
  ['CE7', '카페'],
  ['FD6', '음식점'],
  ['MT1', '마트'],
  ['SW8', '지하철역'],
  ['BK9', '은행'],
  ['PM9', '약국'],
  ['SC4', '학교'],
  ['HP8', '병원'],
  ['CT1', '문화시설'],
  ['AT4', '관광명소'],
  ['OL7', '주유소'],
  ['PK6', '주차장'],
];
const SEARCH_RADIUS_M = 70; // 이 반경 안에서 가장 가까운 곳만 찾음

async function kakaoGet(path, params) {
  const url = new URL(`https://dapi.kakao.com/v2/local/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url, { headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_KEY}` } });
  if (!res.ok) return { documents: [] };
  return res.json();
}

async function nearestPlace(lat, lng) {
  const [byCategory, addr] = await Promise.all([
    Promise.all(CATEGORIES.map(([code, label]) =>
      kakaoGet('search/category.json', {
        category_group_code: code, x: lng, y: lat, radius: SEARCH_RADIUS_M, sort: 'distance', size: 1,
      })
        .then((json) => (json.documents || []).map((d) => ({
          name: d.place_name, category: label, distance: Number(d.distance) || 0,
        })))
        .catch(() => [])
    )),
    kakaoGet('geo/coord2address.json', { x: lng, y: lat }).catch(() => ({ documents: [] })),
  ]);

  const candidates = byCategory.flat().sort((a, b) => a.distance - b.distance);
  if (candidates.length) return candidates[0];

  // 가게가 없으면 그 자리의 건물 이름이라도 (도로명주소에 건물명이 있을 때만)
  const building = (addr.documents || [])[0]?.road_address?.building_name;
  if (building) return { name: building, category: '건물', distance: 0 };
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 지원해요' });
  }
  try {
    const raw = Array.isArray(req.body?.points) ? req.body.points.slice(0, 6) : [];
    const points = raw.map((p) => ({ lat: Number(p?.lat), lng: Number(p?.lng) }));
    if (!points.length || points.some((p) => !isFinite(p.lat) || !isFinite(p.lng))) {
      return res.status(400).json({ error: 'points([{lat,lng}])가 필요해요' });
    }
    // 카카오 요청이 한꺼번에 몰리지 않게 지점은 순서대로, 카테고리는 지점 안에서만 병렬로 조회
    const places = [];
    for (const p of points) {
      places.push(await nearestPlace(p.lat, p.lng).catch(() => null));
    }
    res.status(200).json({ places });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
