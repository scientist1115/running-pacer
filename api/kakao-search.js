// 카카오 로컬 키워드 검색 프록시 - 장소명/공원 검색용 (Vercel 서버리스 함수)
async function searchKakao(keyword, lat, lng, useRadius) {
  const url = new URL('https://dapi.kakao.com/v2/local/search/keyword.json');
  url.searchParams.set('query', keyword);
  if (lat && lng) {
    url.searchParams.set('x', lng);
    url.searchParams.set('y', lat);
    if (useRadius) {
      url.searchParams.set('radius', '5000');
      url.searchParams.set('sort', 'distance');
    }
  }
  const kakaoRes = await fetch(url, {
    headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_KEY}` },
  });
  return kakaoRes.json();
}

// 지하철역 카테고리(SW8)로 직접 검색 - "OO역"처럼 역 이름을 말했을 때, 이름에 "역"이 들어간
// 무관한 업체(미용실 등)가 걸리지 않도록 진짜 지하철역 데이터 안에서만 찾음
async function searchKakaoStationCategory(lat, lng) {
  const url = new URL('https://dapi.kakao.com/v2/local/search/category.json');
  url.searchParams.set('category_group_code', 'SW8');
  if (lat && lng) {
    url.searchParams.set('x', lng);
    url.searchParams.set('y', lat);
    url.searchParams.set('radius', '20000'); // 역은 5km보다 멀리 있을 수 있어서 넉넉히 20km
    url.searchParams.set('sort', 'distance');
  }
  const kakaoRes = await fetch(url, {
    headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_KEY}` },
  });
  return kakaoRes.json();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 지원해요' });
  }
  try {
    const { keyword, lat, lng } = req.body || {};
    if (!keyword) return res.status(400).json({ error: 'keyword가 필요해요' });
    const trimmedKeyword = keyword.trim();
    const looksLikeStation = /역$/.test(trimmedKeyword);

    // 세 방식을 같이 시도함:
    // (1) 반경 5km + 거리순 - "근처 공원"처럼 가까운 곳 여러 개를 후보로 쓸 때 적합
    // (2) 범위 제한 없는 검색 - 지명이 정확한데 5km보다 멀리 있을 수도 있는 경우 대비
    // (3) "OO역"이면 지하철역 카테고리 검색도 추가 - 이름에 "역"만 들어간 무관한 업체가
    //     일반 검색에서 먼저 걸리는 걸 막고, 진짜 역 데이터 안에서 찾음
    const [radiusData, plainData, stationData] = await Promise.all([
      searchKakao(trimmedKeyword, lat, lng, true),
      searchKakao(trimmedKeyword, lat, lng, false),
      looksLikeStation ? searchKakaoStationCategory(lat, lng).catch(() => ({ documents: [] })) : Promise.resolve({ documents: [] }),
    ]);
    const radiusDocs = radiusData.documents || [];
    const plainDocs = plainData.documents || [];
    const stationDocs = stationData.documents || [];

    // 이름이 완전히 같은 곳(공백 무시)이 있으면 거리와 상관없이 그게 진짜 목적지일 확률이 높음.
    // 역 이름이면 지하철역 카테고리에서 가장 먼저 찾고, 그다음 카카오 관련도 순, 그다음 반경 결과
    const normalize = (s) => (s || '').replace(/\s/g, '').toLowerCase();
    const target = normalize(trimmedKeyword);
    const findExact = (list) => list.find((d) => normalize(d.place_name) === target);
    const exact = findExact(stationDocs) || findExact(plainDocs) || findExact(radiusDocs);

    // 정확히 일치하는 곳이 있으면 그것만, 없으면: 역 카테고리 결과 > 반경 결과 > 범위 무제한 결과
    const ordered = exact
      ? [exact]
      : (stationDocs.length ? stationDocs : (radiusDocs.length ? radiusDocs : plainDocs));
    const results = ordered.map((d) => ({
      name: d.place_name,
      lat: parseFloat(d.y),
      lng: parseFloat(d.x),
      address: d.road_address_name || d.address_name,
    }));

    res.status(200).json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
