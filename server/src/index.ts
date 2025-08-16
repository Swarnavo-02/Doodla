import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import { RoomManager } from './roomManager';
import { Player, Stroke, TurnSummary } from './types';

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*'}
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const rooms = new RoomManager();

io.on('connection', (socket) => {
  let currentRoom: string | null = null;
  let player: Player | null = null;

  socket.on('join_room', ({ code, name, avatar }: { code: string; name: string; avatar?: { bg: string; emoji?: string; initial?: string } }) => {
    try {
      // Normalize avatar and ensure unique emoji per room
      const EMOJI_SET = ['🎉','😎','🤖','🐱','🐶','🦊','🐼','🐵','🐧','🦄','🐯','🐸','🐨','🦁','🐰','🐹','🐻','🐤','🐙','🐳'];
      const st0 = rooms.createOrGetRoom(code);
      const used = new Set(st0.players.map(pl => pl.avatar?.emoji).filter(Boolean) as string[]);
      let finalAvatar = avatar || { bg: '#FFE8A3', emoji: '😎' };
      if (!finalAvatar.emoji) {
        finalAvatar.emoji = EMOJI_SET.find(e => !used.has(e)) || '🙂';
      } else if (used.has(finalAvatar.emoji)) {
        finalAvatar.emoji = EMOJI_SET.find(e => !used.has(e)) || finalAvatar.emoji;
      }
      const safeName = (name?.trim() || 'Player').slice(0, 9);
      const p: Player = { id: socket.id, name: safeName, score: 0, guessed: false, avatar: finalAvatar };
      rooms.joinRoom(code, p);
      currentRoom = code;
      player = p;
      socket.join(code);

      // send existing canvas and state
      socket.emit('canvas_replay', rooms.getCanvas(code));
      io.to(code).emit('state_update', rooms.createOrGetRoom(code));
    } catch (e: any) {
      socket.emit('error_message', e.message || 'Failed to join');
    }
  });

  // Host updates room settings (rounds, turnSeconds) before/ between games
  socket.on('update_settings', ({ rounds, turnSeconds, wordChoicesCount }: { rounds?: number; turnSeconds?: number; wordChoicesCount?: number }) => {
    if (!currentRoom || !player) return;
    const st = rooms.createOrGetRoom(currentRoom);
    if (st.hostId !== socket.id) return; // only host
    if (st.started) return; // cannot change mid-turn
    if (typeof rounds === 'number' && rounds >= 1 && rounds <= 10) st.settings.rounds = Math.floor(rounds);
    if (typeof turnSeconds === 'number' && turnSeconds >= 20 && turnSeconds <= 300) st.settings.turnSeconds = Math.floor(turnSeconds);
    if (typeof wordChoicesCount === 'number' && [2,3,5].includes(Math.floor(wordChoicesCount))) st.settings.wordChoicesCount = Math.floor(wordChoicesCount);
    io.to(currentRoom).emit('state_update', st);
  });

  // Voice signaling: continuous mic toggle and P2P connections
  socket.on('voice_join', () => {
    if (!currentRoom) return;
    // Notify room that this user is available for voice; others can initiate offers
    socket.to(currentRoom).emit('voice_user_joined', socket.id);
  });

  socket.on('voice_offer', ({ to, sdp }: { to: string; sdp: RTCSessionDescriptionInit }) => {
    io.to(to).emit('voice_offer', { from: socket.id, sdp });
  });

  socket.on('voice_answer', ({ to, sdp }: { to: string; sdp: RTCSessionDescriptionInit }) => {
    io.to(to).emit('voice_answer', { from: socket.id, sdp });
  });

  socket.on('voice_ice', ({ to, candidate }: { to: string; candidate: RTCIceCandidateInit }) => {
    io.to(to).emit('voice_ice', { from: socket.id, candidate });
  });

  socket.on('voice_toggle', ({ muted }: { muted: boolean }) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('voice_toggle', { id: socket.id, muted });
  });

  socket.on('start_game', () => {
    if (!currentRoom || !player) return;
    const st = rooms.createOrGetRoom(currentRoom);
    // Only host can start and only if not already started
    if (st.hostId !== socket.id) return;
    if (st.started) return;
    const state = rooms.nextTurn(currentRoom);
    if (state) {
      // if game just ended, emit game_over summary
      if (!state.started) {
        const final = rooms.createOrGetRoom(currentRoom);
        io.to(currentRoom).emit('game_over', {
          code: currentRoom,
          players: [...final.players].map(p => ({ id: p.id, name: p.name, total: p.score, avatar: p.avatar }))
        });
        io.to(currentRoom).emit('state_update', final);
        return;
      }
      // send a state update (without revealing choices); choices are only known to drawer via separate event
      io.to(currentRoom).emit('state_update', { ...state, wordChoices: undefined });
      // clear all clients' canvases for the new turn
      io.to(currentRoom).emit('stroke', { x: 0, y: 0, color: '', size: 0, type: 'clear' });
      if (state.drawerId) {
        io.to(state.drawerId).emit('word_choices', state.wordChoices || []);
      }
    }
  });

  // Drawer chooses one of the provided words
  socket.on('choose_word', (word: string) => {
    if (!currentRoom || !player) return;
    const st = rooms.chooseWord(currentRoom, player.id, word);
    if (!st) return;
    io.to(currentRoom).emit('state_update', { ...st, wordChoices: undefined });
  });

  socket.on('stroke', (stroke: Stroke) => {
    if (!currentRoom || !player) return;
    const state = rooms.createOrGetRoom(currentRoom);
    if (state.drawerId !== player.id && stroke.type !== 'clear') return; // only drawer can draw
    rooms.applyStroke(currentRoom, stroke);
    socket.to(currentRoom).emit('stroke', stroke);
  });

  socket.on('chat_message', (text: string) => {
    if (!currentRoom || !player) return;
    const res = rooms.tryGuess(currentRoom, player.id, text);
    if (res.correct) {
      io.to(currentRoom).emit('system_message', `${player.name} guessed the word!`);
      io.to(currentRoom).emit('state_update', rooms.createOrGetRoom(currentRoom));
      // if all non-drawers guessed, end turn early
      const state = rooms.createOrGetRoom(currentRoom);
      const nonDrawer = state.players.filter(p => p.id !== state.drawerId);
      if (nonDrawer.length > 0 && nonDrawer.every(p => p.guessed)) {
        // Build and emit turn summary
        const summary: TurnSummary = {
          word: state.word,
          points: state.players.map(p => ({
            id: p.id,
            name: p.name,
            delta: (state.turnStartScores?.[p.id] != null ? p.score - (state.turnStartScores![p.id]) : 0),
            total: p.score,
            guessed: !!p.guessed,
            avatar: p.avatar
          }))
        };
        io.to(currentRoom).emit('turn_end', summary);
        io.to(currentRoom).emit('system_message', `All players guessed! Next turn.`);
        const st = rooms.nextTurn(currentRoom);
        if (st) {
          if (!st.started) {
            const final = rooms.createOrGetRoom(currentRoom);
            io.to(currentRoom).emit('game_over', {
              code: currentRoom,
              players: [...final.players].map(p => ({ id: p.id, name: p.name, total: p.score, avatar: p.avatar }))
            });
            io.to(currentRoom).emit('state_update', final);
          } else {
            io.to(currentRoom).emit('state_update', st);
            io.to(currentRoom).emit('stroke', { x: 0, y: 0, color: '', size: 0, type: 'clear' });
            if (st.drawerId) io.to(st.drawerId).emit('word_choices', st.wordChoices || []);
          }
        }
      }
    } else {
      io.to(currentRoom).emit('chat_message', { from: player.name, text });
      if (res.reveal) io.to(currentRoom).emit('state_update', rooms.createOrGetRoom(currentRoom));
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom && player) {
      rooms.leaveRoom(currentRoom, player.id);
      io.to(currentRoom).emit('state_update', rooms.createOrGetRoom(currentRoom));
    }
  });

  socket.on('rematch', () => {
    if (!currentRoom || !player) return;
    const st = rooms.createOrGetRoom(currentRoom);
    if (st.hostId !== socket.id) return; // only host
    rooms.rematch(currentRoom);
    const fresh = rooms.createOrGetRoom(currentRoom);
    io.to(currentRoom).emit('state_update', fresh);
    const hostName = fresh.players.find(p => p.id === fresh.hostId)?.name || 'Host';
    io.to(currentRoom).emit('system_message', `Rematch ready! ${hostName} is the new host. Press Start Game to begin.`);
  });

  socket.on('reaction', (reaction: string) => {
    if (!currentRoom || !player) return;
    io.to(currentRoom).emit('reaction', { from: player.name, reaction });
  });

  socket.on('quick_chat', (text: string) => {
    if (!currentRoom || !player) return;
    io.to(currentRoom).emit('quick_chat', { from: player.name, text });
  });
});

// turn timer tick
setInterval(() => {
  for (const [code, state] of rooms.rooms) {
    if (!state.started || !state.word || state.waitingForChoice) continue;
    state.timeLeft -= 1;
    // attempt time-based reveal at thresholds (50%, 25%)
    const revealedNow = rooms.maybeReveal(code);
    if (revealedNow) {
      io.to(code).emit('state_update', rooms.createOrGetRoom(code));
    }
    if (state.timeLeft <= 0) {
      // Emit summary before advancing
      const summary: TurnSummary = {
        word: state.word,
        points: state.players.map(p => ({
          id: p.id,
          name: p.name,
          delta: (state.turnStartScores?.[p.id] != null ? p.score - (state.turnStartScores![p.id]) : 0),
          total: p.score,
          guessed: !!p.guessed,
          avatar: p.avatar
        }))
      };
      io.to(code).emit('turn_end', summary);
      const st = rooms.nextTurn(code);
      if (st) {
        if (!st.started) {
          const final = rooms.createOrGetRoom(code);
          io.to(code).emit('game_over', {
            code,
            players: [...final.players].map(p => ({ id: p.id, name: p.name, total: p.score, avatar: p.avatar }))
          });
          io.to(code).emit('state_update', final);
        } else {
          io.to(code).emit('system_message', 'Time up! Next turn.');
          io.to(code).emit('state_update', { ...st, wordChoices: undefined });
          io.to(code).emit('stroke', { x: 0, y: 0, color: '', size: 0, type: 'clear' });
          if (st.drawerId) io.to(st.drawerId).emit('word_choices', st.wordChoices || []);
        }
      }
    } else {
      io.to(code).emit('timer', state.timeLeft);
    }
  }
}, 1000);

app.get('/', (_req, res) => res.send('Scribal server running'));

server.listen(PORT, () => {
  const host = process.env.RENDER ? '0.0.0.0' : 'localhost';
  console.log(`Server listening on http://${host}:${PORT}`);
});
