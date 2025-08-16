# Scribal (Skribbl.io-like clone)

A real-time drawing and guessing game built with React, Vite, Node.js, Express, and Socket.IO.

## Apps
- `server/`: Socket.IO + Express game server
- `client/`: React + Vite web client

## Quick Start

1. Install dependencies (from repo root):
   ```bash
   npm install
   npm run install:all
   ```

2. Run both apps in dev mode:
   ```bash
   npm run dev
   ```

3. Open the client: http://localhost:5173

Server runs on http://localhost:3001

## Features (MVP)
- Create/join rooms with codes
- Real-time canvas drawing sync
- Chat with guess detection
- Game loop: rounds, timers, word choice, scoring

