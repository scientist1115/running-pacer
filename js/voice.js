// TTS로 안내하고, 마이크로 목적지/거리/노래 요청을 알아듣는 모듈
const Voice = (() => {
  let recognition = null;
  let listening = false;
  let onResultCallback = null;

  function speak(text, { interrupt = true } = {}) {
    if (interrupt) window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'ko-KR';
    utter.rate = 1.0;
    window.speechSynthesis.speak(utter);
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

  // "OO공원까지 3키로", "5키로 달릴래", "OO노래 틀어줘" 같은 문장을 대략 분류
  function parseCommand(text) {
    const musicMatch = text.match(/(.+?)\s*(노래|음악)\s*(틀어|재생)/);
    if (musicMatch) return { type: 'music', query: musicMatch[1].trim() };

    const distMatch = text.match(/(\d+(?:\.\d+)?)\s*(키로|킬로|km)/i);
    const distance = distMatch ? parseFloat(distMatch[1]) : null;

    // "까지"가 있으면 그 앞부분을 목적지로 취급
    const destMatch = text.match(/(.+?)까지/);
    const destination = destMatch ? destMatch[1].trim() : null;

    if (distance && destination) return { type: 'destination_with_distance', destination, distance };
    if (distance && !destination) return { type: 'distance_only', distance };
    if (destination && !distance) return { type: 'destination_only', destination };

    return { type: 'unknown', raw: text };
  }

  return { speak, listenOnce, parseCommand, get listening() { return listening; } };
})();
