// 카카오 로컬 키워드 검색 프록시 - 장소명/공원 검색용 (Vercel 서버리스 함수)
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 지원해요' });
  }
  try {
    const { keyword, lat, lng } = req.body || {};
    if (!keyword) return res.status(400).json({ error: 'keyword가 필요해요' });

    const url = new URL('https://dapi.kakao.com/v2/local/search/keyword.json');
    url.searchParams.set('query', keyword);
    if (lat && lng) {
      url.searchParams.set('x', lng);
      url.searchParams.set('y', lat);
      url.searchParams.set('radius', '5000');
      url.searchParams.set('sort', 'distance');
    }

    const kakaoRes = await fetch(url, {
      headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_KEY}` },
    });
    const data = await kakaoRes.json();

    const results = (data.documents || []).map((d) => ({
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
