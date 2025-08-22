import React, { useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

type Stroke = {
  x: number;
  y: number;
  color: string;
  size: number;
  type: 'begin' | 'draw' | 'end' | 'clear' | 'fill';
  erase?: boolean;
};

type TurnSummary = {
  word: string | null;
  points: Array<{ id: string; name: string; delta: number; total: number; guessed: boolean; avatar?: { bg: string; emoji?: string; initial?: string } }>;
};

type Player = { id: string; name: string; score: number; guessed: boolean; avatar?: { bg: string; emoji?: string; initial?: string } };

type RoomSettings = {
  maxPlayers: number;
  rounds: number;
  turnSeconds: number;
  wordChoicesCount: number;
};

type GameState = {
  code: string;
  players: Player[];
  hostId: string | null;
  currentRound: number;
  currentTurnIndex: number;
  drawerId: string | null;
  word: string | null;
  wordMask: string;
  timeLeft: number;
  started: boolean;
  waitingForChoice?: boolean;
  settings: RoomSettings;
};

// Socket.IO server URL
// Prefer VITE_SERVER_URL when explicitly provided; otherwise use Node server in dev (3001)
// and same-origin only when server is actually serving the client (production).
const serverUrl: string = (() => {
  const envUrl = (import.meta as any).env?.VITE_SERVER_URL as string | undefined;
  if (envUrl && envUrl.trim()) return envUrl.trim();
  if (typeof window !== 'undefined') {
    const loc = window.location;
    // If running via Vite dev (5173) or localhost, default Socket.IO to 3001
    if (loc.port === '5173' || loc.hostname === 'localhost' || loc.hostname === '127.0.0.1') {
      return 'http://localhost:3001';
    }
    // Fallback to same-origin (useful when server serves client in production)
    if ((loc as any).origin) return (loc as any).origin as string;
  }
  return 'http://localhost:3001';
})();

export default function App() {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [inviteMode, setInviteMode] = useState(false);
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [state, setState] = useState<GameState | null>(null);
  const [timer, setTimer] = useState<number>(0);
  const [showSettings, setShowSettings] = useState(false);
  const [uiMuted, setUiMuted] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [overlayClosing, setOverlayClosing] = useState(false);
  // track guessed + scores for confetti at turn end
  const prevDrawerRef = useRef<string | null>(null);
  const prevScoresRef = useRef<Record<string, number>>({});
  const lastMyScoreRef = useRef<number>(0);
  const prevMyGuessedRef = useRef<boolean>(false);
  const guessedThisTurnRef = useRef<boolean>(false);
  const confettiRef = useRef<HTMLDivElement | null>(null);
  const [participants, setParticipants] = useState<Record<string, { name: string; muted: boolean; speaking: boolean }>>({});
  const [wordChoices, setWordChoices] = useState<string[]>([]);
  const [choiceTimer, setChoiceTimer] = useState<number>(10);

  // Detect invite link (?room=CODE) and prefill
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const r = params.get('room');
      if (r) {
        setInviteMode(true);
        setCode(r.toUpperCase());
      } else {
        setInviteMode(false);
      }
    } catch {}
  }, []);
  const autoPickRef = useRef(false);
  const [maskAnim, setMaskAnim] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; text: string; kind?: 'info' | 'success' | 'error' }[]>([]);
  const [avatar, setAvatar] = useState<{ bg: string; emoji?: string; initial?: string }>({ bg: '#FFE8A3', emoji: '🎉' });
  const [turnSummary, setTurnSummary] = useState<TurnSummary | null>(null);
  const summaryTimerRef = useRef<number | null>(null);
  // Refs mirroring state to avoid stale closures in socket callbacks
  const waitingForChoiceRef = useRef<boolean>(false);
  const startedRef = useRef<boolean>(false);
  // Game over modal state
  const [gameOver, setGameOver] = useState<null | { code: string; players: Array<{ id: string; name: string; total: number; avatar?: { bg: string; emoji?: string; initial?: string } }> }>(null);
  // Reactions overlay
  const [reactions, setReactions] = useState<Array<{ id: number; from: string; reaction: string }>>([]);
  const [quickBubbles, setQuickBubbles] = useState<Array<{ id: number; from: string; text: string }>>([]);
  const [showReactPanel, setShowReactPanel] = useState<boolean>(false);
  // After rematch, if I am new host, auto-start once
  const pendingAutoStartRef = useRef<boolean>(false);
  // delay opener for word choices so confetti/score can be seen
  const wordChoicesTimeoutRef = useRef<number | null>(null);
  // current drawing tool for UI highlighting
  const [currentTool, setCurrentTool] = useState<'pen' | 'eraser' | 'fill'>('pen');
  const EMOJI_SET = ['🐷','😎','🤖','🐱','🐶','🦊','🐼','🐵','🐧','🦄','🐯','🐸','🐨','🦁','🐰','🐹','🐻','🐤','🐖','🐳'];

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const drawing = useRef(false);
  const colorRef = useRef('#000000');
  const sizeRef = useRef(4);
  const eraseRef = useRef(false);
  const fillModeRef = useRef(false);
  // local strokes for undo (only for drawer's own emitted ops)
  const localStrokesRef = useRef<Stroke[]>([]);
  const opStartsRef = useRef<number[]>([]);
  // throttle stroke emissions to animation frames
  const strokePendingRef = useRef<Stroke | null>(null);
  const strokeRafRef = useRef<number | null>(null);

  // Voice refs
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteAudioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const analysersRef = useRef<Map<string, AnalyserNode>>(new Map());
  const audioCtxRef = useRef<AudioContext | null>(null);
  const uiAudioCtxRef = useRef<AudioContext | null>(null);

  const socket: Socket = useMemo(() => io(serverUrl, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 500,
    reconnectionDelayMax: 2000,
    timeout: 10000,
    withCredentials: false
  } as any), []);

  useEffect(() => {
    socket.on('connect', () => {});
    socket.on('error_message', (m: string) => {
      // reset pending join on failure
      setJoining(false);
      setOverlayClosing(false);
      setJoined(false);
      showToast(m, 'error');
    });
    socket.on('system_message', (text: string) => {
      setMessages(prev => [...prev, `[System] ${text}`]);
      // Mark that I guessed correctly (used to show end-of-turn confetti only for me)
      if (name && text.toLowerCase().includes('guessed the word') && text.toLowerCase().startsWith(name.toLowerCase())) {
        guessedThisTurnRef.current = true;
      }
    });

    // Lightweight reactions (cap to latest 4 for performance)
    socket.on('reaction', ({ from, reaction }: { from: string; reaction: string }) => {
      const id = Date.now() + Math.random();
      setReactions(prev => {
        const next = [...prev, { id, from, reaction }];
        return next.length > 4 ? next.slice(next.length - 4) : next;
      });
      setTimeout(() => setReactions(prev => prev.filter(r => r.id !== id)), 1400);
    });
    // Quick chat
    socket.on('quick_chat', ({ from, text }: { from: string; text: string }) => {
      const id = Date.now() + Math.random();
      setQuickBubbles(prev => {
        const next = [...prev, { id, from, text }];
        return next.length > 4 ? next.slice(next.length - 4) : next;
      });
      setTimeout(() => setQuickBubbles(prev => prev.filter(r => r.id !== id)), 1400);
    });
    socket.on('chat_message', ({ from, text }: { from: string; text: string }) => setMessages(prev => [...prev, `${from}: ${text}`]));
    socket.on('state_update', (st: GameState) => {
      setState(st);
      setTimer(st.timeLeft);
      waitingForChoiceRef.current = !!st.waitingForChoice;
      startedRef.current = !!st.started;
      // If we were attempting to join, confirm membership
      if (joining) {
        const amIn = !!st.players.find(p => p.id === (socket.id || ''));
        if (amIn) {
          setJoining(false);
        }
      }
      // If we are entering waitingForChoice, cancel any local pending strokes immediately
      if (waitingForChoiceRef.current) {
        drawing.current = false;
        if (strokeRafRef.current != null) {
          cancelAnimationFrame(strokeRafRef.current);
          strokeRafRef.current = null;
        }
        strokePendingRef.current = null;
      }
      // If we requested Play Again, auto-start when I become the host
      if (pendingAutoStartRef.current) {
        if (!st.started && st.hostId === (socket.id || '')) {
          socket.emit('start_game');
          pendingAutoStartRef.current = false;
        } else if (st.started) {
          pendingAutoStartRef.current = false;
        }
      }
      // ensure participants map has latest names
      setParticipants(prev => {
        const next = { ...prev } as Record<string, { name: string; muted: boolean; speaking: boolean }>;
        st.players.forEach(p => {
          if (!next[p.id]) next[p.id] = { name: p.name, muted: false, speaking: false };
          else next[p.id] = { ...next[p.id], name: p.name };
        });
        return next;
      });
      // close choices if not waiting, and clear any pending opener
      if (!st.waitingForChoice) {
        setWordChoices([]);
        if (wordChoicesTimeoutRef.current) {
          clearTimeout(wordChoicesTimeoutRef.current);
          wordChoicesTimeoutRef.current = null;
        }
      }
      // trigger masked word animation on change
      setMaskAnim(true);
      setTimeout(() => setMaskAnim(false), 300);
      // Trigger celebration when my score increases after I guessed
      const me = st.players.find(p => p.id === (socket.id || ''));
      const prevDrawer = prevDrawerRef.current;
      const newDrawer = st.drawerId;
      if (prevDrawer && newDrawer && prevDrawer !== newDrawer) {
        // New turn: reset per-turn flags
        guessedThisTurnRef.current = false;
        prevMyGuessedRef.current = false;
        // Also reset local stroke history to ensure undo only affects current turn
        localStrokesRef.current = [];
        opStartsRef.current = [];
        clearCanvas();
        // cancel any pending stroke
        if (strokeRafRef.current != null) {
          cancelAnimationFrame(strokeRafRef.current);
          strokeRafRef.current = null;
        }
        strokePendingRef.current = null;
      }
      if (me) {
        const prev = prevScoresRef.current[me.id] ?? me.score;
        const delta = me.score - prev;
        const guessedNow = me.guessed;
        const guessedPrev = prevMyGuessedRef.current;
        // Celebrate if: (a) system message already marked me guessed and score rose, or (b) my guessed flag just flipped true and score rose
        if ((guessedThisTurnRef.current || (!guessedPrev && guessedNow)) && delta > 0) {
          celebrate(delta);
          guessedThisTurnRef.current = false; // avoid duplicate in same turn
        }
        prevMyGuessedRef.current = guessedNow;
        lastMyScoreRef.current = me.score;
      }
      // Update previous snapshots
      prevDrawerRef.current = st.drawerId;
      const nextScores: Record<string, number> = {};
      st.players.forEach(p => (nextScores[p.id] = p.score));
      prevScoresRef.current = nextScores;
      redraw();
    });
    socket.on('timer', (t: number) => setTimer(t));
    socket.on('stroke', (s: Stroke) => {
      // ignore strokes during choice phase (no drawing should occur)
      if (waitingForChoiceRef.current) return;
      // When server broadcasts a clear (e.g., new turn/rematch),
      // also reset local stroke stacks to avoid undo replaying old rounds
      if (s.type === 'clear') {
        clearCanvas();
        localStrokesRef.current = [];
        opStartsRef.current = [];
        return;
      }
      applyStroke(s);
    });
    socket.on('canvas_replay', (strokes: Stroke[]) => {
      // Avoid replaying during waitingForChoice or when not started to prevent ghost visuals
      if (waitingForChoiceRef.current || !startedRef.current) return;
      clearCanvas();
      strokes.forEach(applyStroke);
    });
    // Game over summary
    socket.on('game_over', (payload: { code: string; players: Array<{ id: string; name: string; total: number; avatar?: { bg: string; emoji?: string; initial?: string } }> }) => {
      setGameOver(payload);
    });
    // End-of-turn summary
    socket.on('turn_end', (summary: TurnSummary) => {
      setTurnSummary(summary);
      if (summaryTimerRef.current) {
        clearTimeout(summaryTimerRef.current);
        summaryTimerRef.current = null;
      }
      // Keep the summary visible a bit longer
      summaryTimerRef.current = window.setTimeout(() => {
        setTurnSummary(null);
        summaryTimerRef.current = null;
      }, 8200);
    });

    // Voice signaling (registered after socket exists)
    socket.on('voice_user_joined', async (id: string) => {
      if (!localStreamRef.current) return;
      await createPeerConnection(id, true);
    });
    socket.on('voice_user_left', (id: string) => {
      // tear down remote audio and peer
      cleanupPeer(id);
      setParticipants(prev => prev[id] ? { ...prev, [id]: { ...prev[id], speaking: false, muted: true } } : prev);
    });
    socket.on('voice_offer', async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      await createPeerConnection(from, false, sdp);
    });
    socket.on('voice_answer', async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      const pc = peersRef.current.get(from);
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    });
    socket.on('voice_ice', async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      const pc = peersRef.current.get(from);
      if (pc && candidate) await pc.addIceCandidate(new RTCIceCandidate(candidate));
    });
    socket.on('voice_toggle', ({ id, muted }: { id: string; muted: boolean }) => {
      setParticipants((prev: Record<string, { name: string; muted: boolean; speaking: boolean }>) => ({
        ...prev,
        [id]: { ...(prev[id] || { name: id, speaking: false, muted }), muted }
      }));
    });
    // Handled below where other listeners are registered
    // Drawer-only word choices (delay to allow celebration visuals to play)
    socket.on('word_choices', (choices: string[]) => {
      // clear any pending open
      if (wordChoicesTimeoutRef.current) {
        clearTimeout(wordChoicesTimeoutRef.current);
        wordChoicesTimeoutRef.current = null;
      }
      const delayMs = 1200; // 1.2s delay before showing choices
      wordChoicesTimeoutRef.current = window.setTimeout(() => {
        setWordChoices(choices || []);
        wordChoicesTimeoutRef.current = null;
      }, delayMs);
    });
    // Load profile from localStorage, but do NOT prefill name when visiting via invite link
    try {
      const usp = new URLSearchParams(window.location.search);
      const roomParam = usp.get('room');
      const savedName = localStorage.getItem('zoodle_name');
      if (roomParam) {
        setInviteMode(true);
        setCode(roomParam.toUpperCase());
        // Do not prefill name on invite links; let the user type their own
      } else if (savedName) {
        setName(savedName);
      }
      const savedAvatar = localStorage.getItem('zoodle_avatar');
      if (savedAvatar) setAvatar(JSON.parse(savedAvatar));
    } catch {}
    return () => {
      // cleanup any pending choice opener
      if (wordChoicesTimeoutRef.current) {
        clearTimeout(wordChoicesTimeoutRef.current);
        wordChoicesTimeoutRef.current = null;
      }
      socket.off('game_over');
      socket.off('reaction');
      socket.off('quick_chat');
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Emit a rematch request (host only on server)
  function playAgain() {
    pendingAutoStartRef.current = true;
    socket.emit('rematch');
    setGameOver(null);
  }

  // Send a reaction
  function sendReaction(emoji: string) {
    socket.emit('reaction', emoji);
  }

  // Send a quick chat
  function sendQuick(text: string) {
    socket.emit('quick_chat', text);
  }

  // Countdown for the word-choice modal (always 10s visual)
  useEffect(() => {
    const open = !!(state && state.drawerId === socket.id && wordChoices.length > 0);
    if (!open) return;
    autoPickRef.current = false; // reset guard each time modal opens
    setChoiceTimer(10);
    const id = setInterval(() => setChoiceTimer((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [state?.drawerId, wordChoices.length]);

  // Auto-pick when the choice timer hits 0
  useEffect(() => {
    const open = !!(state && state.drawerId === socket.id && wordChoices.length > 0);
    if (!open) return;
    if (choiceTimer === 0 && !autoPickRef.current) {
      autoPickRef.current = true;
      const idx = Math.floor(Math.random() * wordChoices.length);
      const word = wordChoices[idx];
      chooseWord(word);
    }
  }, [choiceTimer, state?.drawerId, wordChoices]);

  // Beep from 5s to 1s on the word-choice countdown
  useEffect(() => {
    const open = !!(state && state.drawerId === socket.id && wordChoices.length > 0);
    if (!open) return;
    if (uiMuted) return;
    if (choiceTimer > 0 && choiceTimer <= 5) {
      // Use sharper tick for urgency
      playTick(true);
    }
  }, [choiceTimer, state?.drawerId, wordChoices.length, uiMuted]);

  // Low-time audio cue (<= 10s each tick, sharper tone in last 5s)
  useEffect(() => {
    if (!state?.started) return;
    if (timer <= 10 && timer > 0) playTick(timer <= 5);
  }, [timer, state?.started]);

  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const was = ctxRef.current;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = w;
      canvas.height = h;
      if (!was) {
        const ctx = canvas.getContext('2d');
        if (ctx) ctxRef.current = ctx;
      }
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [canvasRef.current]);

  function redraw() {
    // noop for now; strokes are kept only on server for replay
  }

  // Voice helpers
  async function ensureAudioContext() {
    if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    return audioCtxRef.current;
  }

  // Lightweight UI beep context (separate from voice)
  async function ensureUiAudioContext() {
    if (!uiAudioCtxRef.current) uiAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    return uiAudioCtxRef.current;
  }

  function playTick(low: boolean) {
    if (uiMuted) return;
    ensureUiAudioContext().then(ctx => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = low ? 980 : 760;
      g.gain.value = 0.001;
      o.connect(g);
      g.connect(ctx.destination);
      const now = ctx.currentTime;
      g.gain.exponentialRampToValueAtTime(low ? 0.12 : 0.06, now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
      o.start();
      o.stop(now + 0.16);
    }).catch(() => {});
  }

  function attachSpeakingDetector(id: string, stream: MediaStream) {
    ensureAudioContext().then(ctx => {
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128; // lighter CPU
      src.connect(analyser);
      analysersRef.current.set(id, analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const interval = setInterval(() => {
        if (!analysersRef.current.has(id)) { clearInterval(interval); return; }
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / data.length);
        const speaking = rms > 0.04; // slightly more sensitive
        setParticipants(prev => prev[id] ? { ...prev, [id]: { ...prev[id], speaking } } : prev);
      }, 80);
    });
  }

  async function createPeerConnection(peerId: string, isInitiator: boolean, remoteOffer?: RTCSessionDescriptionInit) {
    if (peersRef.current.has(peerId)) return peersRef.current.get(peerId)!;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    peersRef.current.set(peerId, pc);

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('voice_ice', { to: peerId, candidate: e.candidate });
    };
    pc.onconnectionstatechange = async () => {
      const st = pc.connectionState;
      if (st === 'failed' || st === 'disconnected') {
        // try ICE restart once
        try {
          const offer = await pc.createOffer({ iceRestart: true });
          await pc.setLocalDescription(offer);
          socket.emit('voice_offer', { to: peerId, sdp: offer });
        } catch {}
      }
      if (st === 'closed') {
        cleanupPeer(peerId);
      }
    };
    pc.ontrack = (ev) => {
      let audio = remoteAudioRefs.current.get(peerId);
      if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        // playsInline for iOS
        audio.setAttribute('playsinline', 'true');
        remoteAudioRefs.current.set(peerId, audio);
        document.body.appendChild(audio);
      }
      audio.srcObject = ev.streams[0];
      // Prompt playback for some browsers' autoplay policies
      (audio as HTMLMediaElement).play?.().catch(() => {});
      // speaking detection for remote
      attachSpeakingDetector(peerId, ev.streams[0]);
      // mark participant presence
      const p = state?.players.find(p => p.id === peerId);
      setParticipants(prev => ({ ...prev, [peerId]: { name: p?.name || peerId, muted: false, speaking: false } }));
    };

    // add local tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => pc.addTrack(t, localStreamRef.current!));
    }

    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('voice_offer', { to: peerId, sdp: offer });
    } else if (remoteOffer) {
      await pc.setRemoteDescription(new RTCSessionDescription(remoteOffer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('voice_answer', { to: peerId, sdp: answer });
    }
    return pc;
  }

  async function toggleMic() {
    try {
      if (!micOn) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
            sampleSize: 16
          }
        });
        localStreamRef.current = stream;
        setMicOn(true);
        // speaking detection for self
        const selfId = socket.id || 'self';
        attachSpeakingDetector(selfId, stream);
        setParticipants(prev => ({ ...prev, [selfId]: { name: name || 'Me', muted: false, speaking: false } }));
        socket.emit('voice_join');
        // connect to existing players
        const others = state?.players.filter(p => p.id !== (socket.id || '')) || [];
        for (const other of others) await createPeerConnection(other.id, true);
        socket.emit('voice_toggle', { muted: false });
      } else {
        localStreamRef.current?.getTracks().forEach(t => t.stop());
        localStreamRef.current = null;
        setMicOn(false);
        // close peer connections but keep pills
        peersRef.current.forEach((pc, id) => { try { pc.close(); } catch {} cleanupPeer(id); });
        peersRef.current.clear();
        analysersRef.current.clear();
        socket.emit('voice_toggle', { muted: true });
        socket.emit('voice_leave');
      }
    } catch (e) {
      showToast('Microphone permission denied or unavailable.', 'error');
    }
  }

  function cleanupPeer(id: string) {
    const pc = peersRef.current.get(id);
    if (pc) {
      try { pc.onicecandidate = null; pc.ontrack = null; pc.onconnectionstatechange = null; pc.close(); } catch {}
    }
    peersRef.current.delete(id);
    const audio = remoteAudioRefs.current.get(id);
    if (audio) {
      try { (audio.srcObject as MediaStream | null)?.getTracks().forEach(t => t.stop()); } catch {}
      audio.remove();
    }
    remoteAudioRefs.current.delete(id);
    analysersRef.current.delete(id);
  }

  function applyStroke(s: Stroke) {
    const ctx = ctxRef.current;
    const canvas = canvasRef.current;
    if (!ctx || !canvas) return;
    if (s.type === 'clear') {
      ctx.clearRect(0,0,canvas.width,canvas.height);
      return;
    }
    if (s.type === 'fill') {
      // perform flood fill at (x,y)
      floodFillAt(Math.floor(s.x), Math.floor(s.y), s.color);
      return;
    }
    ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.size;
    ctx.lineCap = 'round';
    if (s.type === 'begin') {
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
    } else if (s.type === 'draw') {
      ctx.lineTo(s.x, s.y);
      ctx.stroke();
    } else if (s.type === 'end') {
      ctx.closePath();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // Flood fill implementation
  function floodFillAt(x: number, y: number, hex: string) {
    const canvas = canvasRef.current; const ctx = ctxRef.current; if (!canvas || !ctx) return;
    const { width: w, height: h } = canvas;
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const img = ctx.getImageData(0, 0, w, h);
    const data = new Uint32Array(img.data.buffer);
    const idx = (y * w + x);
    const target = data[idx];
    const fill = rgbaFromHex(hex);
    if (target === fill) return;
    const stack: number[] = [idx];
    while (stack.length) {
      const i = stack.pop()!;
      if (data[i] !== target) continue;
      data[i] = fill;
      const px = i % w;
      const py = (i - px) / w;
      if (px > 0) stack.push(i - 1);
      if (px < w - 1) stack.push(i + 1);
      if (py > 0) stack.push(i - w);
      if (py < h - 1) stack.push(i + w);
    }
    ctx.putImageData(img, 0, 0);
  }

  function rgbaFromHex(hex: string) {
    // returns Uint32 color in little-endian ABGR for ImageData view
    let h = hex.replace('#','');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const r = parseInt(h.slice(0,2), 16);
    const g = parseInt(h.slice(2,4), 16);
    const b = parseInt(h.slice(4,6), 16);
    const a = 255;
    // Uint32 view aligns as 0xAABBGGRR in little-endian memory
    return (a << 24) | (b << 16) | (g << 8) | r;
  }

  function handleMouse(e: React.MouseEvent) {
    if (!state || state.drawerId !== socket.id) return;
    if (!state.started || state.waitingForChoice) return; // block drawing when game not active
    const isPrimaryDown = (e.buttons & 1) === 1; // only draw when primary button is pressed
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (fillModeRef.current) {
      if (!isPrimaryDown) return;
      const s: Stroke = { x, y, color: colorRef.current, size: sizeRef.current, type: 'fill' };
      // record operation start
      opStartsRef.current.push(localStrokesRef.current.length);
      localStrokesRef.current.push(s);
      applyStroke(s);
      socket.emit('stroke', s);
      return;
    }
    // If not currently drawing and mouse button isn't down, ignore hover moves
    if (!drawing.current && !isPrimaryDown) return;
    const s: Stroke = {
      x, y,
      color: colorRef.current,
      size: sizeRef.current,
      type: drawing.current ? 'draw' : 'begin',
      erase: eraseRef.current
    };
    if (!drawing.current) {
      // path start
      opStartsRef.current.push(localStrokesRef.current.length);
    }
    drawing.current = true;
    scheduleStroke(s);
  }

  function handleMouseUp() {
    if (!state || state.drawerId !== socket.id) return;
    const wasDrawing = drawing.current;
    drawing.current = false;
    // cancel any pending RAF stroke to avoid delayed ghost draws
    if (strokeRafRef.current != null) {
      cancelAnimationFrame(strokeRafRef.current);
      strokeRafRef.current = null;
    }
    strokePendingRef.current = null;
    if (!wasDrawing) return;
    const endS = { x: 0, y: 0, color: '', size: 0, type: 'end' } as Stroke;
    socket.emit('stroke', endS);
    localStrokesRef.current.push(endS);
  }

  function scheduleStroke(s: Stroke) {
    strokePendingRef.current = s;
    if (strokeRafRef.current != null) return;
    strokeRafRef.current = requestAnimationFrame(() => {
      const sp = strokePendingRef.current;
      strokePendingRef.current = null;
      strokeRafRef.current = null;
      if (!sp) return;
      // Validate draw is still allowed before applying/emitting to avoid ghost strokes
      const isDrawer = !!(state && state.drawerId === (socket.id || ''));
      const canDraw = startedRef.current && !waitingForChoiceRef.current && isDrawer;
      if (!canDraw) return;
      // If mouse was released, ignore further 'draw' frames
      if (!drawing.current && (sp.type === 'draw')) return;
      applyStroke(sp);
      socket.emit('stroke', sp);
      localStrokesRef.current.push(sp);
    });
  }

  // Global cancel guards to prevent lingering strokes when pointer is released outside canvas
  useEffect(() => {
    const cancel = () => {
      drawing.current = false;
      if (strokeRafRef.current != null) {
        cancelAnimationFrame(strokeRafRef.current);
        strokeRafRef.current = null;
      }
      strokePendingRef.current = null;
    };
    const vis = () => { if (document.hidden) cancel(); };
    window.addEventListener('mouseup', cancel);
    window.addEventListener('touchend', cancel);
    window.addEventListener('pointerup', cancel);
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('mouseup', cancel);
      window.removeEventListener('touchend', cancel);
      window.removeEventListener('pointerup', cancel);
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('blur', cancel);
    };
  }, []);

  function clearCanvas() {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return;
    ctx.clearRect(0,0,canvas.width,canvas.height);
  }

  function clearAll() {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    // reset local stacks
    localStrokesRef.current = [];
    opStartsRef.current = [];
    socket.emit('stroke', { x: 0, y: 0, color: '', size: 0, type: 'clear' } as Stroke);
    clearCanvas();
  }

  function undoLast() {
    if (!state || state.drawerId !== socket.id) return;
    if (opStartsRef.current.length === 0) { showToast('Nothing to undo', 'error'); return; }
    const start = opStartsRef.current.pop()!;
    localStrokesRef.current = localStrokesRef.current.slice(0, start);
    // clear and replay remaining local strokes to sync all clients
    const clr = { x: 0, y: 0, color: '', size: 0, type: 'clear' } as Stroke;
    socket.emit('stroke', clr);
    clearCanvas();
    for (const s of localStrokesRef.current) {
      applyStroke(s);
      socket.emit('stroke', s);
    }
  }

  function join() {
    if (!name || !code) { showToast('Enter name and room code', 'error'); return; }
    const payload = { code, name: (name || '').slice(0, 9), avatar };
    try {
      localStorage.setItem('zoodle_name', name);
      localStorage.setItem('zoodle_avatar', JSON.stringify(avatar));
    } catch {}
    setJoining(true);
    socket.emit('join_room', payload);
  }

  function send() {
    if (!input) return;
    // prevent drawer from guessing
    if (state && state.drawerId === socket.id) return;
    socket.emit('chat_message', input);
    setInput('');
  }

  function startGame() {
    socket.emit('start_game');
  }

  function generateCode(len = 6) {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
    setCode(out);
  }

  // Shareable invite link
  function copyInvite() {
    const room = state?.code || code;
    if (!room) return;
    const url = `${window.location.origin}?room=${room}`;
    navigator.clipboard.writeText(url);
    showToast('Invite link copied!', 'success');
  }

  function chooseWord(w: string) {
    socket.emit('choose_word', w);
    setWordChoices([]);
  }

  // Toast helper
  function showToast(text: string, kind: 'info' | 'success' | 'error' = 'info') {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, text, kind }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 2600);
  }

  // Local celebration (no socket): confetti rain + score pop for the local user
  function celebrate(delta: number) {
    const host = confettiRef.current || document.body;
    // Score pop in center
    const pop = document.createElement('div');
    pop.className = 'score-pop';
    pop.textContent = `+${delta}`;
    host.appendChild(pop);
    setTimeout(() => pop.remove(), 2100);

    // Confetti pieces
    const colors = ['#FF5757', '#FFC107', '#22C55E', '#60A5FA', '#A78BFA', '#F472B6'];
    const count = 90;
    const pieces: HTMLDivElement[] = [];
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'confetti-piece';
      el.style.left = Math.random() * 100 + 'vw';
      el.style.background = colors[i % colors.length];
      el.style.transform = `rotate(${Math.random() * 360}deg)`;
      el.style.animationDelay = (Math.random() * 0.4).toFixed(2) + 's';
      el.style.opacity = String(0.7 + Math.random() * 0.3);
      // slightly larger pieces
      el.style.width = 8 + Math.floor(Math.random() * 6) + 'px'; // 8-13px
      el.style.height = 14 + Math.floor(Math.random() * 8) + 'px'; // 14-21px
      host.appendChild(el);
      pieces.push(el);
    }
    // Cleanup after animation
    setTimeout(() => pieces.forEach(p => p.remove()), 2600);
  }

  return (
    <div className={`app ${overlayClosing ? 'reveal-open' : ''}`}>
      <header className="header">
        <div className="logo">Zoodle</div>
        <div className="center-word">
          <div className="center-stack">
            <div className="center-row">
              <div className={`masked-word ${maskAnim ? 'reveal' : ''}`}>
                {state
                  ? (state.drawerId === socket.id
                      ? (state.waitingForChoice ? '' : (state.word || ''))
                      : renderWordMask(state.wordMask || ''))
                  : ''}
              </div>
            </div>
          </div>
        </div>
        <div className="meta">
          {state?.started && skProgressTimer(timer, state?.settings.turnSeconds || 1)}
          <button className="icon-btn" title="Settings" onClick={() => setShowSettings(true)}>⚙️</button>
          <div className="badge">Round: {state?.currentRound ?? 0}</div>
          {state && <button className="invite-btn" onClick={copyInvite}>Invite</button>}
        </div>
      </header>

      <aside className="sidebar">
        {!state && (
          <div className="list" style={{ padding: 12 }}>
            <div className="section-title">Welcome</div>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>Create or join a room using the overlay.</div>
          </div>
        )}

        {state && (
          <>
            <div>
              <div className="section-title">Players</div>
              <div className="list">
                {[...state.players].sort((a,b) => b.score - a.score).map((p, idx) => (
                  <div key={p.id} className={`player row-${idx%2}`}>
                    <div style={{ display:'flex', alignItems:'flex-start', gap:8, width:'100%', justifyContent:'space-between' }}>
                      <div style={{ display:'flex', alignItems:'flex-start', gap:8 }}>
                        <span className={`rank rank-${idx+1}`}>{idx+1}</span>
                        <span className={`avatar emoji-only ${participants[p.id]?.speaking ? 'speaking' : ''}`}>{p.avatar?.emoji || (p.name ? p.name[0].toUpperCase() : '🙂')}</span>
                        <div style={{ display:'flex', flexDirection:'column', minWidth:0 }}>
                          <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'nowrap', minWidth:0, padding:'0 10px 0 0' }}>
                            <span className={`player-name ${p.guessed ? 'guessed' : ''}`} style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:'140px' }}>{p.name}</span>
                            {p.id === (socket.id || '') && <span className="chip" title="This is you">You</span>}
                            {p.id === state.drawerId && <span className="brush bounce" title="Drawing" style={{ marginLeft: -4 }}>🖌️</span>}
                            {participants[p.id]?.muted ? <span className="muted" title="Muted">🔇</span> : ''}
                          </div>
                          <div className="player-score">{p.score}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Start button moved into Host Settings panel footer */}

            {/* Host Settings */}
            {state && state.hostId === socket.id && !state.started && (
              <div style={{ marginTop: 12 }}>
                <div className="section-title">Settings (Host)</div>
                <div className="list" style={{ padding: 12, display: 'grid', gap: 10 }}>
                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span>Rounds</span>
                    <select defaultValue={state.settings.rounds} onChange={(e) => {
                      const v = Number(e.target.value);
                      socket.emit('update_settings', { rounds: v });
                      showToast(`Rounds set to ${v}`, 'success');
                    }} style={{ width: 140, padding: 8, borderRadius: 10, border: '1px solid var(--border)' }}>
                      {[1,2,3,5,7,10].map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span>Turn Time (s)</span>
                    <select defaultValue={state.settings.turnSeconds} onChange={(e) => {
                      const v = Number(e.target.value);
                      socket.emit('update_settings', { turnSeconds: v });
                      showToast(`Turn time set to ${v}s`, 'success');
                    }} style={{ width: 140, padding: 8, borderRadius: 10, border: '1px solid var(--border)' }}>
                      {[30,45,60,90,120,150,180].map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span>Word choices</span>
                    <select defaultValue={state.settings.wordChoicesCount || 3} onChange={(e) => {
                      const v = Number(e.target.value);
                      socket.emit('update_settings', { wordChoicesCount: v });
                      showToast(`Word choices set to ${v}`, 'success');
                    }} style={{ width: 140, padding: 8, borderRadius: 10, border: '1px solid var(--border)' }}>
                      {[2,3,5].map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </label>
                  {/* Footer action: big Start Game button */}
                  <div className="host-settings-actions" style={{ marginTop: 6 }}>
                    <button className="start-big" onClick={startGame}>Start Game</button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </aside>

      <main className="stage">
        <canvas
          ref={canvasRef}
          className="canvas"
          style={{ cursor: state?.drawerId === socket.id ? 'crosshair' : 'not-allowed' }}
          onMouseDown={handleMouse}
          onMouseMove={(e) => drawing.current && handleMouse(e)}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        />
        {state?.drawerId === socket.id && (
          <div className="colorbar">
            <button className={`tool-btn ${currentTool === 'pen' ? 'active' : ''}`} onClick={() => { eraseRef.current = false; fillModeRef.current = false; setCurrentTool('pen'); }} title="Pen">🖊️</button>
            <button className={`tool-btn ${currentTool === 'eraser' ? 'active' : ''}`} onClick={() => { eraseRef.current = true; fillModeRef.current = false; setCurrentTool('eraser'); }} title="Eraser">🧽</button>
            <button className={`tool-btn ${currentTool === 'fill' ? 'active' : ''}`} onClick={() => { eraseRef.current = false; fillModeRef.current = true; setCurrentTool('fill'); }} title="Fill bucket">🪣</button>
            <input type="range" min={2} max={24} defaultValue={sizeRef.current} onChange={e => (sizeRef.current = Number(e.target.value))} title="Brush size" />
            <input type="color" defaultValue={colorRef.current} onChange={e => (colorRef.current = e.target.value)} title="Color" />
            <div className="swatches">
              {["#000000","#ff4757","#ffa502","#2ed573","#1e90ff","#7c5cff","#ffffff"].map((c) => (
                <button key={c} className={`swatch ${c === '#ffffff' ? 'swatch-white' : ''}`} onClick={() => { colorRef.current = c; eraseRef.current = false; }} title={c} style={{ background: c }} />
              ))}
            </div>
            <button onClick={undoLast} title="Undo last">↶ Undo</button>
            <button onClick={clearAll} title="Clear Canvas">Clear</button>
          </div>
        )}
        {state && state.drawerId !== socket.id && (
          <div className="reactbar">
            <button className="react-trigger" onClick={() => setShowReactPanel(v => !v)} title="Reactions" aria-label="Reactions">❤️</button>
            {showReactPanel && (
              <div className="react-panel">
                <div style={{ display:'flex', gap:8 }}>
                  {['🎉','👏','🔥','😂','😮','👍','❤️','😢','😡','🤯'].map(em => (
                    <button key={em} className="react-item" onClick={() => { sendReaction(em); setShowReactPanel(false); }} title={em}>{em}</button>
                  ))}
                </div>
                <div style={{ width:1, background:'var(--border)', margin:'0 8px' }} />
                <div style={{ display:'flex', gap:6 }}>
                  {['GG','Nice!','Wow!','Hint?','BRB'].map(t => (
                    <button key={t} className="react-item" onClick={() => { sendQuick(t); setShowReactPanel(false); }} title={t}>{t}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {/* Reactions and quick chat overlay (relative to canvas) */}
        <div className="overlay-reactions" aria-live="polite" aria-relevant="additions">
          {reactions.map(r => (
            <div key={r.id} className="reaction-bubble">{r.reaction} <span className="from">{r.from}</span></div>
          ))}
          {quickBubbles.map(b => (
            <div key={b.id} className="quick-bubble"><span className="from">{b.from}:</span> {b.text}</div>
          ))}
        </div>
      </main>

      <section className="chat">
        <div className="chat-log">
          {messages.map((m, i) => {
            const isSystem = m.startsWith('[System]');
            const isGuess = /guessed the word/i.test(m);
            return (
              <div key={i} className={`chat-item ${isSystem ? 'chat-system' : ''} ${isGuess ? 'chat-guess' : ''}`}>{m}</div>
            );
          })}
        </div>
        <div className="chat-input">
          <button className={`chat-mic-btn ${micOn ? 'on' : 'off'}`} onClick={toggleMic} title={micOn ? 'Mic on' : 'Mic off'} aria-label="Toggle microphone">{micOn ? '🎤' : '🎙️'}</button>
          <input value={input} disabled={!!(state && state.drawerId === socket.id)} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} placeholder={state && state.drawerId === socket.id ? 'You are drawing…' : 'Type your guess...'} />
          <button className="chat-send-btn" onClick={send} disabled={!!(state && state.drawerId === socket.id)} title="Send" aria-label="Send">✈️</button>
        </div>
      </section>

      {/* Start Overlay: shown until user joins a room */}
      {(!joined || !state) && (
        <div className={`start-overlay ${overlayClosing || joined ? 'fade-out' : ''}`}>
          <div className="start-card funky-card">
            <div className="brand-hero" aria-hidden="true">Zoodle</div>
            <div className="start-title">{inviteMode ? 'Join Game' : 'Create Game'}</div>
            <div className="start-sub">Play from a single link. No separate setup.</div>
            <div className="form start-form" style={{ maxWidth: 560 }}>
              <div className="row">
                <input className="input" placeholder="Your name" value={name} maxLength={9} onChange={e => setName(e.target.value.slice(0, 9))} />
              </div>
              <div className="row two">
                <input className={`input code ${inviteMode ? 'readonly' : ''}`} placeholder="Room code" value={code}
                       readOnly={inviteMode}
                       onChange={e => { if (inviteMode) return; setCode(e.target.value.toUpperCase()); }} />
                <button
                  className="btn new-code"
                  onClick={() => generateCode()}
                  title={inviteMode ? 'Disabled when joining by link' : 'Generate new code'}
                  disabled={inviteMode}
                >
                  New Code
                </button>
              </div>
              <div className="row avatar-row">
                <div className="section-title">Choose Avatar</div>
                <div className="avatar-line">
                  <span className={`avatar emoji-only preview`} title="Your avatar">
                    {avatar.emoji || (name ? name[0].toUpperCase() : '🙂')}
                  </span>
                </div>
                <div className="emoji-grid">
                  {EMOJI_SET.map(em => (
                    <button type="button" key={em} className={`emoji-btn ${avatar.emoji === em ? 'active' : ''}`} onClick={() => setAvatar(v => ({ ...v, emoji: em }))}>{em}</button>
                  ))}
                </div>
              </div>
              <div className="start-actions">
                {state && <button type="button" className="btn ghost" onClick={copyInvite} title="Copy invite link">Copy Invite</button>}
                <button
                  className="btn btn-primary go"
                  disabled={!name || !code || joining}
                  onClick={() => {
                    if (!name || !code) { showToast('Enter name and room code', 'error'); return; }
                    // Optimistic UI: close overlay instantly, mark as joined
                    setOverlayClosing(true);
                    setJoined(true);
                    join();
                  }}
                >
                  {joining ? 'Joining…' : (inviteMode ? 'Join Game' : 'Create Game')}
                </button>
              </div>
            </div>
            <div className="start-deco">
              <div className="bubble b1" />
              <div className="bubble b2" />
              <div className="bubble b3" />
            </div>
          </div>
        </div>
      )}

      {/* Game Over Modal with podium and rematch */}
      {gameOver && (
        <div className="modal-backdrop" onClick={() => setGameOver(null)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">Game Over</div>
            </div>
            <div style={{ display:'grid', gap:12 }}>
              {(() => {
                const sorted = [...gameOver.players].sort((a,b)=> b.total - a.total);
                const top = sorted.slice(0,3);
                return (
                  <div className="podium podium-wrap no-border-avatars">
                    {top[1] && (
                      <div className="podium-2">
                        <div className="avatar" style={{ background: top[1].avatar?.bg || '#eee' }}>{top[1].avatar?.emoji || (top[1].name[0] || '🙂')}</div>
                        <div className="podium-name">{top[1].name}</div>
                        <div className="podium-rank">🥈 2nd</div>
                        <div className="podium-points">{top[1].total} pts</div>
                      </div>
                    )}
                    {top[0] && (
                      <div className="podium-1">
                        <div className="avatar" style={{ background: top[0].avatar?.bg || '#eee' }}>{top[0].avatar?.emoji || (top[0].name[0] || '🙂')}</div>
                        <div className="podium-name">{top[0].name}</div>
                        <div className="podium-rank">🥇 1st</div>
                        <div className="podium-points">{top[0].total} pts</div>
                      </div>
                    )}
                    {top[2] && (
                      <div className="podium-3">
                        <div className="avatar" style={{ background: top[2].avatar?.bg || '#eee' }}>{top[2].avatar?.emoji || (top[2].name[0] || '🙂')}</div>
                        <div className="podium-name">{top[2].name}</div>
                        <div className="podium-rank">🥉 3rd</div>
                        <div className="podium-points">{top[2].total} pts</div>
                      </div>
                    )}
                  </div>
                );
              })()}
              <div className="list" style={{ padding:12 }}>
                {[...gameOver.players].sort((a,b)=> b.total - a.total).map((p, i) => (
                  <div key={p.id} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'6px 4px' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                      <span className={`rank rank-${i+1}`}>{i+1}</span>
                      <span className="avatar small" style={{ background: p.avatar?.bg || '#eee' }}>{p.avatar?.emoji || (p.name ? p.name[0].toUpperCase() : '🙂')}</span>
                      <span style={{ fontWeight:700 }}>{p.name}</span>
                    </div>
                    <div style={{ color:'#6b7280' }}>{p.total} pts</div>
                  </div>
                ))}
              </div>
              <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
                {state && state.hostId === socket.id && (
                  <button className="button-primary" onClick={playAgain}>Play Again</button>
                )}
                <button className="invite-btn" onClick={() => setGameOver(null)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* End-of-turn Summary Modal */}
      {turnSummary && (
        <div className="modal-backdrop" onClick={() => setTurnSummary(null)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">Round Over</div>
            </div>
            <div style={{ display:'grid', gap:10 }}>
              <div><strong>Correct word:</strong> {turnSummary.word || '(unknown)'}</div>
              <div className="list no-border-avatars" style={{ padding:12 }}>
                {[...turnSummary.points].sort((a,b)=> b.delta - a.delta).map(p => (
                  <div key={p.id} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'6px 4px' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span className="avatar small" style={{ background: p.avatar?.bg || '#eee' }}>{p.avatar?.emoji || (p.name ? p.name[0].toUpperCase() : '🙂')}</span>
                      <span style={{ fontWeight:800 }}>{p.name}</span>
                      {p.guessed && <span className="chip" style={{ marginLeft:6 }}>guessed</span>}
                    </div>
                    <div style={{ display:'flex', alignItems:'baseline', gap:8 }}>
                      <span style={{ fontWeight:800, color: p.delta>0 ? '#16a34a' : '#6b7280' }}>{p.delta>0?`+${p.delta}`: '+0'}</span>
                      <span style={{ fontSize:12, color:'#6b7280' }}>total {p.total}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ display:'flex', justifyContent:'flex-end' }}>
                <button className="invite-btn" onClick={() => setTurnSummary(null)}>OK</button>
              </div>
            </div>
          </div>
        </div>
      )}

      

      {/* Quickbar removed per request; reactions and quick chats are in the bottom-center panel for guessers. */}


      {/* Word Choice Modal for Drawer */}
      {state && state.drawerId === socket.id && wordChoices.length > 0 && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="modal-header">
              <div className="modal-title">Choose a word to draw</div>
              {skProgressTimer(choiceTimer, 10, { forcePanic: true, size: 48 })}
            </div>
            <div className="choice-grid">
              {wordChoices.map((w, idx) => (
                <div key={idx} className="choice-card" onClick={() => chooseWord(w)}>
                  <div className="choice-emoji">✏️</div>
                  <div className="choice-text">{w}</div>
                </div>
              ))}
            </div>
            <div className="modal-hint">Pick one! Others will only see blanks.</div>
          </div>
        </div>
      )}
      {/* Toasts */}
      <div className="toast-wrap">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.kind || 'info'}`}>{t.text}</div>
        ))}
      </div>
      {/* Quick Settings Modal */}
      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Settings</div>
            <label style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
              <span>UI beeps</span>
              <input type="checkbox" checked={!uiMuted} onChange={(e)=>setUiMuted(!e.target.checked)} />
            </label>
            {state && state.hostId === socket.id && !state.started && (
              <div className="section-title" style={{ marginTop:8 }}>Host quick settings</div>
            )}
            <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
              <button className="invite-btn" onClick={() => setShowSettings(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {/* Confetti overlay mount */}
      <div ref={confettiRef} className="confetti-wrap" aria-hidden="true" />
    </div>
  );
}

// Circular timer element (SVG)
function circleTimer(remaining: number, total: number) {
  const r = 16; const c = 2 * Math.PI * r;
  const ratio = Math.max(0, Math.min(1, total ? remaining / total : 0));
  const dash = c * ratio;
  return (
    <svg className="circle-timer" width="44" height="44" viewBox="0 0 44 44" aria-label={`${remaining}s`}>
      <circle cx="22" cy="22" r={r} className="ct-bg" />
      <circle cx="22" cy="22" r={r} className="ct-fg" strokeDasharray={`${dash} ${c}`} />
      <text x="22" y="24" textAnchor="middle" className="ct-text">{remaining}s</text>
    </svg>
  );
}

// Render masked word with per-letter styling
function renderWordMask(mask: string) {
  if (!mask) return '';
  return (
    <span className="mask-wrap">
      {mask.split('').map((ch, i) => {
        if (ch === ' ') return <span key={i} className="mask-gap"> </span>;
        const isBlank = ch === '_' || ch === '*';
        return (
          <span key={i} className={`mask-letter ${isBlank ? 'blank' : 'reveal'}`}>{isBlank ? '_' : ch}</span>
        );
      })}
    </span>
  );
}

// Skribbl-like circular numeric badge timer
// Circular numeric timer with progress ring
function skProgressTimer(seconds: number, total: number, opts?: { forcePanic?: boolean; size?: number }) {
  const s = Math.max(0, Math.floor(seconds));
  const size = opts?.size ?? 56; // svg size
  const cx = size/2, cy = size/2;
  const r = Math.max(18, Math.floor(size/2 - 6)); // progress radius
  const c = 2 * Math.PI * r;
  const ratio = Math.max(0, Math.min(1, total ? seconds / total : 0));
  const dash = c * ratio;
  const panic = opts?.forcePanic ? true : (seconds <= 15); // start red + shake from 15s remaining
  const cls = `sk-timer funky ${panic ? 'panic' : ''}`;
  const ticks = Array.from({length:12}).map((_,i)=>{
    const a = (-90 + i*30) * Math.PI/180;
    const r1 = r + 1;
    const r2 = r + 5;
    return <line key={`t${i}`} x1={cx + r1*Math.cos(a)} y1={cy + r1*Math.sin(a)} x2={cx + r2*Math.cos(a)} y2={cy + r2*Math.sin(a)} stroke="#1f2937" strokeWidth={i%3===0?2:1} />
  });
  const inner = Math.max(26, size - 22);
  const fontSize = Math.max(14, Math.floor(size/3.3));
  return (
    <div className={cls} title={`${s}s`}>
      <svg className="sk-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {ticks}
        <circle cx={cx} cy={cy} r={r} className="sk-ring-bg" />
        <circle cx={cx} cy={cy} r={r} className="sk-ring-fg" strokeDasharray={`${dash} ${c}`} />
        <circle cx={cx} cy={cy} r={1.8} fill="#1f2937" />
      </svg>
      <div className="sk-circle" style={{ width: inner, height: inner }}>
        <span className="sk-text" style={{ fontSize }}>{s}</span>
      </div>
    </div>
  );
}
