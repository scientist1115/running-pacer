// TTS로 안내하고, 마이크로 목적지/거리/노래 요청을 알아듣는 모듈
const Voice = (() => {
  let recognition = null;
  let listening = false;
  let onResultCallback = null;
  let comedyMode = false;
  let currentAudio = null;

  // 타입캐스트 캐릭터 보이스 - voice_id는 studio.typecast.ai/developers/api/voices 에서 확인해서 채워넣기
  const TYPECAST_VOICES = {
    yongsik: { label: '용식이', voiceId: 'tc_5feb2085cca1a479e73bac37' },
    gwakdupil: { label: '곽두필', voiceId: 'tc_606c6c684085209e5555abb0' },
    valkyrie: { label: '발키리', voiceId: 'tc_60478557f12456064b353409' },
    hajun: { label: '하준이', voiceId: 'tc_60db308484130840f23e6ca0' },
  };
  let selectedVoiceKey = null; // null이면 브라우저 기본 TTS

  function getVoiceOptions() {
    return Object.entries(TYPECAST_VOICES).map(([key, v]) => ({ key, label: v.label }));
  }

  function setVoiceKey(key) {
    selectedVoiceKey = (key && TYPECAST_VOICES[key] && TYPECAST_VOICES[key].voiceId) ? key : null;
  }

  // 웃긴 모드일 때 문구 앞/뒤에 붙이는 구수한 아저씨 톤 추임새 - 랜덤으로 하나씩 골라서 매번 다르게 들리게 함
  const COMEDY_PREFIXES = ['아이고!', '어허, 이 사람아!', '캬~', '야야!', '어이쿠!', '자, 이거 봐라!', '거참!'];
  const COMEDY_SUFFIXES = ['그렇다니까!', '알았지?', '거 봐라!', '됐고, 가자!', '아무튼 그렇다고!'];

  function comedify(text) {
    const prefix = COMEDY_PREFIXES[Math.floor(Math.random() * COMEDY_PREFIXES.length)];
    const suffix = COMEDY_SUFFIXES[Math.floor(Math.random() * COMEDY_SUFFIXES.length)];
    return `${prefix} ${text} ${suffix}`;
  }

  function setComedyMode(on) {
    comedyMode = !!on;
  }

  function speakBrowser(text) {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'ko-KR';
    // 참고: iOS Safari는 pitch(음높이) 조절을 대체로 무시해서(애플 쪽 제약, 코드로 못 고침),
    // rate(속도) 변화폭을 더 크게 줘서 그나마 확실히 느껴지게 하고, 문구 추임새(comedify)가
    // 플랫폼과 무관하게 항상 작동하니 "웃긴 느낌"의 주된 수단이 되도록 함
    utter.rate = comedyMode ? 0.85 : 1.0;
    utter.pitch = comedyMode ? 0.7 : 1.0;
    window.speechSynthesis.speak(utter);
  }

  async function speak(text, { interrupt = true } = {}) {
    const finalText = comedyMode ? comedify(text) : text;

    if (selectedVoiceKey) {
      const voiceId = TYPECAST_VOICES[selectedVoiceKey].voiceId;
      try {
        if (interrupt && currentAudio) { currentAudio.pause(); currentAudio = null; }
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: finalText, voiceId }),
        });
        if (!res.ok) throw new Error('TTS 요청 실패');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        currentAudio = new Audio(url);
        currentAudio.play();
        return;
      } catch (e) {
        console.warn('캐릭터 보이스 실패, 기본 음성으로 대체:', e.message);
        // 아래로 흘러가서 브라우저 기본 음성으로 폴백
      }
    }

    if (interrupt) window.speechSynthesis.cancel();
    speakBrowser(finalText);
  }

  function initRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { console.warn('이 브라우저는 음성인식을 지원하지 않아요'); return; }
    recognition = new SR();
    recognition.lang = 'ko-KR';
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      if (onResultCallback) onResultCallback(transcript);
    };
    recognition.onend = () => { listening = false; document.getElementById('mic-btn')?.classList.remove('listening'); };
    recognition.onerror = () => { listening = false; document.getElementById('mic-btn')?.classList.remove('listening'); };
  }

  function listenOnce(callback) {
    if (!recognition) initRecognition();
    if (!recognition) return;
    onResultCallback = callback;
    listening = true;
    document.getElementById('mic-btn')?.classList.add('listening');
    recognition.start();
  }

  // "OO공원까지 3키로", "서호공원 갈래", "5키로 달릴래", "OO노래 틀어줘" 같은 문장을 대략 분류
  function parseCommand(text) {
    const musicMatch = text.match(/(.+?)\s*(노래|음악)\s*(틀어|재생)/);
    if (musicMatch) return { type: 'music', query: musicMatch[1].trim() };

    const distMatch = text.match(/(\d+(?:\.\d+)?)\s*(키로|킬로|km)/i);
    const distance = distMatch ? parseFloat(distMatch[1]) : null;

    // 목적지 표현을 여러 패턴으로 시도: "OO까지" -> "OO(으)로 갈래/가자" -> 그 외엔 동사만 떼어냄
    let destination = null;
    let destMatch = text.match(/(.+?)까지/);
    if (destMatch) {
      destination = destMatch[1].trim();
    } else {
      destMatch = text.match(/(.+?)(?:으로|로)\s*(?:갈래|갈까|가자|가고\s*싶어?|뛸래|뛰고\s*싶어?)/);
      if (destMatch) destination = destMatch[1].trim();
    }

    // 그래도 못 찾았으면, 거리 표현이나 끝에 붙는 동사를 떼어내고 남는 걸 목적지 후보로 취급
    // (예: "서호공원 갈래", "한강공원" 처럼 짧게 말한 경우)
    if (!destination) {
      let cleaned = text
        .replace(/(\d+(?:\.\d+)?)\s*(키로|킬로|km)/i, '')
        .replace(/(갈래|갈까|가자|가고\s*싶어?|뛸래|뛰고\s*싶어?|줄래|해줘|까지)\s*$/, '')
        .trim();
      if (cleaned && !distance) destination = cleaned; // 거리만 말한 경우엔 후보로 쓰지 않음
    }

    if (distance && destination) return { type: 'destination_with_distance', destination, distance };
    if (distance && !destination) return { type: 'distance_only', distance };
    if (destination && !distance) return { type: 'destination_only', destination };

    return { type: 'unknown', raw: text };
  }

  return {
    speak, listenOnce, parseCommand, setComedyMode, setVoiceKey, getVoiceOptions,
    get listening() { return listening; },
  };
})();
