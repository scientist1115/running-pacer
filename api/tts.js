// 타입캐스트 TTS API 프록시 - 텍스트+voiceId를 받아서 mp3 오디오를 그대로 돌려줌
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 지원해요' });
  try {
    const { text, voiceId } = req.body || {};
    if (!text || !voiceId) return res.status(400).json({ error: 'text와 voiceId가 필요해요' });

    const apiKey = process.env.TYPECAST_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'TYPECAST_API_KEY가 설정되지 않았어요' });

    const ttsRes = await fetch('https://api.typecast.ai/v1/text-to-speech', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model: 'ssfm-v30',
        voice_id: voiceId,
        output: { audio_format: 'mp3' },
      }),
    });

    if (!ttsRes.ok) {
      const errText = await ttsRes.text().catch(() => '');
      console.warn('타입캐스트 TTS 실패:', ttsRes.status, errText);
      return res.status(502).json({ error: `타입캐스트 오류 (${ttsRes.status}): ${errText.slice(0, 200)}` });
    }

    const audioBuffer = await ttsRes.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.status(200).send(Buffer.from(audioBuffer));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
