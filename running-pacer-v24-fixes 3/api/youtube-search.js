// 유튜브 데이터 API v3로 검색 (Vercel 서버리스 함수)
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 지원해요' });
  try {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'query가 필요해요' });

    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('q', query);
    url.searchParams.set('type', 'video');
    url.searchParams.set('maxResults', '8');
    url.searchParams.set('key', process.env.YOUTUBE_API_KEY);

    const ytRes = await fetch(url);
    const data = await ytRes.json();

    if (data.error) return res.status(500).json({ error: data.error.message });

    const results = (data.items || []).map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
    }));

    res.status(200).json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
