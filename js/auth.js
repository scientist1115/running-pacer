// Firebase Authentication(아이디/비밀번호 + 구글) + Firestore 회원 프로필 저장
const Auth = (() => {
  // ⚠️ Firebase 콘솔 > 프로젝트 설정 > 내 앱 에서 나오는 값으로 바꿔주세요.
  const firebaseConfig = {
    apiKey: 'AIzaSyCnSa3K0iQ-jGgwP6qzzP3bx39OUfA4KiQ',
    authDomain: 'runpacer-125a6.firebaseapp.com',
    projectId: 'runpacer-125a6',
    storageBucket: 'runpacer-125a6.firebasestorage.app',
    messagingSenderId: '638843744831',
    appId: '1:638843744831:web:0400829d0df1d7b1c6fe8a',
  };

  firebase.initializeApp(firebaseConfig);
  const fbAuth = firebase.auth();
  const db = firebase.firestore();

  // 로그인 상태 유지 여부 - 로그인/구글로그인 직전에 호출해서 반영함.
  // LOCAL: 브라우저를 껐다 켜도 로그인 유지 (기본값, Firebase Auth의 원래 기본 동작)
  // SESSION: 이 탭/창을 닫으면 로그아웃됨
  // 참고: Firebase Auth 기본 SDK는 "정확히 N일 후 자동 로그아웃" 같은 기간 지정은 지원하지 않음 -
  // 그건 Google Cloud Identity Platform(유료, 별도 인프라) 수준의 기능이라 여기선 두 모드만 제공함
  async function setRememberMe(remember) {
    const mode = remember ? firebase.auth.Auth.Persistence.LOCAL : firebase.auth.Auth.Persistence.SESSION;
    await fbAuth.setPersistence(mode);
  }

  // Firebase 이메일/비밀번호 로그인은 이메일 형식이 필요해서,
  // 사용자가 정한 "아이디"를 내부적으로 가짜 이메일로 변환해서 씀
  const ID_DOMAIN = '@runpacer.local';
  const idToEmail = (id) => `${id}${ID_DOMAIN}`;

  // 아이디 규칙: 영문+숫자 조합, 8~14자 / 비밀번호는 8자 이상이면 됨(구성 제한은 없음)
  // 문자 종류를 강제하면 오히려 "Password1!" 같은 뻔한 비밀번호를 만들어내므로,
  // 대신 길이 + 흔한 취약 비밀번호/아이디와 동일한 값만 최소한으로 거름
  const ID_REGEX = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{8,14}$/;
  const COMMON_WEAK_PASSWORDS = ['password', '12345678', '123456789', 'qwerty123', 'password1', 'abcd1234'];
  function isValidId(value) {
    return ID_REGEX.test(value || '');
  }
  function isValidPassword(value, id) {
    if (!value || value.length < 8) return false;
    const lower = value.toLowerCase();
    if (COMMON_WEAK_PASSWORDS.includes(lower)) return false;
    if (id && lower === id.toLowerCase()) return false;
    return true;
  }

  // usernames/{아이디} 문서 존재 여부로 중복체크 (프로필 전체를 노출하지 않고 아이디만 확인)
  async function checkUsernameAvailable(id) {
    const doc = await db.collection('usernames').doc(id).get();
    return !doc.exists;
  }

  async function signUp({ id, password, name, age, gender }) {
    if (!isValidId(id)) throw new Error('아이디는 영문+숫자 조합 8~14자여야 해요');
    if (!isValidPassword(password, id)) throw new Error('비밀번호는 8자 이상이어야 하고, 너무 흔하거나 아이디와 같으면 안 돼요');
    if (!name) throw new Error('이름을 입력해주세요');

    const available = await checkUsernameAvailable(id);
    if (!available) throw new Error('이미 사용 중인 아이디예요');

    const cred = await fbAuth.createUserWithEmailAndPassword(idToEmail(id), password);
    await db.collection('users').doc(cred.user.uid).set({
      username: id,
      name,
      age: age ? Number(age) : null,
      gender: gender || null,
      goalKm: null,
      distanceRunKm: 0,
      provider: 'password',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await db.collection('usernames').doc(id).set({ uid: cred.user.uid });
    return cred.user;
  }

  async function logIn({ id, password }) {
    const cred = await fbAuth.signInWithEmailAndPassword(idToEmail(id), password);
    return cred.user;
  }

  async function logInWithGoogle() {
    const provider = new firebase.auth.GoogleAuthProvider();
    const cred = await fbAuth.signInWithPopup(provider);
    const ref = db.collection('users').doc(cred.user.uid);
    const snap = await ref.get();
    let isNew = false;
    if (!snap.exists) {
      isNew = true;
      // 구글로 처음 로그인한 경우 프로필 문서를 기본값으로 만들어둠
      await ref.set({
        username: null,
        name: cred.user.displayName || '',
        age: null,
        gender: null,
        goalKm: null,
        distanceRunKm: 0,
        provider: 'google',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
    return { user: cred.user, isNew };
  }

  function onAuthChange(callback) {
    fbAuth.onAuthStateChanged(callback);
  }

  function signOut() {
    return fbAuth.signOut();
  }

  async function getProfile(uid) {
    const doc = await db.collection('users').doc(uid).get();
    return doc.exists ? doc.data() : null;
  }

  async function saveGoal(uid, goalKm) {
    await db.collection('users').doc(uid).set(
      { goalKm: goalKm ? Number(goalKm) : null },
      { merge: true }
    );
  }

  // 러닝 한 번 끝날 때마다 누적 거리에 더함 (연간 목표 진행률 계산용)
  async function addDistance(uid, km) {
    if (!km || km <= 0) return;
    await db.collection('users').doc(uid).set(
      { distanceRunKm: firebase.firestore.FieldValue.increment(km) },
      { merge: true }
    );
  }

  // 고급 아이템(5km/7km 코스 완주) 획득 기록 - users/{uid}.premiumItems 배열에 추가
  async function addPremiumItem(uid, itemId) {
    if (!uid || !itemId) return;
    await db.collection('users').doc(uid).set(
      { premiumItems: firebase.firestore.FieldValue.arrayUnion(itemId) },
      { merge: true }
    );
  }

  // 걷는 캐릭터: 확정된 걸음 거리(m)와 확정 시각(ms)을 저장 - 앱이 꺼져 있던 시간은 이 시각부터 계산해요
  async function saveWalk(uid, meters, atMs) {
    if (!uid || !isFinite(meters) || !isFinite(atMs)) return;
    await db.collection('users').doc(uid).set(
      { walkMeters: Number(meters), walkAt: Number(atMs) },
      { merge: true }
    );
  }

  // 러닝 한 회차 기록을 저장 (홈 화면의 기록 목록/페이스 그래프/지도 겹쳐보기용)
  async function saveRun(uid, { points, distanceKm, durationSec, paceMinPerKm }) {
    await db.collection('users').doc(uid).collection('runs').add({
      points,
      distanceKm,
      durationSec,
      paceMinPerKm,
      completedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  async function listRuns(uid, limitCount = 20) {
    const snap = await db.collection('users').doc(uid).collection('runs')
      .orderBy('completedAt', 'desc').limit(limitCount).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  // 올해 1월 1일부터 지금까지 뛴 기록만 모아서 거리 합/평균 페이스 계산 - 순위 공개용
  async function getYearRunStats(uid) {
    const startOfYear = new Date(new Date().getFullYear(), 0, 1);
    const snap = await db.collection('users').doc(uid).collection('runs')
      .where('completedAt', '>=', startOfYear)
      .get();
    let totalKm = 0;
    let totalSec = 0;
    snap.forEach((doc) => {
      const d = doc.data();
      totalKm += d.distanceKm || 0;
      totalSec += d.durationSec || 0;
    });
    return {
      distanceKm: totalKm,
      avgPaceMinPerKm: totalKm > 0 ? (totalSec / 60) / totalKm : 0,
    };
  }

  // 순위 공개 켜기: 이번 해 기록을 다시 계산해서 leaderboard/{uid} 문서로 올림 (본인만 이 문서에 쓸 수 있음)
  // 이름/아이디 중간 글자를 가림 - 화면에서만 가리면 공개 읽기 가능한 Firestore 문서엔
  // 원본이 그대로 남아있는 셈이라, 저장하는 시점에 이미 가려서 씀
  function maskMiddle(str) {
    if (!str) return '러너';
    if (str.length <= 1) return str;
    if (str.length === 2) return str[0] + '*';
    return str[0] + '*'.repeat(str.length - 2) + str[str.length - 1];
  }

  async function publishLeaderboard(uid, displayName) {
    const stats = await getYearRunStats(uid);
    await db.collection('leaderboard').doc(uid).set({
      displayName: maskMiddle(displayName),
      distanceKm: stats.distanceKm,
      avgPaceMinPerKm: stats.avgPaceMinPerKm,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    return stats;
  }

  async function unpublishLeaderboard(uid) {
    await db.collection('leaderboard').doc(uid).delete();
  }

  async function isPublished(uid) {
    const doc = await db.collection('leaderboard').doc(uid).get();
    return doc.exists;
  }

  // 순위 목록(거리 많은 순) - 공개하기로 한 사람만 나옴, 로그인 없이도 읽을 수 있는 컬렉션
  async function getLeaderboardTop(limitCount = 10) {
    const snap = await db.collection('leaderboard')
      .orderBy('distanceKm', 'desc')
      .limit(limitCount)
      .get();
    return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  }

  // Firebase 에러 코드를 한국어 메시지로 변환
  function toKoreanError(err) {
    const code = err?.code || '';
    if (code.includes('email-already-in-use')) return '이미 사용 중인 아이디예요';
    if (code.includes('user-not-found') || code.includes('wrong-password') || code.includes('invalid-credential')) {
      return '아이디 또는 비밀번호가 올바르지 않아요';
    }
    if (code.includes('popup-closed-by-user')) return 'Google 로그인 창이 닫혔어요';
    if (code.includes('weak-password')) return '비밀번호가 너무 단순해요';
    return err.message || '알 수 없는 오류가 발생했어요';
  }

  return {
    signUp, logIn, logInWithGoogle, onAuthChange, signOut, isValidId, isValidPassword,
    checkUsernameAvailable, getProfile, saveGoal, addDistance, addPremiumItem, saveWalk, saveRun, listRuns, toKoreanError,
    getYearRunStats, publishLeaderboard, unpublishLeaderboard, isPublished, getLeaderboardTop,
    setRememberMe,
  };
})();
