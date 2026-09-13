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

  // Firebase 이메일/비밀번호 로그인은 이메일 형식이 필요해서,
  // 사용자가 정한 "아이디"를 내부적으로 가짜 이메일로 변환해서 씀
  const ID_DOMAIN = '@runpacer.local';
  const idToEmail = (id) => `${id}${ID_DOMAIN}`;

  // 아이디 규칙: 영문+숫자 조합, 8~14자 / 비밀번호는 6자 이상이면 됨(구성 제한 없음)
  const ID_REGEX = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{8,14}$/;
  function isValidId(value) {
    return ID_REGEX.test(value || '');
  }
  function isValidPassword(value) {
    return !!value && value.length >= 6;
  }

  // usernames/{아이디} 문서 존재 여부로 중복체크 (프로필 전체를 노출하지 않고 아이디만 확인)
  async function checkUsernameAvailable(id) {
    const doc = await db.collection('usernames').doc(id).get();
    return !doc.exists;
  }

  async function signUp({ id, password, name, age, gender }) {
    if (!isValidId(id)) throw new Error('아이디는 영문+숫자 조합 8~14자여야 해요');
    if (!isValidPassword(password)) throw new Error('비밀번호는 6자 이상이어야 해요');
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
    checkUsernameAvailable, getProfile, saveGoal, addDistance, saveRun, listRuns, toKoreanError,
  };
})();
