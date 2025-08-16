import { GameState, Player, RoomSettings, Stroke } from './types';

const WORDS = [
  'apple','house','tree','car','phone','cat','dog','river','mountain','sun','moon','star','book','chair','shoe','pizza','guitar','computer','bottle','plane'
];

export class RoomManager {
  rooms: Map<string, GameState> = new Map();
  canvases: Map<string, Stroke[]> = new Map();

  private isLetter(ch: string) {
    return /[A-Za-z]/.test(ch);
  }

  private isVowel(ch: string) {
    return /[AEIOUaeiou]/.test(ch);
  }

  private computeMask(word: string, revealed: number[] = []) {
    const revealedSet = new Set(revealed);
    return word
      .split('')
      .map((ch, i) => {
        if (!this.isLetter(ch)) return ch; // keep spaces/dashes/punct
        return revealedSet.has(i) ? ch : '_';
      })
      .join('');
  }

  private pickRevealIndex(word: string, revealed: Set<number>): number | null {
    const all: number[] = [];
    const consonants: number[] = [];
    for (let i = 0; i < word.length; i++) {
      if (revealed.has(i)) continue;
      const ch = word[i];
      if (!this.isLetter(ch)) continue;
      all.push(i);
      if (!this.isVowel(ch)) consonants.push(i);
    }
    if (all.length === 0) return null;

    // Avoid adjacent reveals when possible
    const notAdjacent = (idx: number) => !revealed.has(idx - 1) && !revealed.has(idx + 1);
    const consNonAdj = consonants.filter(notAdjacent);
    const allNonAdj = all.filter(notAdjacent);

    const pool =
      (consNonAdj.length > 0 ? consNonAdj : null) ||
      (allNonAdj.length > 0 ? allNonAdj : null) ||
      (consonants.length > 0 ? consonants : null) ||
      all;

    return pool[Math.floor(Math.random() * pool.length)];
  }

  resetRevealState(room: GameState) {
    room.revealedIndices = [];
    room.reveal50Done = false;
    room.reveal25Done = false;
  }

  maybeReveal(code: string): boolean {
    const room = this.rooms.get(code);
    if (!room || !room.word || room.waitingForChoice) return false;
    // Cap reveals per turn
    const maxReveals = 2;
    const currentReveals = room.revealedIndices?.length || 0;
    if (currentReveals >= maxReveals) return false;
    const total = room.settings.turnSeconds;
    const half = Math.floor(total * 0.5);
    const quarter = Math.floor(total * 0.25);
    let doReveal = false;
    if (!room.reveal50Done && room.timeLeft === half) { room.reveal50Done = true; doReveal = true; }
    else if (!room.reveal25Done && room.timeLeft === quarter) { room.reveal25Done = true; doReveal = true; }
    if (!doReveal) return false;
    const set = new Set(room.revealedIndices || []);
    const idx = this.pickRevealIndex(room.word, set);
    if (idx == null) return false;
    set.add(idx);
    room.revealedIndices = Array.from(set).sort((a,b) => a - b);
    room.wordMask = this.computeMask(room.word, room.revealedIndices);
    return true;
  }

  createOrGetRoom(code: string): GameState {
    let room = this.rooms.get(code);
    if (!room) {
      const settings: RoomSettings = { maxPlayers: 8, rounds: 3, turnSeconds: 80, wordChoicesCount: 3 };
      room = {
        code,
        players: [],
        hostId: null,
        currentRound: 0,
        currentTurnIndex: -1,
        drawerId: null,
        word: null,
        wordMask: '',
        timeLeft: 0,
        settings,
        started: false,
      };
      this.rooms.set(code, room);
      this.canvases.set(code, []);
    }
    return room;
  }

  joinRoom(code: string, player: Player) {
    const room = this.createOrGetRoom(code);
    if (room.players.length >= room.settings.maxPlayers) {
      throw new Error('Room full');
    }
    room.players.push(player);
    if (!room.hostId) room.hostId = player.id;
  }

  leaveRoom(code: string, playerId: string) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== playerId);
    if (room.hostId === playerId) room.hostId = room.players[0]?.id ?? null;
    if (room.players.length === 0) {
      this.rooms.delete(code);
      this.canvases.delete(code);
    }
  }

  nextTurn(code: string) {
    const room = this.rooms.get(code);
    if (!room) return null;
    if (room.players.length === 0) return null;

    if (!room.started) {
      room.started = true;
      room.currentRound = 1;
      room.currentTurnIndex = -1;
    }

    // move to next turn
    room.currentTurnIndex++;
    if (room.currentTurnIndex >= room.players.length) {
      room.currentTurnIndex = 0;
      room.currentRound++;
      if (room.currentRound > room.settings.rounds) {
        // game over
        room.started = false;
        room.drawerId = null;
        room.word = null;
        room.wordMask = '';
        room.timeLeft = 0;
        return room;
      }
    }

    const drawer = room.players[room.currentTurnIndex];
    room.drawerId = drawer.id;

    // reset guessed flags
    room.players.forEach(p => (p.guessed = false));

    // prepare N word choices and wait for drawer to choose
    const choices = new Set<string>();
    const n = Math.max(2, Math.min(5, room.settings.wordChoicesCount || 3));
    while (choices.size < n) {
      choices.add(WORDS[Math.floor(Math.random() * WORDS.length)]);
    }
    room.wordChoices = Array.from(choices);
    room.waitingForChoice = true;
    room.word = null;
    room.wordMask = '';
    room.timeLeft = room.settings.turnSeconds;
    this.resetRevealState(room);

    // clear canvas
    this.canvases.set(code, []);

    return room;
  }

  applyStroke(code: string, stroke: Stroke) {
    const canvas = this.canvases.get(code);
    if (!canvas) return;
    if (stroke.type === 'clear') {
      canvas.length = 0;
    } else {
      canvas.push(stroke);
    }
  }

  getCanvas(code: string) {
    return this.canvases.get(code) ?? [];
  }

  tryGuess(code: string, playerId: string, guess: string): { correct: boolean; reveal?: string } {
    const room = this.rooms.get(code);
    if (!room || !room.word) return { correct: false };
    // drawer cannot guess
    if (playerId === room.drawerId) return { correct: false };
    const normalized = guess.trim().toLowerCase();
    const word = room.word.toLowerCase();
    if (normalized === word) {
      const p = room.players.find(pl => pl.id === playerId);
      if (p && !p.guessed) {
        p.guessed = true;
        // simple scoring: remaining time as points
        p.score += Math.max(10, room.timeLeft);
      }
      return { correct: true };
    }
    return { correct: false };
  }

  chooseWord(code: string, playerId: string, word: string): GameState | null {
    const room = this.rooms.get(code);
    if (!room) return null;
    if (room.drawerId !== playerId) return room;
    if (!room.waitingForChoice) return room;
    if (!room.wordChoices || !room.wordChoices.includes(word)) return room;
    room.word = word;
    // reset reveals and set initial mask
    this.resetRevealState(room);
    room.wordMask = word.replace(/\S/g, '_');
    room.waitingForChoice = false;
    room.wordChoices = [];
    // timeLeft already set at nextTurn; timer loop will tick
    return room;
  }
}
