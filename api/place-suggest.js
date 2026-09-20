// 목적지 자동완성용 - 카카오 로컬 키워드 검색으로 "관련 검색어에 뜨는 장소" 후보 여러 개를 돌려줌 (Vercel 서버리스 함수)
// 요청: POST { keyword, lat?, lng? }   (lat/lng는 내 위치 - 있으면 가까운 곳이 위로 옴)
// 응답: { places: [ { name, address, category, lat, lng, distance } ] }  (최대 10개)
// 환경변수: KAKAO_REST_KEY (kakao-search.js와 같은 키)
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 지원해요' });
  try {
    const { keyword, lat, lng } = req.body || {};
    const q = String(keyword || '').trim();
    if (q.length < 1) return res.status(200).json({ places: [] });

    const url = new URL('https://dapi.kakao.com/v2/local/search/keyword.json');
    url.searchParams.set('query', q);
    url.searchParams.set('size', '10');
    if (typeof lat === 'number' && typeof lng === 'number') {
      url.searchParams.set('x', String(lng));
      url.searchParams.set('y', String(lat));
    }
    const kakaoRes = await fetch(url, { headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_KEY}` } });
    if (!kakaoRes.ok) return res.status(502).json({ error: `카카오 검색 실패(${kakaoRes.status})` });
    const data = await kakaoRes.json();
    const places = (data.documents || []).map((d) => ({
      name: d.place_name,
      address: d.road_address_name || d.address_name || '',
      category: (d.category_name || '').split(' > ').slice(-1)[0] || '',
      lat: parseFloat(d.y),
      lng: parseFloat(d.x),
      distance: d.distance ? Number(d.distance) : null, // x,y를 줬을 때만 (m)
    })).filter((p) => isFinite(p.lat) && isFinite(p.lng));
    res.status(200).json({ places });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
