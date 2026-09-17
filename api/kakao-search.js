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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 지원해요' });
  }
  try {
    const { keyword, lat, lng } = req.body || {};
    if (!keyword) return res.status(400).json({ error: 'keyword가 필요해요' });

    // 두 방식을 항상 같이 시도함:
    // (1) 반경 5km + 거리순 - "근처 공원"처럼 가까운 곳 여러 개를 후보로 쓸 때 적합
    // (2) 범위 제한 없는 검색 - "과천역"처럼 지명이 정확한데 5km보다 멀리 있을 수도 있는 경우 대비.
    //     반경 검색만 쓰면, 진짜 목적지는 반경 밖이라 못 찾고 이름만 비슷한 더 가까운 엉뚱한 곳이
    //     대신 걸려버리는 문제가 있었음.
    const [radiusData, plainData] = await Promise.all([
      searchKakao(keyword, lat, lng, true),
      searchKakao(keyword, lat, lng, false),
    ]);
    const radiusDocs = radiusData.documents || [];
    const plainDocs = plainData.documents || [];

    // 이름이 완전히 같은 곳(공백 무시)이 있으면 거리와 상관없이 그게 진짜 목적지일 확률이 높음.
    // 카카오 자체 관련도 순인 plainDocs에서 먼저 찾고, 없으면 반경 결과에서도 찾아봄
    const normalize = (s) => (s || '').replace(/\s/g, '').toLowerCase();
    const target = normalize(keyword);
    const findExact = (list) => list.find((d) => normalize(d.place_name) === target);
    const exact = findExact(plainDocs) || findExact(radiusDocs);

    // 정확히 일치하는 곳이 있으면 그것만, 없으면 기존처럼 가까운 순(반경 결과 우선, 없으면 범위 무제한)
    const ordered = exact ? [exact] : (radiusDocs.length ? radiusDocs : plainDocs);
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
