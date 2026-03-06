import { useState, useEffect, useCallback, useRef } from "react";
import { ref, onValue, set, get } from "firebase/database";
import { db } from "./firebase";
import { JEFF_QUESTIONS, BONUS_QUESTIONS, DEFAULT_ABOUT, DEFAULT_INSTRUCTIONS } from "./questions";

// ── Helpers ──────────────────────────────────────────────────────────────────

// Weight calculation: high ratings → more likely, low ratings + skips → less likely
// New/unrated questions get a neutral weight of 1.0
function getWeight(qId, ratings) {
  const r = ratings[qId];
  if (!r) return 1.0;
  const skips = r.skips || 0;
  const count = r.count || 0;
  const avg = count > 0 ? r.total / count : null;

  let weight = 1.0;

  // Rating effect: 5★ → 2.5x, 4★ → 1.8x, 3★ → 1.0x, 2★ → 0.5x, 1★ → 0.2x
  if (avg !== null) {
    if (avg >= 4.5) weight *= 2.5;
    else if (avg >= 3.5) weight *= 1.8;
    else if (avg >= 2.5) weight *= 1.0;
    else if (avg >= 1.5) weight *= 0.5;
    else weight *= 0.2;
  }

  // Skip penalty: each skip reduces weight, but never below 0.05
  if (skips > 0) {
    const skipPenalty = Math.pow(0.85, skips); // -15% per skip, compounding
    weight *= skipPenalty;
  }

  return Math.max(weight, 0.05); // floor at 5% so nothing disappears entirely
}

function pickWeighted(arr, excludeId, ratings) {
  if (!arr.length) return null;
  const candidates = arr.filter(q => q.id !== excludeId);
  if (!candidates.length) return arr[0];

  const weights = candidates.map(q => getWeight(q.id, ratings));
  const total = weights.reduce((a, b) => a + b, 0);
  let rand = Math.random() * total;

  for (let i = 0; i < candidates.length; i++) {
    rand -= weights[i];
    if (rand <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

// Keep pickRandom as a fallback for when ratings aren't loaded yet
function pickRandom(arr, excludeId) {
  if (!arr.length) return null;
  if (arr.length === 1) return arr[0];
  let q;
  let attempts = 0;
  do { q = arr[Math.floor(Math.random() * arr.length)]; attempts++; }
  while (q.id === excludeId && attempts < 20);
  return q;
}

function ls_get(key, fb) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fb; } catch { return fb; }
}
function ls_set(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch {}
}

// Firebase read/write helpers
async function fbGet(path, fallback) {
  try {
    const snap = await get(ref(db, path));
    return snap.exists() ? snap.val() : fallback;
  } catch { return fallback; }
}
async function fbSet(path, value) {
  try { await set(ref(db, path), value); } catch (e) { console.error("fbSet error", e); }
}

const ADMIN_PW_KEY = "aq_admin_pw"; // stored locally only

export default function App() {
  const [myId] = useState(() => {
    let id = localStorage.getItem("aq_myid");
    if (!id) { id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`; localStorage.setItem("aq_myid", id); }
    return id;
  });

  // screen: "home" | "solo" | "lobby" | "game"
  const [screen, setScreen] = useState("home");
  const [nameInput, setNameInput] = useState("");
  const [joinError, setJoinError] = useState("");
  const [myName, setMyName] = useState(() => localStorage.getItem("aq_myname") || "");
  const [mode, setMode] = useState(null);

  // Shared Firebase state
  const [players, setPlayers] = useState([]);
  const [gameState, setGameState] = useState(null);
  const [ratings, setRatings] = useState({});
  const [customQuestions, setCustomQuestions] = useState([]);
  const [aboutText, setAboutText] = useState(DEFAULT_ABOUT);
  const [instructionsText, setInstructionsText] = useState(DEFAULT_INSTRUCTIONS);
  const [loaded, setLoaded] = useState(false);

  // UI state
  const [showAbout, setShowAbout] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [adminPw, setAdminPw] = useState("");
  const [adminAuthed, setAdminAuthed] = useState(false);
  const [adminTab, setAdminTab] = useState("instructions");
  const [adminError, setAdminError] = useState("");
  const [flipping, setFlipping] = useState(false);
  const [justRated, setJustRated] = useState(false);
  const [starHover, setStarHover] = useState(0);
  const [editAbout, setEditAbout] = useState("");
  const [editInstructions, setEditInstructions] = useState("");
  const [editQ, setEditQ] = useState(null);
  const [newQText, setNewQText] = useState("");
  const [newQHint, setNewQHint] = useState("");
  const [newQAuthor, setNewQAuthor] = useState("");
  const [showAddQ, setShowAddQ] = useState(false);
  const [adminPwNew, setAdminPwNew] = useState("");
  const [toast, setToast] = useState("");
  // Solo
  const [soloQ, setSoloQ] = useState(null);
  const [soloJustRated, setSoloJustRated] = useState(false);
  const [soloStarHover, setSoloStarHover] = useState(0);

  const allQ = [...JEFF_QUESTIONS, ...BONUS_QUESTIONS, ...customQuestions];

  // ── Firebase listeners ────────────────────────────────────────────────────
  useEffect(() => {
    const unsubs = [];
    const listen = (path, setter) => {
      const r = ref(db, path);
      const unsub = onValue(r, snap => setter(snap.exists() ? snap.val() : null));
      unsubs.push(unsub);
    };

    listen("players", v => setPlayers(v ? Object.values(v).sort((a, b) => a.joinedAt - b.joinedAt) : []));
    listen("gameState", v => setGameState(v));
    listen("ratings", v => setRatings(v || {}));
    listen("customQuestions", v => setCustomQuestions(v ? Object.values(v) : []));
    listen("aboutText", v => { if (v) setAboutText(v); });
    listen("instructionsText", v => { if (v) setInstructionsText(v); });

    // Check if this player was already in a session
    setTimeout(() => {
      const savedName = localStorage.getItem("aq_myname");
      const savedMode = localStorage.getItem("aq_mode");
      if (savedName && savedMode === "solo") {
        setMyName(savedName); setMode("solo"); setScreen("solo");
        setSoloQ(pickRandom(JEFF_QUESTIONS, null));
      }
      setLoaded(true);
    }, 600);

    return () => unsubs.forEach(u => u());
  }, []);

  // Rejoin multiplayer if was in session
  useEffect(() => {
    if (!loaded) return;
    const savedName = localStorage.getItem("aq_myname");
    const savedMode = localStorage.getItem("aq_mode");
    if (savedName && savedMode === "multi" && players.find(p => p.id === myId)) {
      setMyName(savedName); setMode("multi");
      setScreen(gameState ? "game" : "lobby");
    }
  }, [loaded, players, gameState, myId]);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(""), 2800); };
  const getAvgRating = (id) => { const r = ratings[id]; if (!r || !r.count) return null; return (r.total / r.count).toFixed(1); };
  const getPlayer = (id) => players.find(p => p.id === id);
  const isHost = players.length > 0 && players[0].id === myId;

  // ── Solo ─────────────────────────────────────────────────────────────────
  const startSolo = () => {
    localStorage.setItem("aq_mode", "solo");
    localStorage.setItem("aq_myname", "Solo");
    setMode("solo"); setSoloQ(pickWeighted(allQ, null, ratings));
    setSoloJustRated(false); setScreen("solo");
  };

  const soloNext = () => {
    setFlipping(true);
    setTimeout(() => { setSoloQ(pickWeighted(allQ, soloQ?.id, ratings)); setSoloJustRated(false); setSoloStarHover(0); setFlipping(false); }, 280);
  };

  const soloSkip = async () => {
    if (!soloQ) return;
    const existing = ratings[soloQ.id] || { total: 0, count: 0, skips: 0 };
    const updated = { ...existing, skips: (existing.skips || 0) + 1 };
    await fbSet(`ratings/${soloQ.id}`, updated);
    soloNext();
  };

  const soloRate = async (stars) => {
    if (!soloQ) return;
    const existing = ratings[soloQ.id] || { total: 0, count: 0, skips: 0 };
    await fbSet(`ratings/${soloQ.id}`, { ...existing, total: existing.total + stars, count: existing.count + 1 });
    setSoloJustRated(true);
  };

  // ── Join multiplayer ──────────────────────────────────────────────────────
  const joinMulti = async () => {
    const name = nameInput.trim();
    if (!name) { setJoinError("Please enter your name."); return; }
    const current = await fbGet("players", {});
    const list = current ? Object.values(current) : [];
    if (list.find(p => p.id === myId)) {
      localStorage.setItem("aq_myname", name); localStorage.setItem("aq_mode", "multi");
      setMyName(name); setMode("multi");
      const gs = await fbGet("gameState", null);
      setScreen(gs ? "game" : "lobby"); return;
    }
    if (list.length >= 15) { setJoinError("Game is full (15 players max)."); return; }
    const player = { id: myId, name, joinedAt: Date.now() };
    await fbSet(`players/${myId}`, player);
    localStorage.setItem("aq_myname", name); localStorage.setItem("aq_mode", "multi");
    setMyName(name); setMode("multi"); setScreen("lobby");
  };

  // ── Start / manage game ───────────────────────────────────────────────────
  const startGame = async () => {
    if (players.length < 2) { showToast("Need at least 2 players!"); return; }
    const q = pickWeighted(allQ, null, ratings);
    const questioner = players[Math.floor(Math.random() * players.length)];
    const others = players.filter(p => p.id !== questioner.id);
    const answerer = others[Math.floor(Math.random() * others.length)];
    const gs = { currentQ: q, questioner: questioner.id, answerer: answerer.id, round: 1, usedPlayerIds: [answerer.id] };
    await fbSet("gameState", gs);
    setScreen("game");
  };

  const nextQuestion = async () => {
    if (!gameState) return;
    setFlipping(true);
    setTimeout(async () => {
      const q = pickWeighted(allQ, gameState.currentQ?.id, ratings);
      const newQuestioner = players.find(p => p.id === gameState.answerer) || players[0];
      let used = gameState.usedPlayerIds || [];
      const eligible = players.filter(p => p.id !== newQuestioner.id && !used.includes(p.id));
      let pool = eligible.length > 0 ? eligible : players.filter(p => p.id !== newQuestioner.id);
      if (eligible.length === 0) used = [];
      if (!pool.length) pool = players;
      const newAnswerer = pool[Math.floor(Math.random() * pool.length)];
      const gs = {
        ...gameState, currentQ: q,
        questioner: newQuestioner.id, answerer: newAnswerer.id,
        round: (gameState.round || 1) + 1,
        usedPlayerIds: [...used, newAnswerer.id]
      };
      await fbSet("gameState", gs);
      setJustRated(false); setStarHover(0); setFlipping(false);
    }, 280);
  };

  const skipQ = async () => {
    if (!gameState?.currentQ) return;
    const existing = ratings[gameState.currentQ.id] || { total: 0, count: 0, skips: 0 };
    await fbSet(`ratings/${gameState.currentQ.id}`, { ...existing, skips: (existing.skips || 0) + 1 });
    nextQuestion();
  };

  const rateQ = async (stars) => {
    if (!gameState?.currentQ) return;
    const existing = ratings[gameState.currentQ.id] || { total: 0, count: 0, skips: 0 };
    await fbSet(`ratings/${gameState.currentQ.id}`, { ...existing, total: existing.total + stars, count: existing.count + 1 });
    setJustRated(true);
  };

  const endGame = async () => {
    await fbSet("gameState", null);
    // Remove this player from players list
    await fbSet(`players/${myId}`, null);
    localStorage.removeItem("aq_mode"); localStorage.removeItem("aq_myname");
    setMyName(""); setNameInput(""); setMode(null); setScreen("home");
  };

  // ── Admin ─────────────────────────────────────────────────────────────────
  const adminLogin = () => {
    const stored = ls_get(ADMIN_PW_KEY, "admin123");
    if (adminPw === stored) {
      setAdminAuthed(true); setAdminError("");
      setEditAbout(aboutText); setEditInstructions(instructionsText);
    } else setAdminError("Incorrect password.");
  };

  const saveAbout = async () => { await fbSet("aboutText", editAbout); showToast("About saved!"); };
  const saveInstructions = async () => { await fbSet("instructionsText", editInstructions); showToast("Instructions saved!"); };

  const addCustomQ = async () => {
    if (!newQText.trim()) return;
    const id = `cq_${Date.now()}`;
    const q = { id, text: newQText.trim(), hint: newQHint.trim() || null, author: newQAuthor.trim() || "Guest", type: "community" };
    await fbSet(`customQuestions/${id}`, q);
    setNewQText(""); setNewQHint(""); setNewQAuthor(""); setShowAddQ(false); showToast("Question added!");
  };

  const deleteCustomQ = async (id) => { await fbSet(`customQuestions/${id}`, null); };
  const saveEditQ = async () => {
    if (!editQ) return;
    await fbSet(`customQuestions/${editQ.id}`, editQ);
    setEditQ(null); showToast("Updated!");
  };
  // ── Derived ───────────────────────────────────────────────────────────────
  const currentQ = gameState?.currentQ;
  const questioner = gameState ? getPlayer(gameState.questioner) : null;
  const answerer = gameState ? getPlayer(gameState.answerer) : null;
  const amQuestioner = gameState?.questioner === myId;
  const amAnswerer = gameState?.answerer === myId;
  const currentRating = currentQ ? getAvgRating(currentQ.id) : null;
  const currentRatingCount = currentQ ? (ratings[currentQ.id]?.count || 0) : 0;
  const soloRating = soloQ ? getAvgRating(soloQ.id) : null;
  const soloRatingCount = soloQ ? (ratings[soloQ.id]?.count || 0) : 0;

  if (!loaded) return (
    <>
      <style>{`body{background:#0c0804;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:'Georgia',serif;color:#c9923a;}`}</style>
      <div style={{ textAlign: "center", opacity: 0.6 }}>
        <div style={{ fontSize: "2rem", marginBottom: "1rem", fontStyle: "italic" }}>Ask Questions!</div>
        <div style={{ fontSize: ".8rem", letterSpacing: ".2em", textTransform: "uppercase" }}>Loading…</div>
      </div>
    </>
  );

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&family=Lora:ital,wght@0,400;0,600;1,400&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
          --cream: #f5f0e8; --parchment: #ede5d0; --dark: #100c05;
          --burgundy: #7a1b2e; --gold: #c9923a; --gold-lt: #e8c068;
          --amber: #d4852a; --muted: #8a7060; --green: #2d6b47;
        }
        html, body { height: 100%; }
        body { background: var(--dark); font-family: 'Lora', Georgia, serif; color: var(--cream); min-height: 100vh; overflow-x: hidden; }
        .bg { position: fixed; inset: 0; z-index: 0; pointer-events: none;
          background: radial-gradient(ellipse at 20% 20%, rgba(201,146,58,.07) 0%, transparent 55%),
                      radial-gradient(ellipse at 80% 80%, rgba(122,27,46,.09) 0%, transparent 55%), #0c0804; }
        .glow { position: fixed; inset: 0; z-index: 0; pointer-events: none;
          background: radial-gradient(ellipse 55% 35% at 50% 0%, rgba(212,133,42,.05) 0%, transparent 70%);
          animation: flicker 6s ease-in-out infinite alternate; }
        @keyframes flicker { 0%{opacity:.6} 50%{opacity:1} 100%{opacity:.8} }
        .app { position: relative; z-index: 1; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 0 1rem 5rem; }

        .hdr { width: 100%; max-width: 720px; padding: 2rem 0 1.2rem; text-align: center; border-bottom: 1px solid rgba(201,146,58,.15); margin-bottom: 2rem; }
        .hdr-eye { font-size: .62rem; letter-spacing: .25em; text-transform: uppercase; color: var(--gold); opacity: .7; margin-bottom: .4rem; }
        .hdr-title { font-family: 'Playfair Display', serif; font-size: clamp(2rem, 6vw, 3.2rem); font-weight: 900; color: var(--cream); }
        .hdr-title em { font-style: italic; color: var(--gold-lt); }
        .hdr-sub { font-size: .78rem; color: var(--muted); font-style: italic; margin-top: .35rem; }
        .hdr-nav { display: flex; justify-content: center; gap: .45rem; flex-wrap: wrap; margin-top: 1rem; }
        .nav-btn { background: transparent; border: 1px solid rgba(201,146,58,.22); color: var(--gold); font-family: 'Lora', serif; font-size: .7rem; letter-spacing: .1em; text-transform: uppercase; padding: .28rem .75rem; border-radius: 2px; cursor: pointer; transition: all .2s; }
        .nav-btn:hover { background: rgba(201,146,58,.1); border-color: var(--gold); }
        .nav-btn.warn { color: #b06060; border-color: rgba(176,96,96,.22); }
        .nav-btn.warn:hover { background: rgba(176,96,96,.1); }

        .home-wrap { width: 100%; max-width: 460px; }
        .home-card { background: linear-gradient(145deg, #261a0c 0%, #19110a 100%); border: 1px solid rgba(201,146,58,.2); border-radius: 4px; padding: 2.5rem; box-shadow: 0 20px 60px rgba(0,0,0,.55), inset 0 1px 0 rgba(201,146,58,.1); position: relative; overflow: hidden; }
        .home-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, transparent, var(--gold), transparent); opacity: .4; }
        .home-title { font-family: 'Playfair Display', serif; font-size: 1.3rem; font-weight: 700; color: var(--gold-lt); margin-bottom: 1.8rem; }
        .mode-lbl { font-size: .65rem; letter-spacing: .18em; text-transform: uppercase; color: var(--muted); margin-bottom: .7rem; display: block; }
        .mode-desc { font-size: .78rem; color: var(--muted); font-style: italic; margin-bottom: .9rem; line-height: 1.5; }
        .divider-line { border: none; border-top: 1px solid rgba(201,146,58,.12); margin: 1.5rem 0; }
        .form-lbl { display: block; font-size: .65rem; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); margin-bottom: .35rem; }
        .form-input { width: 100%; background: rgba(255,255,255,.04); border: 1px solid rgba(201,146,58,.18); border-radius: 3px; color: var(--cream); font-family: 'Lora', serif; font-size: .95rem; padding: .65rem .9rem; outline: none; transition: border-color .2s; }
        .form-input:focus { border-color: var(--gold); }
        .form-textarea { width: 100%; background: rgba(255,255,255,.04); border: 1px solid rgba(201,146,58,.18); border-radius: 3px; color: var(--cream); font-family: 'Lora', serif; font-size: .88rem; padding: .65rem .9rem; outline: none; transition: border-color .2s; resize: vertical; line-height: 1.6; }
        .form-textarea:focus { border-color: var(--gold); }
        .err { color: #d08080; font-size: .78rem; margin-top: .4rem; font-style: italic; }

        .btn-gold { background: linear-gradient(135deg, var(--gold) 0%, var(--amber) 100%); border: none; border-radius: 3px; color: #100c05; font-family: 'Playfair Display', serif; font-size: .95rem; font-weight: 700; padding: .75rem 2rem; cursor: pointer; transition: all .2s; box-shadow: 0 4px 16px rgba(201,146,58,.25); width: 100%; }
        .btn-gold:hover { background: linear-gradient(135deg, var(--gold-lt) 0%, var(--gold) 100%); transform: translateY(-1px); box-shadow: 0 7px 22px rgba(201,146,58,.35); }
        .btn-gold:disabled { opacity: .5; cursor: not-allowed; transform: none; }
        .btn-ghost { background: transparent; border: 1px solid rgba(201,146,58,.2); border-radius: 3px; color: var(--muted); font-family: 'Lora', serif; font-size: .85rem; padding: .72rem 1.6rem; cursor: pointer; transition: all .2s; }
        .btn-ghost:hover { border-color: var(--muted); color: var(--cream); }
        .btn-green { background: linear-gradient(135deg, var(--green) 0%, #1f4f32 100%); border: 1px solid rgba(45,107,71,.4); border-radius: 3px; color: var(--cream); font-family: 'Playfair Display', serif; font-size: .95rem; font-weight: 700; padding: .75rem 2rem; cursor: pointer; transition: all .2s; width: 100%; box-shadow: 0 4px 16px rgba(45,107,71,.2); }
        .btn-green:hover { background: linear-gradient(135deg, #35805a 0%, var(--green) 100%); transform: translateY(-1px); }
        .btn-sm { padding: .38rem .85rem !important; font-size: .75rem !important; width: auto !important; }
        .btn-red { background: linear-gradient(135deg, var(--burgundy) 0%, #4e1020 100%); border: 1px solid rgba(122,27,46,.35); border-radius: 3px; color: var(--cream); font-family: 'Lora', serif; font-size: .85rem; padding: .6rem 1.3rem; cursor: pointer; transition: all .2s; }
        .btn-red:hover { background: linear-gradient(135deg, #8a2038 0%, var(--burgundy) 100%); }

        .lobby-wrap { width: 100%; max-width: 560px; }
        .card { background: linear-gradient(145deg, #261a0c 0%, #19110a 100%); border: 1px solid rgba(201,146,58,.2); border-radius: 4px; padding: 2.2rem; box-shadow: 0 20px 55px rgba(0,0,0,.5), inset 0 1px 0 rgba(201,146,58,.1); position: relative; overflow: hidden; }
        .card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, transparent, var(--gold), transparent); opacity: .35; }
        .card-title { font-family: 'Playfair Display', serif; font-size: 1.3rem; color: var(--gold-lt); margin-bottom: 1rem; }
        .player-list { display: flex; flex-wrap: wrap; gap: .5rem; margin: .8rem 0 1.2rem; }
        .p-chip { background: rgba(201,146,58,.08); border: 1px solid rgba(201,146,58,.15); border-radius: 2rem; padding: .3rem .85rem; font-size: .82rem; color: var(--parchment); }
        .p-chip.me { border-color: var(--gold); color: var(--gold-lt); }
        .p-count { font-size: .72rem; color: var(--muted); font-style: italic; margin-bottom: .5rem; }

        .game-wrap { width: 100%; max-width: 680px; }
        .role-bar { display: flex; align-items: center; justify-content: center; gap: 1.5rem; flex-wrap: wrap; padding: .9rem 1.5rem; background: rgba(201,146,58,.05); border: 1px solid rgba(201,146,58,.13); border-radius: 3px; margin-bottom: 1.4rem; }
        .role-item { text-align: center; }
        .role-lbl { font-size: .58rem; letter-spacing: .18em; text-transform: uppercase; color: var(--muted); margin-bottom: .2rem; }
        .role-name { font-family: 'Playfair Display', serif; font-size: .95rem; color: var(--cream); }
        .role-name.me { color: var(--gold-lt); }
        .role-sep { width: 1px; height: 2rem; background: rgba(201,146,58,.18); }
        .round-lbl { font-size: .6rem; letter-spacing: .15em; text-transform: uppercase; color: var(--muted); }

        .q-card { background: linear-gradient(145deg, #261a0c 0%, #19110a 100%); border: 1px solid rgba(201,146,58,.2); border-radius: 4px; padding: 2.4rem 2.4rem 2rem; box-shadow: 0 20px 55px rgba(0,0,0,.5), inset 0 1px 0 rgba(201,146,58,.1); position: relative; overflow: hidden; transition: opacity .28s, transform .28s; }
        .q-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, transparent, var(--gold), transparent); opacity: .4; }
        .q-card.flip { opacity: 0; transform: translateY(10px) scale(.98); }
        .q-num { position: absolute; top: 1rem; right: 1.2rem; font-size: .6rem; color: rgba(201,146,58,.28); }
        .q-source { display: flex; align-items: center; gap: .45rem; margin-bottom: 1rem; }
        .q-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--gold); flex-shrink: 0; }
        .q-dot.ai { background: #5b9bd5; }
        .q-dot.comm { background: var(--burgundy); }
        .q-src-lbl { font-size: .62rem; letter-spacing: .15em; text-transform: uppercase; color: var(--muted); }
        .q-text { font-family: 'Playfair Display', serif; font-size: clamp(1.2rem, 3.5vw, 1.7rem); font-weight: 400; line-height: 1.45; color: var(--cream); margin-bottom: 1.1rem; }
        .q-hint { background: rgba(201,146,58,.05); border-left: 2px solid rgba(201,146,58,.25); padding: .5rem .8rem; border-radius: 0 2px 2px 0; font-size: .78rem; color: var(--muted); font-style: italic; margin-bottom: 1rem; line-height: 1.5; }

        .rating-wrap { margin-top: 1.4rem; padding-top: 1.1rem; border-top: 1px solid rgba(201,146,58,.1); display: flex; flex-direction: column; align-items: center; gap: .4rem; }
        .rating-lbl { font-size: .62rem; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
        .stars { display: flex; gap: .2rem; }
        .star { font-size: 1.4rem; cursor: pointer; color: rgba(201,146,58,.18); transition: color .12s, transform .12s; user-select: none; }
        .star.hl { color: var(--gold-lt); transform: scale(1.2); }
        .rating-done { font-size: .72rem; color: var(--gold); font-style: italic; animation: fadeUp .3s; }
        .rating-avg { font-size: .68rem; color: var(--muted); font-style: italic; }
        @keyframes fadeUp { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:none} }

        .actions { display: flex; justify-content: center; gap: .8rem; margin-top: 1.6rem; flex-wrap: wrap; }

        .ticker { display: flex; gap: .4rem; flex-wrap: wrap; justify-content: center; margin-bottom: 1.1rem; }
        .t-chip { padding: .22rem .6rem; border-radius: 1rem; border: 1px solid rgba(201,146,58,.1); font-size: .76rem; color: var(--muted); transition: all .3s; }
        .t-chip.q { border-color: var(--gold); background: rgba(201,146,58,.1); color: var(--gold-lt); }
        .t-chip.a { border-color: var(--burgundy); background: rgba(122,27,46,.12); color: #e8a0b0; }

        .overlay { position: fixed; inset: 0; z-index: 100; background: rgba(8,5,2,.88); display: flex; align-items: flex-start; justify-content: center; padding: 2rem 1rem; overflow-y: auto; animation: fadeUp .2s; }
        .modal { background: linear-gradient(145deg, #231810 0%, #18100a 100%); border: 1px solid rgba(201,146,58,.2); border-radius: 4px; width: 100%; max-width: 600px; padding: 2.2rem; box-shadow: 0 30px 80px rgba(0,0,0,.7); position: relative; margin-top: 1.5rem; }
        .modal-title { font-family: 'Playfair Display', serif; font-size: 1.55rem; font-weight: 700; color: var(--gold-lt); margin-bottom: 1.2rem; }
        .modal-close { position: absolute; top: 1rem; right: 1rem; background: transparent; border: none; color: var(--muted); font-size: 1.1rem; cursor: pointer; transition: color .2s; }
        .modal-close:hover { color: var(--cream); }
        .modal-body { font-size: .87rem; line-height: 1.78; color: var(--parchment); white-space: pre-wrap; }
        .modal-quote { background: rgba(201,146,58,.06); border-left: 3px solid rgba(201,146,58,.3); padding: .85rem 1.1rem; border-radius: 0 3px 3px 0; font-style: italic; color: var(--parchment); margin: 1rem 0; font-size: .87rem; line-height: 1.6; }

        .tab-bar { display: flex; gap: 0; border-bottom: 1px solid rgba(201,146,58,.15); margin-bottom: 1.4rem; flex-wrap: wrap; }
        .tab { background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--muted); font-family: 'Lora', serif; font-size: .72rem; letter-spacing: .1em; text-transform: uppercase; padding: .45rem .9rem; cursor: pointer; transition: all .2s; }
        .tab.on { color: var(--gold); border-bottom-color: var(--gold); }
        .sec-title { font-family: 'Playfair Display', serif; font-size: .95rem; color: var(--gold); margin-bottom: .7rem; padding-bottom: .3rem; border-bottom: 1px solid rgba(201,146,58,.1); }
        .q-row { display: flex; align-items: flex-start; gap: .6rem; padding: .6rem 0; border-bottom: 1px solid rgba(201,146,58,.06); }
        .q-row-text { flex: 1; font-size: .8rem; color: var(--parchment); line-height: 1.4; }
        .q-row-meta { font-size: .66rem; color: var(--muted); font-style: italic; margin-top: .18rem; }
        .icon-btn { background: transparent; border: 1px solid rgba(201,146,58,.14); border-radius: 2px; color: var(--muted); font-size: .72rem; padding: .22rem .48rem; cursor: pointer; transition: all .2s; }
        .icon-btn:hover { color: var(--cream); border-color: var(--muted); }
        .icon-btn.del { border-color: rgba(176,96,96,.2); color: #c06060; }
        .icon-btn.del:hover { background: rgba(176,96,96,.1); }
        .stat-row { display: flex; justify-content: space-between; align-items: flex-start; gap: .7rem; padding: .5rem 0; border-bottom: 1px solid rgba(201,146,58,.05); font-size: .78rem; color: var(--parchment); }
        .stat-badge { background: rgba(201,146,58,.1); border: 1px solid rgba(201,146,58,.18); border-radius: 2px; padding: .1rem .42rem; font-size: .68rem; color: var(--gold); white-space: nowrap; }
        .hr { border: none; border-top: 1px solid rgba(201,146,58,.1); margin: 1.1rem 0; }
        .ai-note { font-size: .76rem; color: var(--muted); font-style: italic; margin-bottom: .9rem; line-height: 1.55; }
        .empty { font-size: .78rem; color: var(--muted); font-style: italic; padding: .5rem 0; }

        .solo-wrap { width: 100%; max-width: 660px; }
        .solo-badge { display: inline-block; background: rgba(45,107,71,.15); border: 1px solid rgba(45,107,71,.3); border-radius: 2rem; padding: .25rem .8rem; font-size: .68rem; letter-spacing: .12em; text-transform: uppercase; color: #6abf8a; margin-bottom: 1.2rem; }

        .toast { position: fixed; bottom: 2rem; left: 50%; transform: translateX(-50%); background: rgba(38,22,10,.97); border: 1px solid rgba(201,146,58,.28); border-radius: 3px; padding: .6rem 1.4rem; font-size: .8rem; color: var(--gold-lt); z-index: 200; animation: fadeUp .3s; white-space: nowrap; pointer-events: none; }

        @media(max-width:600px) {
          .q-card { padding: 1.7rem 1.3rem 1.5rem; }
          .modal { padding: 1.6rem 1.2rem; }
          .role-bar { gap: .9rem; padding: .7rem 1rem; }
        }
      `}</style>

      <div className="bg" /><div className="glow" />
      {toast && <div className="toast">{toast}</div>}

      <div className="app">
        {/* HEADER */}
        <header className="hdr">
          <p className="hdr-eye">A dinner party game</p>
          <h1 className="hdr-title"><em>Ask</em> Questions!</h1>
          {screen !== "home" && (
            <p className="hdr-sub">
              {mode === "solo" ? "Solo mode" : `${players.length} player${players.length !== 1 ? "s" : ""}`}
              {" · "}{allQ.length} questions in deck
            </p>
          )}
          <div className="hdr-nav">
            <button className="nav-btn" onClick={() => setShowInstructions(true)}>How to Play</button>
            <button className="nav-btn" onClick={() => setShowAbout(true)}>About</button>
            {(screen === "lobby" || screen === "game" || screen === "solo") && (
              <button className="nav-btn" onClick={() => { setShowAdmin(true); setAdminAuthed(false); setAdminPw(""); setAdminError(""); }}>Admin</button>
            )}
            {screen === "game" && isHost && (
              <button className="nav-btn warn" onClick={endGame}>End Game</button>
            )}
            {(screen === "lobby" || screen === "solo") && (
              <button className="nav-btn warn" onClick={endGame}>Leave</button>
            )}
          </div>
        </header>

        {/* HOME */}
        {screen === "home" && (
          <div className="home-wrap">
            <div className="home-card">
              <p className="home-title">How would you like to play?</p>
              <div style={{ marginBottom: "0" }}>
                <span className="mode-lbl">Solo Mode</span>
                <p className="mode-desc">Just you and the questions. Browse at your own pace, reflect, or prep great conversation starters for your next gathering.</p>
                <button className="btn-green" onClick={startSolo}>Play Solo →</button>
              </div>
              <hr className="divider-line" />
              <div>
                <span className="mode-lbl">Multiplayer · Up to 15 players</span>
                <p className="mode-desc">Share the link with your group. Everyone joins with their name. The app selects who answers each round.</p>
                <div style={{ marginBottom: ".8rem" }}>
                  <label className="form-lbl">Your Name</label>
                  <input className="form-input" placeholder="e.g. Sarah" value={nameInput}
                    onChange={e => setNameInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && joinMulti()} autoComplete="off" />
                  {joinError && <p className="err">{joinError}</p>}
                </div>
                <button className="btn-gold" onClick={joinMulti}>Join Game →</button>
              </div>
            </div>
          </div>
        )}

        {/* SOLO */}
        {screen === "solo" && soloQ && (
          <div className="solo-wrap">
            <div style={{ textAlign: "center", marginBottom: "1.2rem" }}>
              <span className="solo-badge">Solo Mode</span>
            </div>
            <div className={`q-card ${flipping ? "flip" : ""}`}>
              <span className="q-num">#{soloQ.id}</span>
              <div className="q-source">
                <div className={`q-dot ${soloQ.type === "ai" ? "ai" : soloQ.type === "community" ? "comm" : ""}`} />
                <span className="q-src-lbl">{soloQ.type === "ai" ? "AI Generated" : soloQ.author ? `Added by ${soloQ.author}` : "Jeff's Original"}</span>
              </div>
              <p className="q-text">{soloQ.text}</p>
              {soloQ.hint && <div className="q-hint">💡 {soloQ.hint}</div>}
              <div className="rating-wrap">
                {!soloJustRated ? (<>
                  <p className="rating-lbl">Rate this question</p>
                  <div className="stars">
                    {[1, 2, 3, 4, 5].map(n => (
                      <span key={n} className={`star ${n <= soloStarHover ? "hl" : ""}`}
                        onMouseEnter={() => setSoloStarHover(n)} onMouseLeave={() => setSoloStarHover(0)}
                        onClick={() => soloRate(n)}>★</span>
                    ))}
                  </div>
                  {soloRatingCount > 0 && <p className="rating-avg">Avg: {soloRating} ★ · {soloRatingCount} rating{soloRatingCount !== 1 ? "s" : ""}</p>}
                </>) : (
                  <p className="rating-done">Rated! {soloRatingCount} total rating{soloRatingCount !== 1 ? "s" : ""}</p>
                )}
              </div>
            </div>
            <div className="actions">
              <button className="btn-ghost" onClick={soloSkip}>Skip</button>
              <button className="btn-gold" style={{ width: "auto" }} onClick={soloNext}>Next Question →</button>
            </div>
          </div>
        )}

        {/* LOBBY */}
        {screen === "lobby" && (
          <div className="lobby-wrap">
            <div className="card">
              <p className="card-title">Waiting for Players</p>
              <p className="p-count">{players.length} / 15 joined</p>
              <div className="player-list">
                {players.map(p => (
                  <div key={p.id} className={`p-chip ${p.id === myId ? "me" : ""}`}>
                    {p.name}{p.id === myId ? " (you)" : ""}
                  </div>
                ))}
              </div>
              {players.length < 2 && <p style={{ fontSize: ".78rem", color: "var(--muted)", fontStyle: "italic", marginBottom: "1rem" }}>Waiting for at least 2 players…</p>}
              {isHost ? (<>
                <p style={{ fontSize: ".73rem", color: "var(--muted)", fontStyle: "italic", marginBottom: ".8rem" }}>As the first player, you start the game when everyone is ready.</p>
                <button className="btn-gold" onClick={startGame} disabled={players.length < 2} style={{ width: "auto" }}>Start Game →</button>
              </>) : (
                <p style={{ fontSize: ".8rem", color: "var(--muted)", fontStyle: "italic" }}>Waiting for {players[0]?.name || "the host"} to start…</p>
              )}
            </div>
          </div>
        )}

        {/* GAME */}
        {screen === "game" && gameState && (
          <div className="game-wrap">
            <div className="ticker">
              {players.map(p => (
                <div key={p.id} className={`t-chip ${p.id === gameState.questioner ? "q" : p.id === gameState.answerer ? "a" : ""}`}>
                  {p.name}{p.id === myId ? " ✦" : ""}
                </div>
              ))}
            </div>
            <div className="role-bar">
              <div className="role-item">
                <p className="role-lbl">🎤 Questioner</p>
                <p className={`role-name ${amQuestioner ? "me" : ""}`}>{questioner?.name}{amQuestioner ? " (you!)" : ""}</p>
              </div>
              <div className="role-sep" />
              <div className="role-item">
                <p className="role-lbl">💬 Answering</p>
                <p className={`role-name ${amAnswerer ? "me" : ""}`}>{answerer?.name}{amAnswerer ? " (you!)" : ""}</p>
              </div>
              <div className="role-sep" />
              <div className="role-item">
                <p className="role-lbl">Round</p>
                <p className="round-lbl">#{gameState.round}</p>
              </div>
            </div>
            {currentQ && (
              <div className={`q-card ${flipping ? "flip" : ""}`}>
                <span className="q-num">#{currentQ.id}</span>
                <div className="q-source">
                  <div className={`q-dot ${currentQ.type === "ai" ? "ai" : currentQ.type === "community" ? "comm" : ""}`} />
                  <span className="q-src-lbl">{currentQ.type === "ai" ? "AI Generated" : currentQ.author ? `Added by ${currentQ.author}` : "Jeff's Original"}</span>
                </div>
                <p className="q-text">{currentQ.text}</p>
                {currentQ.hint && <div className="q-hint">💡 {currentQ.hint}</div>}
                <div className="rating-wrap">
                  {!justRated ? (<>
                    <p className="rating-lbl">Rate this question</p>
                    <div className="stars">
                      {[1, 2, 3, 4, 5].map(n => (
                        <span key={n} className={`star ${n <= starHover ? "hl" : ""}`}
                          onMouseEnter={() => setStarHover(n)} onMouseLeave={() => setStarHover(0)}
                          onClick={() => rateQ(n)}>★</span>
                      ))}
                    </div>
                    {currentRatingCount > 0 && <p className="rating-avg">Avg: {currentRating} ★ · {currentRatingCount} rating{currentRatingCount !== 1 ? "s" : ""}</p>}
                  </>) : (
                    <p className="rating-done">Rated! {currentRatingCount} total</p>
                  )}
                </div>
              </div>
            )}
            <div className="actions">
              <button className="btn-ghost" onClick={skipQ}>Skip</button>
              <button className="btn-gold" style={{ width: "auto" }} onClick={nextQuestion}>Next Question →</button>
            </div>
            {amQuestioner && <p style={{ textAlign: "center", fontSize: ".72rem", color: "var(--muted)", marginTop: ".9rem", fontStyle: "italic" }}>You're reading the question aloud. {answerer?.name} answers next.</p>}
            {amAnswerer && <p style={{ textAlign: "center", fontSize: ".72rem", color: "#e8a0b0", marginTop: ".9rem", fontStyle: "italic" }}>It's your turn to answer — then you become the Questioner.</p>}
          </div>
        )}

        {/* HOW TO PLAY MODAL */}
        {showInstructions && (
          <div className="overlay" onClick={e => e.target === e.currentTarget && setShowInstructions(false)}>
            <div className="modal">
              <button className="modal-close" onClick={() => setShowInstructions(false)}>✕</button>
              <h2 className="modal-title">How to Play</h2>
              <p className="modal-body">{instructionsText}</p>
            </div>
          </div>
        )}

        {/* ABOUT MODAL */}
        {showAbout && (
          <div className="overlay" onClick={e => e.target === e.currentTarget && setShowAbout(false)}>
            <div className="modal">
              <button className="modal-close" onClick={() => setShowAbout(false)}>✕</button>
              <h2 className="modal-title">About</h2>
              <div className="modal-quote">"You know this gives me hope — I really believe this society doesn't know how to converse anymore... the last few dates I've gone on, the guy didn't know a thing about me by the end."</div>
              <p className="modal-body">{aboutText}</p>
            </div>
          </div>
        )}

        {/* ADMIN MODAL */}
        {showAdmin && (
          <div className="overlay" onClick={e => e.target === e.currentTarget && setShowAdmin(false)}>
            <div className="modal">
              <button className="modal-close" onClick={() => setShowAdmin(false)}>✕</button>
              <h2 className="modal-title">Admin Panel</h2>
              {!adminAuthed ? (
                <div>
                  <p style={{ fontSize: ".8rem", color: "var(--muted)", marginBottom: "1rem", fontStyle: "italic" }}>Enter the admin password to continue.</p>
                  <div style={{ marginBottom: ".8rem" }}>
                    <label className="form-lbl">Password</label>
                    <input className="form-input" type="password" value={adminPw} onChange={e => setAdminPw(e.target.value)} onKeyDown={e => e.key === "Enter" && adminLogin()} placeholder="••••••••" />
                  </div>
                  {adminError && <p className="err">{adminError}</p>}
                  <button className="btn-gold" style={{ width: "auto" }} onClick={adminLogin}>Unlock →</button>
                </div>
              ) : (<>
                <div className="tab-bar">
                  {[["instructions","How to Play"],["about","About"],["questions","Questions"],["bonus","Bonus Q's"],["stats","Insights"],["settings","Settings"]].map(([key, label]) => (
                    <button key={key} className={`tab ${adminTab === key ? "on" : ""}`} onClick={() => setAdminTab(key)}>{label}</button>
                  ))}
                </div>

                {adminTab === "instructions" && (
                  <div>
                    <p className="sec-title">Edit "How to Play" Text</p>
                    <p style={{ fontSize: ".73rem", color: "var(--muted)", marginBottom: ".8rem", fontStyle: "italic" }}>This is what players see when they tap "How to Play."</p>
                    <textarea className="form-textarea" value={editInstructions} onChange={e => setEditInstructions(e.target.value)} style={{ minHeight: "220px" }} />
                    <div style={{ display: "flex", gap: ".6rem", marginTop: ".8rem" }}>
                      <button className="btn-gold btn-sm" onClick={saveInstructions}>Save</button>
                      <button className="btn-ghost btn-sm" onClick={() => setEditInstructions(instructionsText)}>Reset</button>
                    </div>
                  </div>
                )}

                {adminTab === "about" && (
                  <div>
                    <p className="sec-title">Edit About Text</p>
                    <textarea className="form-textarea" value={editAbout} onChange={e => setEditAbout(e.target.value)} style={{ minHeight: "200px" }} />
                    <div style={{ display: "flex", gap: ".6rem", marginTop: ".8rem" }}>
                      <button className="btn-gold btn-sm" onClick={saveAbout}>Save</button>
                      <button className="btn-ghost btn-sm" onClick={() => setEditAbout(aboutText)}>Reset</button>
                    </div>
                  </div>
                )}

                {adminTab === "questions" && (
                  <div>
                    <p className="sec-title">Community Questions ({customQuestions.length})</p>
                    {!showAddQ ? (
                      <button className="btn-red btn-sm" style={{ marginBottom: "1rem" }} onClick={() => setShowAddQ(true)}>＋ Add Question</button>
                    ) : (
                      <div style={{ background: "rgba(201,146,58,.05)", border: "1px solid rgba(201,146,58,.13)", borderRadius: "3px", padding: "1rem", marginBottom: "1rem" }}>
                        <div style={{ marginBottom: ".7rem" }}><label className="form-lbl">Question *</label><textarea className="form-textarea" style={{ minHeight: "65px" }} value={newQText} onChange={e => setNewQText(e.target.value)} placeholder="Your question…" /></div>
                        <div style={{ marginBottom: ".7rem" }}><label className="form-lbl">Hint (optional)</label><input className="form-input" value={newQHint} onChange={e => setNewQHint(e.target.value)} placeholder="Short context or caveat…" /></div>
                        <div style={{ marginBottom: ".9rem" }}><label className="form-lbl">Author</label><input className="form-input" value={newQAuthor} onChange={e => setNewQAuthor(e.target.value)} placeholder="e.g. Sarah" /></div>
                        <div style={{ display: "flex", gap: ".6rem" }}>
                          <button className="btn-gold btn-sm" onClick={addCustomQ}>Add</button>
                          <button className="btn-ghost btn-sm" onClick={() => setShowAddQ(false)}>Cancel</button>
                        </div>
                      </div>
                    )}
                    {customQuestions.length === 0 && <p className="empty">No community questions yet.</p>}
                    {customQuestions.map(q => editQ?.id === q.id ? (
                      <div key={q.id} style={{ background: "rgba(201,146,58,.05)", border: "1px solid rgba(201,146,58,.18)", borderRadius: "3px", padding: ".85rem", marginBottom: ".6rem" }}>
                        <div style={{ marginBottom: ".6rem" }}><label className="form-lbl">Question</label><textarea className="form-textarea" style={{ minHeight: "60px" }} value={editQ.text} onChange={e => setEditQ({ ...editQ, text: e.target.value })} /></div>
                        <div style={{ marginBottom: ".6rem" }}><label className="form-lbl">Hint</label><input className="form-input" value={editQ.hint || ""} onChange={e => setEditQ({ ...editQ, hint: e.target.value || null })} /></div>
                        <div style={{ marginBottom: ".8rem" }}><label className="form-lbl">Author</label><input className="form-input" value={editQ.author || ""} onChange={e => setEditQ({ ...editQ, author: e.target.value })} /></div>
                        <div style={{ display: "flex", gap: ".6rem" }}><button className="btn-gold btn-sm" onClick={saveEditQ}>Save</button><button className="btn-ghost btn-sm" onClick={() => setEditQ(null)}>Cancel</button></div>
                      </div>
                    ) : (
                      <div key={q.id} className="q-row">
                        <div style={{ flex: 1 }}><p className="q-row-text">{q.text}</p><p className="q-row-meta">by {q.author}{getAvgRating(q.id) ? ` · ${getAvgRating(q.id)} ★` : " · unrated"}</p></div>
                        <div style={{ display: "flex", gap: ".3rem" }}><button className="icon-btn" onClick={() => setEditQ({ ...q })}>✎</button><button className="icon-btn del" onClick={() => deleteCustomQ(q.id)}>✕</button></div>
                      </div>
                    ))}
                  </div>
                )}

                {adminTab === "bonus" && (
                  <div>
                    <p className="sec-title">Bonus Questions ({BONUS_QUESTIONS.length})</p>
                    <p className="ai-note">25 curated bonus questions in the spirit of Jeff's originals — always active and mixed into the deck. Highly rated questions come up more often; frequently skipped ones fade into the background.</p>
                    <div className="hr" />
                    {BONUS_QUESTIONS.map(q => (
                      <div key={q.id} className="q-row">
                        <div style={{ flex: 1 }}>
                          <p className="q-row-text">{q.text}</p>
                          {q.hint && <p className="q-row-meta">💡 {q.hint}</p>}
                          <p className="q-row-meta">{getAvgRating(q.id) ? `${getAvgRating(q.id)} ★ · ${ratings[q.id]?.count || 0} ratings` : "unrated"}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {adminTab === "stats" && (
                  <div>
                    <p className="sec-title">Top Rated</p>
                    {allQ.filter(q => ratings[q.id]?.count > 0).sort((a, b) => (ratings[b.id].total / ratings[b.id].count) - (ratings[a.id].total / ratings[a.id].count)).slice(0, 8).map(q => (
                      <div key={q.id} className="stat-row"><span style={{ flex: 1, fontSize: ".76rem" }}>{q.text.slice(0, 85)}{q.text.length > 85 ? "…" : ""}</span><span className="stat-badge">{getAvgRating(q.id)} ★ · {ratings[q.id].count}</span></div>
                    ))}
                    {allQ.filter(q => ratings[q.id]?.count > 0).length === 0 && <p className="empty">No ratings yet.</p>}
                    <div className="hr" />
                    <p className="sec-title">Most Skipped</p>
                    {allQ.filter(q => (ratings[q.id]?.skips || 0) > 0).sort((a, b) => (ratings[b.id]?.skips || 0) - (ratings[a.id]?.skips || 0)).slice(0, 5).map(q => (
                      <div key={q.id} className="stat-row"><span style={{ flex: 1, fontSize: ".76rem" }}>{q.text.slice(0, 85)}{q.text.length > 85 ? "…" : ""}</span><span className="stat-badge">{ratings[q.id]?.skips} skips</span></div>
                    ))}
                    {allQ.filter(q => (ratings[q.id]?.skips || 0) > 0).length === 0 && <p className="empty">No skips recorded yet.</p>}
                  </div>
                )}

                {adminTab === "settings" && (
                  <div>
                    <p className="sec-title">Change Admin Password</p>
                    <p style={{ fontSize: ".73rem", color: "var(--muted)", marginBottom: ".7rem", fontStyle: "italic" }}>Stored locally on this device only.</p>
                    <div style={{ marginBottom: ".8rem" }}><label className="form-lbl">New Password</label><input className="form-input" type="password" value={adminPwNew} onChange={e => setAdminPwNew(e.target.value)} placeholder="Enter new password" /></div>
                    <button className="btn-red btn-sm" onClick={() => { ls_set(ADMIN_PW_KEY, adminPwNew); showToast("Password updated!"); setAdminPwNew(""); }} disabled={!adminPwNew.trim()}>Update Password</button>
                    <div className="hr" />
                    <p className="sec-title">Game Management</p>
                    <p style={{ fontSize: ".75rem", color: "var(--muted)", marginBottom: ".7rem", fontStyle: "italic" }}>Use at end of the night to reset for next time.</p>
                    <div style={{ display: "flex", gap: ".6rem", flexWrap: "wrap" }}>
                      <button className="btn-ghost btn-sm" onClick={async () => { await fbSet("players", null); await fbSet("gameState", null); showToast("Players cleared."); }}>Clear All Players</button>
                      <button className="btn-ghost btn-sm" onClick={async () => { await fbSet("ratings", null); showToast("Ratings cleared."); }}>Clear All Ratings</button>
                    </div>
                  </div>
                )}
              </>)}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
