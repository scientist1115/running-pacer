// 노래를 기기에 저장(로컬/유튜브/Spotify)해두고, 뛰기 시작하면 자동재생
const Music = (() => {
  const DB_NAME = 'run-pacer-music';
  const STORE = 'tracks';
  let db = null;
  let audioEl = new Audio(); // 로컬 파일 재생용
  let currentTrackId = null;
  let currentSource = null; // 'local' | 'youtube' | 'spotify'
  let isMovingFast = false;

  let ytPlayer = null;
  let ytReadyPromise = null;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains(STORE)) {
          database.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }

  async function addTrack(file) {
    if (!db) await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).add({
        source: 'local', name: file.name.replace(/\.[^.]+$/, ''), blob: file, addedAt: Date.now(),
      });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function addYoutubeTrack(videoId, title) {
    if (!db) await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).add({ source: 'youtube', name: title, videoId, addedAt: Date.now() });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function addSpotifyTrack(uri, name) {
    if (!db) await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).add({ source: 'spotify', name, spotifyUri: uri, addedAt: Date.now() });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function listTracks() {
    if (!db) await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /* ---------------- 유튜브 IFrame 플레이어 (재생 화면이 눈에 보여야 하는 정책 때문에
     러닝 화면 한쪽에 작게 붙여둠) ---------------- */
  function ensureYoutubeApi() {
    if (ytReadyPromise) return ytReadyPromise;
    ytReadyPromise = new Promise((resolve) => {
      if (window.YT && window.YT.Player) return resolve();
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
      window.onYouTubeIframeAPIReady = () => resolve();
    });
    return ytReadyPromise;
  }

  async function ensureYtPlayer() {
    await ensureYoutubeApi();
    if (ytPlayer) return ytPlayer;
    return new Promise((resolve) => {
      ytPlayer = new YT.Player('youtube-player', {
        height: '68', width: '120',
        events: { onReady: () => resolve(ytPlayer) },
      });
    });
  }

  async function stopCurrent() {
    audioEl.pause();
    if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();
    if (currentSource === 'spotify') await SpotifyBackend.pause().catch(() => {});
  }

  async function playTrackById(id) {
    if (!db) await openDB();
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    return new Promise((resolve) => {
      req.onsuccess = async () => {
        const track = req.result;
        if (!track) return resolve();
        await stopCurrent();
        currentTrackId = id;
        currentSource = track.source || 'local';

        if (currentSource === 'local') {
          audioEl.src = URL.createObjectURL(track.blob);
          audioEl.play();
        } else if (currentSource === 'youtube') {
          const player = await ensureYtPlayer();
          player.loadVideoById(track.videoId);
        } else if (currentSource === 'spotify') {
          await SpotifyBackend.play(track.spotifyUri);
        }
        isMovingFast = true;
        resolve();
      };
    });
  }

  // "OO 노래 틀어줘" 음성 명령에서 뽑아낸 검색어로 가장 비슷한 곡 찾아 재생
  async function playByVoiceQuery(query) {
    const tracks = await listTracks();
    if (tracks.length === 0) return false;
    const norm = (s) => s.toLowerCase().replace(/\s/g, '');
    const q = norm(query);
    let best = tracks.find((t) => norm(t.name).includes(q) || q.includes(norm(t.name)));
    if (!best) best = tracks[Math.floor(Math.random() * tracks.length)];
    await playTrackById(best.id);
    return best.name;
  }

  function pause() {
    if (currentSource === 'youtube' && ytPlayer) ytPlayer.pauseVideo();
    else if (currentSource === 'spotify') SpotifyBackend.pause();
    else audioEl.pause();
  }
  function resume() {
    if (currentSource === 'youtube' && ytPlayer) ytPlayer.playVideo();
    else if (currentSource === 'spotify') SpotifyBackend.resume();
    else if (audioEl.src) audioEl.play();
  }
  function isPlaying() {
    if (currentSource === 'youtube' && ytPlayer?.getPlayerState) return ytPlayer.getPlayerState() === 1;
    if (currentSource === 'spotify') return true; // Spotify 쪽 상태는 단순화
    return !audioEl.paused && !!audioEl.src;
  }

  // 러닝 시작하는 순간 바로 재생 (GPS 속도 감지를 기다리지 않음)
  async function startForRun() {
    const tracks = await listTracks();
    if (tracks.length) await playTrackById(tracks[0].id);
  }

  // GPS 속도(m/s)를 넣어주면, 멈추면 일시정지 / 다시 움직이면 이어서 재생
  function onSpeedUpdate(speedMs) {
    const RUN_THRESHOLD = 1.0;
    const nowMoving = speedMs >= RUN_THRESHOLD;
    if (!nowMoving && isMovingFast) pause();
    else if (nowMoving && !isMovingFast) resume();
    isMovingFast = nowMoving;
  }

  // 다음 곡으로 넘어감 (버튼으로 곡 바꾸기용 - 달리면서 음성인식이 잘 안 될 때를 위함)
  async function playNext() {
    const tracks = await listTracks();
    if (tracks.length === 0) return null;
    const idx = tracks.findIndex((t) => t.id === currentTrackId);
    const next = tracks[(idx + 1) % tracks.length];
    await playTrackById(next.id);
    return next.name;
  }

  return {
    openDB, addTrack, addYoutubeTrack, addSpotifyTrack, listTracks, playTrackById,
    playByVoiceQuery, playNext, pause, resume, isPlaying, startForRun, onSpeedUpdate,
  };
})();
