// Spotify PKCE 로그인(서버 없이 브라우저에서 직접) + 검색 + Web Playback SDK 재생
// ⚠️ Spotify 개발자 대시보드(developer.spotify.com/dashboard)에서 앱을 만들고,
//    Redirect URI에 지금 이 사이트 주소를 정확히 등록해야 동작함.
//    Vercel Drop처럼 배포할 때마다 주소가 바뀌면, 그때마다 이 값도 다시 등록해야 함.
const SpotifyBackend = (() => {
  const CLIENT_ID = '여기에_Spotify_Client_ID';
  const REDIRECT_URI = window.location.origin + window.location.pathname;
  const SCOPES = 'streaming user-read-email user-read-private user-modify-playback-state';

  function base64url(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function generatePkce() {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier, challenge: base64url(digest) };
  }

  async function login() {
    const { verifier, challenge } = await generatePkce();
    sessionStorage.setItem('spotify_verifier', verifier);
    const url = new URL('https://accounts.spotify.com/authorize');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('code_challenge', challenge);
    window.location.href = url.toString();
  }

  // 로그인 성공 후 돌아왔을 때(주소에 ?code=... 붙어있음) 토큰 교환
  async function handleRedirectCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code) return false;
    const verifier = sessionStorage.getItem('spotify_verifier');
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await res.json();
    window.history.replaceState({}, '', window.location.pathname); // 주소에서 ?code=... 지우기
    if (!data.access_token) return false;
    localStorage.setItem('spotify_access_token', data.access_token);
    localStorage.setItem('spotify_refresh_token', data.refresh_token || '');
    return true;
  }

  function isConnected() {
    return !!localStorage.getItem('spotify_access_token');
  }

  function getToken() {
    return localStorage.getItem('spotify_access_token');
  }

  async function search(query) {
    const res = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=8`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    const data = await res.json();
    return (data.tracks?.items || []).map((t) => ({
      uri: t.uri,
      name: t.name,
      artist: t.artists.map((a) => a.name).join(', '),
    }));
  }

  let player = null;
  let deviceId = null;
  let playerReadyPromise = null;

  function ensurePlayer() {
    if (playerReadyPromise) return playerReadyPromise;
    playerReadyPromise = new Promise((resolve) => {
      const tag = document.createElement('script');
      tag.src = 'https://sdk.scdn.co/spotify-player.js';
      document.head.appendChild(tag);
      window.onSpotifyWebPlaybackSDKReady = () => {
        player = new Spotify.Player({
          name: '런페이서',
          getOAuthToken: (cb) => cb(getToken()),
          volume: 0.8,
        });
        player.addListener('ready', ({ device_id }) => {
          deviceId = device_id;
          resolve(player);
        });
        player.connect();
      };
    });
    return playerReadyPromise;
  }

  async function play(uri) {
    await ensurePlayer();
    await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [uri] }),
    });
  }

  function pause() {
    return fetch('https://api.spotify.com/v1/me/player/pause', {
      method: 'PUT', headers: { Authorization: `Bearer ${getToken()}` },
    }).catch(() => {});
  }

  function resume() {
    return fetch('https://api.spotify.com/v1/me/player/play', {
      method: 'PUT', headers: { Authorization: `Bearer ${getToken()}` },
    }).catch(() => {});
  }

  return { login, handleRedirectCallback, isConnected, search, play, pause, resume };
})();
