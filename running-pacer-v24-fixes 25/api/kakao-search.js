// 카카오 로컬 키워드 검색 프록시 - 장소명/공원 검색용 (Vercel 서버리스 함수)
async function searchKakao(keyword, lat, lng, opts) {
  const url = new URL('https://dapi.kakao.com/v2/local/search/keyword.json');
  url.searchParams.set('query', keyword);
  if (opts?.page) url.searchParams.set('page', String(opts.page));
  if (lat && lng) {
    url.searchParams.set('x', lng);
    url.searchParams.set('y', lat);
    if (opts?.useRadius) {
      url.searchParams.set('radius', '5000');
      url.searchParams.set('sort', 'distance');
    }
  }
  const kakaoRes = await fetch(url, {
    headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_KEY}` },
  });
  return kakaoRes.json();
}

// 지하철역 카테고리(SW8) 중 가장 가까운 것 - 이름 매칭이 전부 실패했을 때 최후의 대안으로만 씀
// (이 API는 이름으로 검색하는 기능이 없어서, "그나마 가장 가까운 역"만 알려줄 수 있음)
async function searchKakaoStationCategory(lat, lng) {
  const url = new URL('https://dapi.kakao.com/v2/local/search/category.json');
  url.searchParams.set('category_group_code', 'SW8');
  if (lat && lng) {
    url.searchParams.set('x', lng);
    url.searchParams.set('y', lat);
    url.searchParams.set('radius', '20000');
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

    // 이름 검색은 반경 5km(1,2페이지)+범위 무제한(1,2페이지)까지 넉넉히 긁어모음 -
    // 역 이름은 비슷한 이름의 업체가 많아서 한 페이지(15개) 안에 진짜 역이 없을 수 있음
    const [r1, r2, p1, p2] = await Promise.all([
      searchKakao(trimmedKeyword, lat, lng, { useRadius: true, page: 1 }),
      looksLikeStation ? searchKakao(trimmedKeyword, lat, lng, { useRadius: true, page: 2 }) : Promise.resolve({ documents: [] }),
      searchKakao(trimmedKeyword, lat, lng, { useRadius: false, page: 1 }),
      looksLikeStation ? searchKakao(trimmedKeyword, lat, lng, { useRadius: false, page: 2 }) : Promise.resolve({ documents: [] }),
    ]);
    const allDocs = [...(r1.documents || []), ...(r2.documents || []), ...(p1.documents || []), ...(p2.documents || [])];
    const radiusDocs = r1.documents || [];
    const plainDocs = p1.documents || [];

    const normalize = (s) => (s || '').replace(/\s/g, '').toLowerCase();
    const target = normalize(trimmedKeyword);
    const findExact = (list) => list.find((d) => normalize(d.place_name) === target);

    let exact = findExact(allDocs);

    // "OO역"인데 정확히 일치하는 게 없으면: 이름 검색 결과 중 "지하철역" 카테고리인 것만 걸러서
    // (미용실처럼 이름만 비슷한 무관한 업체 제외) 그 안에서 한 번 더 느슨하게(포함 관계로) 찾아봄
    let stationFallback = null;
    if (!exact && looksLikeStation) {
      const stationOnly = allDocs.filter((d) => d.category_group_code === 'SW8');
      exact = stationOnly.find((d) => {
        const n = normalize(d.place_name);
        return n.includes(target) || target.includes(n);
      });
      if (!exact) {
        // 그래도 없으면, 그나마 가장 가까운 지하철역이라도 (완전히 다른 역일 수 있어서 최후의 수단)
        const nearest = await searchKakaoStationCategory(lat, lng).catch(() => ({ documents: [] }));
        stationFallback = (nearest.documents || [])[0] || null;
      }
    }

    const ordered = exact ? [exact] : (stationFallback ? [stationFallback] : (radiusDocs.length ? radiusDocs : plainDocs));
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
