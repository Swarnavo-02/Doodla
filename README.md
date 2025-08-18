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

2. Single URL dev (recommended):
   ```bash
   npm run dev:single
   ```
   Open: http://localhost:3001 (Express serves Vite via middleware)

3. Classic two-process dev (optional):
   ```bash
   npm run dev
   ```
   Open: http://localhost:5173 (client) — server: http://localhost:3001

## Features (MVP)
- Create/join rooms with codes
- Real-time canvas drawing sync
- Chat with guess detection
- Game loop: rounds, timers, word choice, scoring

