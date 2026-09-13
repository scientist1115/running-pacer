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

    let data = await searchKakao(keyword, lat, lng, true);
    let documents = data.documents || [];

    // 반경 5km 안에서 못 찾았으면, 범위 제한 없이 이름으로 한 번 더 찾아봄
    // (이름이 정확한데 조금 멀리 있거나, radius+distance 정렬 조합에서 누락되는 경우 대비)
    if (documents.length === 0) {
      data = await searchKakao(keyword, lat, lng, false);
      documents = data.documents || [];
    }

    const results = documents.map((d) => ({
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
