'use strict';

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory session store — keyed by 6-char uppercase code
const sessions = new Map();

const CARD_VALUES = ['0', '½', '1', '2', '3', '5', '8', '13', '20', '40', '100', '?', '☕'];

function generateCode() {
  // Avoid visually ambiguous chars (0/O, 1/I/l)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (sessions.has(code));
  return code;
}

// ── REST ─────────────────────────────────────────────────────────────────────

app.post('/api/sessions', (req, res) => {
  const { organiserName } = req.body;
  if (!organiserName?.trim()) {
    return res.status(400).json({ error: 'Organiser name is required' });
  }

  const id = generateCode();
  const session = {
    id,
    organiserToken: uuidv4(),
    organiserId: null,          // socket.id of the current organiser connection
    organiserName: organiserName.trim(),
    participants: new Map(),    // socketId → { name, vote, hasVoted, isOrganiser }
    stories: [],                // { id, title, description, finalScore }
    currentStoryIndex: -1,
    state: 'setup',             // 'setup' | 'voting' | 'reveal' | 'complete'
  };
  sessions.set(id, session);

  res.json({ sessionId: id, organiserToken: session.organiserToken });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildView(session, socketId) {
  const state = session.state;
  const participant = session.participants.get(socketId);

  return {
    id: session.id,
    state,
    isOrganiser: socketId === session.organiserId,
    organiserName: session.organiserName,
    stories: session.stories,
    currentStoryIndex: session.currentStoryIndex,
    currentStory: session.currentStoryIndex >= 0 ? session.stories[session.currentStoryIndex] : null,
    participants: Array.from(session.participants.entries()).map(([sid, p]) => ({
      name: p.name,
      isOrganiser: p.isOrganiser,
      hasVoted: p.hasVoted,
      // Only reveal vote values in the reveal phase
      vote: state === 'reveal' ? p.vote : null,
      isSelf: sid === socketId,
    })),
    cardValues: CARD_VALUES,
    votedCount: Array.from(session.participants.values()).filter(p => p.hasVoted).length,
    totalCount: session.participants.size,
    myVote: participant?.vote ?? null,
    myHasVoted: participant?.hasVoted ?? false,
  };
}

function broadcast(session) {
  for (const socketId of session.participants.keys()) {
    io.to(socketId).emit('session-updated', buildView(session, socketId));
  }
}

// ── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  let currentSessionId = null;

  // Participants and organisers both call this to enter a session room.
  // Organisers send their organiserToken so they get elevated privileges.
  socket.on('join-session', ({ id, name, organiserToken }, cb) => {
    const sid = (id ?? '').trim().toUpperCase();
    const session = sessions.get(sid);

    if (!session) {
      return cb({ ok: false, error: 'Session not found. Check the code and try again.' });
    }
    if (session.state === 'complete') {
      return cb({ ok: false, error: 'This session has ended.' });
    }

    const isOrganiser = !!(organiserToken && organiserToken === session.organiserToken);

    if (isOrganiser) {
      // Re-seat the organiser under their new socket ID (handles page reload / reconnect)
      for (const [oldId, p] of session.participants.entries()) {
        if (p.isOrganiser) { session.participants.delete(oldId); break; }
      }
      session.organiserId = socket.id;
      session.participants.set(socket.id, {
        name: (name || session.organiserName).trim(),
        vote: null,
        hasVoted: false,
        isOrganiser: true,
      });
    } else {
      const nameLower = name.toLowerCase();

      // Check for reconnect (same name already seated)
      let reconnected = false;
      for (const [oldId, p] of session.participants.entries()) {
        if (!p.isOrganiser && p.name.toLowerCase() === nameLower) {
          session.participants.delete(oldId);
          session.participants.set(socket.id, p);
          reconnected = true;
          break;
        }
      }

      if (!reconnected) {
        const taken = Array.from(session.participants.values())
          .some(p => p.name.toLowerCase() === nameLower);
        if (taken) {
          return cb({ ok: false, error: 'That name is already taken. Please choose another.' });
        }
        session.participants.set(socket.id, { name: name.trim(), vote: null, hasVoted: false, isOrganiser: false });
      }
    }

    currentSessionId = sid;
    socket.join(sid);
    cb({ ok: true, isOrganiser });
    broadcast(session);
  });

  // ── Organiser: story management ───────────────────────────────────────────

  socket.on('add-story', ({ title, description }, cb) => {
    const session = sessions.get(currentSessionId);
    if (!session || socket.id !== session.organiserId) {
      return cb?.({ ok: false, error: 'Not authorised' });
    }
    if (!title?.trim()) {
      return cb?.({ ok: false, error: 'Title is required' });
    }
    session.stories.push({
      id: uuidv4(),
      title: title.trim(),
      description: (description ?? '').trim(),
      finalScore: null,
    });
    cb?.({ ok: true });
    broadcast(session);
  });

  socket.on('remove-story', ({ storyId }) => {
    const session = sessions.get(currentSessionId);
    if (!session || socket.id !== session.organiserId || session.state !== 'setup') return;
    session.stories = session.stories.filter(s => s.id !== storyId);
    broadcast(session);
  });

  socket.on('reorder-stories', ({ fromIndex, toIndex }) => {
    const session = sessions.get(currentSessionId);
    if (!session || socket.id !== session.organiserId || session.state !== 'setup') return;
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= session.stories.length || toIndex >= session.stories.length) return;
    const [story] = session.stories.splice(fromIndex, 1);
    session.stories.splice(toIndex, 0, story);
    broadcast(session);
  });

  // ── Organiser: session flow ───────────────────────────────────────────────

  socket.on('start-session', (cb) => {
    const session = sessions.get(currentSessionId);
    if (!session || socket.id !== session.organiserId) return;
    if (session.stories.length === 0) {
      return cb?.({ ok: false, error: 'Add at least one story before starting.' });
    }
    session.state = 'voting';
    session.currentStoryIndex = 0;
    for (const p of session.participants.values()) { p.vote = null; p.hasVoted = false; }
    cb?.({ ok: true });
    broadcast(session);
  });

  socket.on('reveal-votes', () => {
    const session = sessions.get(currentSessionId);
    if (!session || socket.id !== session.organiserId || session.state !== 'voting') return;
    session.state = 'reveal';
    broadcast(session);
  });

  socket.on('set-final-score', ({ score }) => {
    const session = sessions.get(currentSessionId);
    if (!session || socket.id !== session.organiserId || session.state !== 'reveal') return;
    const story = session.stories[session.currentStoryIndex];
    if (!story) return;
    story.finalScore = String(score).trim();
    broadcast(session);
  });

  socket.on('next-story', () => {
    const session = sessions.get(currentSessionId);
    if (!session || socket.id !== session.organiserId || session.state !== 'reveal') return;
    const nextIdx = session.currentStoryIndex + 1;
    if (nextIdx < session.stories.length) {
      session.currentStoryIndex = nextIdx;
      session.state = 'voting';
      for (const p of session.participants.values()) { p.vote = null; p.hasVoted = false; }
    } else {
      session.state = 'complete';
    }
    broadcast(session);
  });

  socket.on('end-session', () => {
    const session = sessions.get(currentSessionId);
    if (!session || socket.id !== session.organiserId) return;
    session.state = 'complete';
    broadcast(session);
  });

  // ── Participant: voting ───────────────────────────────────────────────────

  socket.on('submit-vote', ({ value }) => {
    const session = sessions.get(currentSessionId);
    if (!session || session.state !== 'voting') return;
    const p = session.participants.get(socket.id);
    if (!p) return;

    p.vote = String(value);
    p.hasVoted = true;

    // Auto-reveal when everyone has voted
    const allVoted = Array.from(session.participants.values()).every(pt => pt.hasVoted);
    if (allVoted) session.state = 'reveal';

    broadcast(session);
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    if (!currentSessionId) return;
    const session = sessions.get(currentSessionId);
    if (!session) return;
    const p = session.participants.get(socket.id);
    // Participants are removed on disconnect; the organiser slot stays
    // so they can reclaim it when they reconnect with their token.
    if (p && !p.isOrganiser) {
      session.participants.delete(socket.id);
      broadcast(session);
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n  Planning Poker  →  http://localhost:${PORT}\n`);
});
