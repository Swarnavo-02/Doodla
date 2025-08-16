export type Player = {
  id: string;
  name: string;
  score: number;
  guessed: boolean;
  avatar?: { bg: string; emoji?: string; initial?: string };
};

export type RoomSettings = {
  maxPlayers: number;
  rounds: number;
  turnSeconds: number;
  wordChoicesCount: number; // how many words to present to drawer
};

export type GameState = {
  code: string;
  players: Player[];
  hostId: string | null;
  currentRound: number;
  currentTurnIndex: number;
  drawerId: string | null;
  word: string | null;
  wordMask: string;
  timeLeft: number;
  settings: RoomSettings;
  started: boolean;
  wordChoices?: string[];
  waitingForChoice?: boolean;
  // indices of letters revealed as hints this turn
  revealedIndices?: number[];
  // track whether we already revealed at 50% and 25% thresholds
  reveal50Done?: boolean;
  reveal25Done?: boolean;
};

export type Stroke = {
  x: number;
  y: number;
  color: string;
  size: number;
  type: 'begin' | 'draw' | 'end' | 'clear';
  erase?: boolean;
};
