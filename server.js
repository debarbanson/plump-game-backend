require('dotenv').config();
// Added backup version - latest working version with all game logic and socket handling
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const sgMail = require('@sendgrid/mail');
const { pool } = require('./db');  // Import pool from db module
const { limiter, socketLimiter } = require('./middleware/rateLimiter');
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;

const app = express();
app.use(cors());
const server = http.createServer(app);

// Test database connection
pool.connect((err, client, done) => {
  if (err) {
    console.error('Error connecting to the database', err);
  } else {
    console.log('Successfully connected to database');
    done();
  }
});

// Add rate limiter middleware
app.use(limiter);

// Keep the improved socket.io settings
const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "https://plump-game-backend.onrender.com",
      "https://debdc.nl",
      "http://debdc.nl",
      "https://www.debdc.nl",
      "http://www.debdc.nl",
      "https://debdc.nl/playplump",
      "https://www.debdc.nl/playplump"
    ],
    methods: ["GET", "POST"]
  },
  pingTimeout: 10000,           // Reduced from 180000
  connectTimeout: 10000,        // Reduced from 120000
  transports: ['websocket', 'polling'],
  allowUpgrades: true,          
  perMessageDeflate: true,      
  maxHttpBufferSize: 1e8,       
  pingInterval: 5000,           // More frequent ping
  cookie: false,
  upgradeTimeout: 10000,        // Reduced from 30000
  allowEIO3: true
});

// More frequent heartbeat
setInterval(() => {
  io.sockets.emit('ping');
}, 5000);  // Reduced from 25000

// Game constants and utilities
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const VALUES = [
  { display: 'A', value: 'A', rank: 14 },  // Using object format for explicit control
  { display: 'K', value: 'K', rank: 13 },
  { display: 'Q', value: 'Q', rank: 12 },
  { display: 'J', value: 'J', rank: 11 },
  { display: '10', value: '10', rank: 10 },
  { display: '9', value: '9', rank: 9 },
  { display: '8', value: '8', rank: 8 },
  { display: '7', value: '7', rank: 7 },
  { display: '6', value: '6', rank: 6 },
  { display: '5', value: '5', rank: 5 },
  { display: '4', value: '4', rank: 4 },
  { display: '3', value: '3', rank: 3 },
  { display: '2', value: '2', rank: 2 }
];

// Helper function for getting clean game state
const getGameState = (game) => {
  // Returns a clean copy of game state without circular references
  // Used for sending game state to clients and handling reconnections
  // Added proper handling for game resumption from paused state
  return {
    gameId: game.gameId,
    phase: game.phase,
    players: game.players,
    scores: game.scores,
    plumps: game.plumps,
    predictions: game.predictions,
    tricks: game.tricks,
    roundNumber: game.roundNumber,
    cardsPerPlayer: game.cardsPerPlayer,
    currentPlayer: game.currentPlayer,
    currentPlayerName: game.currentPlayerName,
    dealer: game.dealer,
    dealerId: game.dealerId,
    trumpSuit: game.trumpSuit,
    leadSuit: game.leadSuit,
    currentTrick: game.currentTrick,
    isEvaluatingTrick: game.isEvaluatingTrick,
    trickWinner: game.trickWinner,
    highestBidder: game.highestBidder,
    message: game.message
  };
};

const GAME_PHASES = {
  WAITING_FOR_PLAYERS: 'WAITING_FOR_PLAYERS',
  DEALING: 'DEALING',
  MAKING_PREDICTIONS: 'MAKING_PREDICTIONS',
  SELECTING_TRUMP: 'SELECTING_TRUMP',
  PLAYING: 'PLAYING',
  PAUSED: 'PAUSED',
  GAME_OVER: 'GAME_OVER'
};

const TRICK_DISPLAY_TIME = 5000; // 5 seconds

const createDeck = () => {
  const deck = [];
  for (const suit of SUITS) {
    for (const cardValue of VALUES) {
      deck.push({ 
        suit, 
        value: cardValue.value,
        display: cardValue.display,  // Add explicit display value
        rank: cardValue.rank 
      });
    }
  }
  return deck;
};

const shuffleDeck = (deck) => {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

const dealCards = (deck, numPlayers, cardsPerPlayer) => {
  // Validate inputs
  if (cardsPerPlayer * numPlayers > deck.length) {
    console.error(`Cannot deal ${cardsPerPlayer} cards to ${numPlayers} players. Not enough cards in deck.`);
    return Array(numPlayers).fill().map(() => []);
  }

  const hands = Array(numPlayers).fill().map(() => []);
  const totalCards = cardsPerPlayer * numPlayers;

  for (let i = 0; i < totalCards; i++) {
    hands[i % numPlayers].push(deck[i]);
  }

  // Validate output
  const handSizes = hands.map(hand => hand.length);
  console.log('Dealt hands sizes:', handSizes);
  
  if (handSizes.some(size => size !== cardsPerPlayer)) {
    console.error('Uneven deal detected:', {
      cardsPerPlayer,
      actualSizes: handSizes,
      deck: deck.length
    });
  }

  return hands;
};

const generateGameId = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

const getNextPlayerIndex = (currentIndex, players) => {
  return (currentIndex + 1) % players.length;
};

// Game state storage
const games = new Map();
const playerSockets = new Map();
const connectedPlayers = new Map();
const activeConnections = new Map();
const disconnectedPlayers = new Map();  // Store player info during disconnects
const tabConnections = new Map();  // Track which tab belongs to which player
const playerNameToGame = new Map(); // player name -> gameId

// Add this near other game state tracking (around line 183)
const playerCardLocks = new Map(); // Track players who have played in current trick

// Update the validatePlay function (around line 192)
const validatePlay = (game, playerId, card) => {
  // Check if player already played in this trick
  if (playerCardLocks.get(`${game.gameId}-${playerId}`)) {
    return { valid: false, message: 'Already played a card in this trick' };
  }

  const playerHand = game.hands[playerId];
  if (!playerHand) {
    return { valid: false, message: 'Player hand not found' };
  }

  const hasCard = playerHand.some(c => c.suit === card.suit && c.value === card.value);
  if (!hasCard) {
    return { valid: false, message: 'Card not in hand' };
  }

  if (game.currentTrick.length === 0) {
    return { valid: true };
  }

  const leadSuit = game.leadSuit;
  const hasLeadSuit = playerHand.some(c => c.suit === leadSuit);
  if (hasLeadSuit && card.suit !== leadSuit) {
    return { valid: false, message: 'Must follow suit' };
  }

  return { valid: true };
};

// Helper function for card value comparison
const getCardValue = (card) => {
  const valueObj = VALUES.find(v => v.value === card.value);
  return valueObj ? valueObj.rank : parseInt(card.value);
};

// Add this helper function at the top with other utilities
const getHighestBidder = (game) => {
  console.log('Current predictions:', game.predictions);

  let highestBid = -1;
  let highestBidders = [];

  // Find the highest bid
  Object.entries(game.predictions).forEach(([playerId, bid]) => {
    if (bid > highestBid) {
      highestBid = bid;
      highestBidders = [playerId]; // Reset list if new highest bid is found
    } else if (bid === highestBid) {
      highestBidders.push(playerId); // Add to list if bid is the same
    }
  });

  console.log(`Highest bid: ${highestBid}, Possible highest bidders:`, highestBidders);

  // If only one highest bidder, they select trump
  if (highestBidders.length === 1) {
    return highestBidders[0];
  }

  // Find the first highest bidder *in the correct order after the dealer*
  const dealerIndex = game.players.findIndex(p => p.id === game.dealerId);
  const playersInOrder = [
    ...game.players.slice(dealerIndex + 1),  // Players after dealer
    ...game.players.slice(0, dealerIndex)    // Players before dealer
  ];

  console.log('Players in order after dealer:', playersInOrder.map(p => p.name));

  for (const player of playersInOrder) {
    if (highestBidders.includes(player.id)) {
      console.log('Final selected highest bidder:', player.name);
      return player.id;
    }
  }

  return null; // This should never happen, but return null for safety
};

// Modify the evaluateTrick function for single-card rounds
const evaluateTrick = (trick, trumpSuit, leadSuit, roundNumber) => {
  if (isSingleCardRound(roundNumber)) {
    // In single-card rounds, highest card of lead suit wins
    return trick.reduce((winner, play) => {
      if (!winner) return play;

      const winningCard = winner.card;
      const playedCard = play.card;
      
      if (playedCard.suit === leadSuit && 
         (winningCard.suit !== leadSuit || 
          getCardValue(playedCard) > getCardValue(winningCard))) {
        return play;
      }

      return winner;
    });
  }

  // Existing evaluation logic for normal rounds
  return trick.reduce((winner, play) => {
    if (!winner) return play;

    const winningCard = winner.card;
    const playedCard = play.card;

    // Trump wins over non-trump
    if (playedCard.suit === trumpSuit && winningCard.suit !== trumpSuit) {
      return play;
    }
    
    // Higher trump wins
    if (playedCard.suit === trumpSuit && winningCard.suit === trumpSuit) {
      return getCardValue(playedCard) > getCardValue(winningCard) ? play : winner;
    }
    
    // If no trump, highest card of lead suit wins
    if (playedCard.suit === leadSuit && winningCard.suit !== trumpSuit) {
      if (winningCard.suit !== leadSuit || getCardValue(playedCard) > getCardValue(winningCard)) {
        return play;
      }
    }

    return winner;
  });
};

// Add this helper function at the top with other utilities
const getCardsForRound = (roundNumber) => {
  const cardSchedule = {
    1: 13, 2: 12, 3: 11, 4: 10, 5: 9, 6: 8, 7: 7,
    8: 6, 9: 5, 10: 4, 11: 3, 12: 2, 13: 1,
    14: 1, 15: 1, 16: 1, 17: 2, 18: 3, 19: 4,
    20: 5, 21: 6, 22: 7, 23: 8, 24: 9, 25: 10,
    26: 11, 27: 12, 28: 13
  };
  return cardSchedule[roundNumber] || 13; // Default to 13 if round not found
};

// Add this helper function
const isSingleCardRound = (roundNumber) => {
  return [13, 14, 15, 16].includes(roundNumber);
};

// Helper function to start a new round
const startNewRound = (game) => {
  // Rotate dealer - dealer is one position ahead each round
  const currentDealerIndex = game.players.findIndex(p => p.id === game.dealerId);
  const nextDealerIndex = getNextPlayerIndex(currentDealerIndex, game.players);
  
  // Update both dealer ID and name
  game.dealerId = game.players[nextDealerIndex].id;
  game.dealer = game.players[nextDealerIndex].name;  // Make sure dealer name updates

  // First predictor is always the player after the dealer
  const firstPredictorIndex = getNextPlayerIndex(nextDealerIndex, game.players);
  
  game.roundNumber++;
  game.cardsPerPlayer = getCardsForRound(game.roundNumber);
  game.trumpSuit = null;
  game.leadSuit = null;
  game.currentTrick = [];
  game.predictions = {};
  game.tricks = {};
  game.isEvaluatingTrick = false;

  // Set first predictor
  game.currentPlayer = game.players[firstPredictorIndex].id;
  game.currentPlayerName = game.players[firstPredictorIndex].name;
  game.phase = GAME_PHASES.MAKING_PREDICTIONS;

  // Deal new cards
  const deck = shuffleDeck(createDeck());
  const hands = dealCards(deck, 4, game.cardsPerPlayer);
  
  if (isSingleCardRound(game.roundNumber)) {
    console.log(`\n===== STARTING SINGLE CARD ROUND ${game.roundNumber} =====`);
    console.log(`Current Phase: ${game.phase}`);
    console.log(`Dealer: ${game.dealer}`);
    
    game.phase = GAME_PHASES.MAKING_PREDICTIONS;
    
    // Deal cards but handle visibility differently
    game.players.forEach((player, playerIndex) => {
      // Store the full hand in game state
      game.hands[player.id] = hands[playerIndex];
      game.tricks[player.id] = 0;

      // During prediction phase, only send opponent cards
      const opponentCards = [];
      game.players.forEach((opponent, opponentIndex) => {
        if (opponent.id !== player.id) {
          opponentCards.push(hands[opponentIndex][0]);
        }
      });

      console.log(`🔍 Player ${player.name} will see opponent cards:`, opponentCards);
      
      // Send initial state - opponent cards visible, own card hidden
      io.to(player.id).emit('dealCards', {
        ownHand: [],  // Hide own card during predictions
        visibleOpponentCards: opponentCards,
        isSingleCardRound: true
      });
    });

    console.log('👥 All players dealt cards for single-card round');
  } else {
    // Normal round logic...
    game.players.forEach((player, index) => {
      game.hands[player.id] = hands[index];
      game.tricks[player.id] = 0;
      io.to(player.id).emit('dealCards', hands[index]);
    });
  }

  io.to(game.gameId).emit('gameStateUpdate', getGameState(game));
};

// When game starts, set initial dealer (host)
const startGame = (gameId) => {
  const game = games.get(gameId);
  if (!game) return;

  game.phase = GAME_PHASES.MAKING_PREDICTIONS;
  game.roundNumber = 0;
  game.dealerId = game.players[0].id;
  game.dealer = game.players[0].name;
  
  // Initialize scores and plumps for all players
  game.scores = {};
  game.plumps = {};
  game.players.forEach(player => {
    game.scores[player.id] = 0;
    game.plumps[player.id] = 0;
  });
  
  startNewRound(game);
};

// Add at the top with other utility functions
const logGameEvent = (event, gameId, data) => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    gameId,
    ...data
  }));
};

const validateGameState = (game) => {
  const playerIds = new Set(game.players.map(p => p.id));
  const errors = [];

  // Check all player references
  if (game.currentPlayer && !playerIds.has(game.currentPlayer)) {
    errors.push('Invalid currentPlayer reference');
    const correctPlayer = game.players.find(p => p.name === game.currentPlayerName);
    if (correctPlayer) {
      game.currentPlayer = correctPlayer.id;
    }
  }

  // Validate predictions
  if (game.predictions) {
    const invalidPredictions = Object.keys(game.predictions)
      .filter(id => !playerIds.has(id));
    invalidPredictions.forEach(oldId => {
      const player = game.players.find(p => p.id === oldId);
      if (player) {
        game.predictions[player.id] = game.predictions[oldId];
        delete game.predictions[oldId];
      }
    });
  }

  // Consolidate tricks for each player
  if (game.tricks) {
    const playerTricks = {};
    Object.entries(game.tricks).forEach(([socketId, tricks]) => {
      const player = game.players.find(p => p.id === socketId || 
        game.players.some(op => op.name === p.name && op.id === socketId));
      if (player) {
        playerTricks[player.id] = (playerTricks[player.id] || 0) + tricks;
      }
    });
    game.tricks = playerTricks;
  }

  if (errors.length > 0) {
    logGameEvent('gameStateValidation', game.gameId, {
      errors,
      phase: game.phase,
      roundNumber: game.roundNumber
    });
  }
  return game;
};

const recoverGameState = (game) => {
  // If game is stuck in trump selection
  if (game.phase === GAME_PHASES.SELECTING_TRUMP && !game.highestBidder) {
    const highestBidder = getHighestBidder(game);
    if (highestBidder) {
      game.highestBidder = highestBidder;
      game.currentPlayer = highestBidder;
      game.currentPlayerName = game.players.find(p => p.id === highestBidder)?.name;
    }
  }
  return game;
};

// Update socket connection handling
io.on('connection', (socket) => {
  // Add rate limiting check
  if (!socketLimiter.checkLimit(socket)) {
    socket.emit('error', 'Rate limit exceeded');
    return;
  }

  const tabId = socket.handshake.auth.tabId;
  console.log(`User connected: ${socket.id}, Tab: ${tabId}`);

  socket.on('rejoinGame', async ({ gameId, playerName }) => {
    logGameEvent('rejoinAttempt', gameId, { playerName, socketId: socket.id });
    
    try {
      const game = games.get(gameId);
      if (!game) {
        socket.emit('error', 'Game not found');
        return;
      }

      // Find player in disconnected players map OR in active game
      const oldSocketId = Array.from(disconnectedPlayers.entries())
        .find(([_, info]) => info.playerName === playerName)?.[0] ||
        game.players.find(p => p.name === playerName)?.id;

      if (!oldSocketId) {
        console.log(`Could not find disconnected player ${playerName}`);
        socket.emit('error', 'Could not find player info');
        return;
      }

      console.log(`Reconnecting player ${playerName} (${oldSocketId} -> ${socket.id})`);

      // Update all state references
      if (game.currentTrick.length > 0) {
        game.currentTrick = game.currentTrick.map(play => {
          if (play.playerId === oldSocketId) {
            return { ...play, playerId: socket.id };
          }
          return play;
        });
      }

      // Transfer all game state
      ['predictions', 'hands', 'scores', 'plumps', 'tricks'].forEach(stateKey => {
        if (game[stateKey]?.[oldSocketId] !== undefined) {
          if (stateKey === 'tricks') {
            // Sum up tricks from all previous socket IDs
            const oldTricks = game[stateKey][oldSocketId] || 0;
            game[stateKey][socket.id] = (game[stateKey][socket.id] || 0) + oldTricks;
          } else {
            game[stateKey][socket.id] = game[stateKey][oldSocketId];
          }
          delete game[stateKey][oldSocketId];
          logGameEvent('stateTransferred', gameId, {
            playerName,
            stateKey,
            oldSocketId,
            newSocketId: socket.id,
            value: game[stateKey][socket.id]
          });
        }
      });

      // Update player references
      const playerIndex = game.players.findIndex(p => p.id === oldSocketId);
      if (playerIndex !== -1) {
        game.players[playerIndex].id = socket.id;
        game.players[playerIndex].disconnected = false;
      }

      // Update game state references
      if (game.currentPlayer === oldSocketId) {
        game.currentPlayer = socket.id;
        game.currentPlayerName = playerName;
      }
      if (game.highestBidder === oldSocketId) {
        game.highestBidder = socket.id;
      }

      disconnectedPlayers.delete(oldSocketId);

      // Validate and recover game state
      const validatedGame = validateGameState(game);
      const recoveredGame = recoverGameState(validatedGame);

      // Rejoin room and sync state
      socket.join(gameId);
      socket.emit('gameState', recoveredGame);
      socket.emit('dealCards', recoveredGame.hands[socket.id]);
      
      // Notify other players
      io.to(gameId).emit('playerRejoined', { 
        playerId: socket.id,
        playerName 
      });
      
      // Update all players
      io.to(gameId).emit('gameStateUpdate', getGameState(recoveredGame));

      logGameEvent('rejoinSuccess', gameId, {
        playerName,
        newSocketId: socket.id,
        gamePhase: game.phase,
        handRestored: !!recoveredGame.hands[socket.id]
      });

      // Force sync after everything is done
      io.to(gameId).emit('forceGameStateSync', {
        timestamp: Date.now()
      });

    } catch (error) {
      console.error('Error in rejoinGame:', error);
      socket.emit('error', 'Failed to rejoin game');
      logGameEvent('rejoinError', gameId, {
        playerName,
        error: error.message
      });
    }
  });

  socket.on('heartbeat', ({ tabId }) => {
    // Keep connection alive and track active players
    activeConnections.set(socket.id, {
      connected: true,
      lastHeartbeat: Date.now(),
      tabId
    });
  });

  socket.on('disconnect', (reason) => {
    console.log(`User disconnected: ${socket.id}, Reason: ${reason}`);
    
    // Store disconnected player's info
    for (const [gameId, game] of games.entries()) {
      const player = game.players.find(p => p.id === socket.id);
      if (player) {
        console.log(`Storing disconnected player info for ${player.name}`);
        
        // Store full game context
        disconnectedPlayers.set(player.name, {
          gameId,
          player,
          disconnectTime: Date.now(),
          gameState: {
            hand: game.hands[socket.id],
            predictions: game.predictions[socket.id],
            tricks: game.tricks[socket.id],
            scores: game.scores[socket.id],
            plumps: game.plumps[socket.id],
            currentPlayer: game.currentPlayer,
            phase: game.phase,
            trumpSuit: game.trumpSuit
          }
        });

        // Update game state to show player as disconnected
        player.disconnected = true;
        playerNameToGame.set(player.name, gameId);
        
        // Notify other players
        io.to(gameId).emit('playerDisconnected', { 
          playerId: socket.id, 
          playerName: player.name 
        });
      }
    }
    
    activeConnections.delete(socket.id);
  });

  socket.on('error', (error) => {
    console.error(`Socket error for ${socket.id}:`, error);
  });

  socket.on('ping', () => {
    // Just acknowledge the ping
    socket.emit('pong');
  });

  socket.on('createGame', async ({ playerName }) => {
    console.log('Create game attempt - Player:', playerName);
    const gameId = generateGameId();
    console.log('Generated gameId:', gameId);
    
    const game = {
      gameId,
      phase: GAME_PHASES.WAITING_FOR_PLAYERS,
      players: [{ id: socket.id, name: playerName, isHost: true }],
      scores: {},
      plumps: {},
      hands: {},
      predictions: {},
      tricks: {},
      roundNumber: 0,
      cardsPerPlayer: 0,
      currentPlayer: null,
      currentPlayerName: null,
      dealer: playerName,        // Set initial dealer
      dealerId: socket.id,       // Store dealer's socket ID
      trumpSuit: null,
      leadSuit: null,
      currentTrick: [],
      isEvaluatingTrick: false
    };

    // Initialize scores and plumps for the first player
    game.scores[socket.id] = 0;
    game.plumps[socket.id] = 0;

    games.set(gameId, game);
    console.log('Game stored. Current games:', Array.from(games.keys()));
    
    socket.join(gameId);
    socket.emit('gameCreated', game);
  });

  socket.on('joinGame', async ({ gameId, playerName }) => {
    console.log(`Join game attempt - Game: ${gameId}, Player: ${playerName}`);
    console.log('Available games:', Array.from(games.keys()));
    
    const game = games.get(gameId);
    if (!game) {
      console.log('Game not found in storage. Games:', Array.from(games.keys()));
      socket.emit('error', 'Game not found');
      return;
    }

    if (game.players.length >= 4) {
      socket.emit('error', 'Game is full');
      return;
    }

    const player = { id: socket.id, name: playerName, isHost: false };
    game.players.push(player);
    
    // Initialize scores and plumps for the new player
    game.scores[socket.id] = 0;
    game.plumps[socket.id] = 0;  // Initialize plumps counter
    
    playerSockets.set(socket.id, { gameId, playerName });
    connectedPlayers.set(playerName, socket.id);
    
    socket.join(gameId);
    
    // Emit joinedGame event for the new player
    socket.emit('joinedGame', game);
    
    // Update all players
    io.to(gameId).emit('gameStateUpdate', game);
  });

  socket.on('startGame', ({ gameId }) => {
    console.log(`Start game request received for game: ${gameId}`);
    const game = games.get(gameId);
    if (!game) {
      console.error('Game not found:', gameId);
      socket.emit('error', 'Game not found');
      return;
    }

    if (game.players.length !== 4) {
      socket.emit('error', 'Need exactly 4 players to start');
      return;
    }

    console.log('Starting game with players:', game.players.map(p => p.name));

    // Ensure all players are in the room
    game.players.forEach(player => {
      if (!io.sockets.adapter.rooms.get(gameId)?.has(player.id)) {
        io.sockets.sockets.get(player.id)?.join(gameId);
      }
    });

    game.phase = GAME_PHASES.DEALING;
    game.roundNumber = 1;
    game.cardsPerPlayer = 13;
    game.tricks = {};
    game.scores = {};
    game.hands = {};

    const deck = shuffleDeck(createDeck());
    const hands = dealCards(deck, 4, game.cardsPerPlayer);
    
    // Deal cards to all players including host
    game.players.forEach((player, index) => {
      game.hands[player.id] = hands[index];
      io.to(player.id).emit('dealCards', hands[index]);
      console.log(`Dealt cards to ${player.name}`);
    });

    // Find dealer index and set first predictor
    const dealerIndex = game.players.findIndex(p => p.id === game.dealerId);
    const firstPredictorIndex = getNextPlayerIndex(dealerIndex, game.players);
    
    game.phase = GAME_PHASES.MAKING_PREDICTIONS;
    game.currentPlayer = game.players[firstPredictorIndex].id;
    game.currentPlayerName = game.players[firstPredictorIndex].name;
    game.predictions = {};

    // Make sure to emit to ALL players including host
    const gameState = getGameState(game);
    console.log('Emitting game state update to all players:', gameState.phase);
    
    // Emit to room and directly to each player to ensure delivery
    io.to(gameId).emit('gameStateUpdate', gameState);
    game.players.forEach(player => {
      io.to(player.id).emit('gameStateUpdate', gameState);
    });
  });

  socket.on('makePrediction', ({ gameId, prediction }) => {
    const game = games.get(gameId);
    if (!game || game.phase !== GAME_PHASES.MAKING_PREDICTIONS) return;

    // Store the prediction
    game.predictions[socket.id] = Number(prediction);
    
    // Move to next player if not all predictions are made
    if (Object.keys(game.predictions).length < game.players.length) {
      const currentPlayerIndex = game.players.findIndex(p => p.id === socket.id);
      const nextPlayerIndex = getNextPlayerIndex(currentPlayerIndex, game.players);
      game.currentPlayer = game.players[nextPlayerIndex].id;
      game.currentPlayerName = game.players[nextPlayerIndex].name;
    }
    // When all predictions are made
    else if (Object.keys(game.predictions).length === game.players.length) {
      if (isSingleCardRound(game.roundNumber)) {
        console.log("All predictions made in single-card round - sending players their cards");
        game.phase = GAME_PHASES.PLAYING;
        
        // Set the first player (highest bidder) before sending cards
        game.highestBidder = getHighestBidder(game);
        game.currentPlayer = game.highestBidder;
        game.currentPlayerName = game.players.find(p => p.id === game.highestBidder).name;
        
        game.players.forEach((player) => {
          // Send each player their own card
          io.to(player.id).emit('dealCards', {
            ownHand: game.hands[player.id],  // Now send their actual card
            visibleOpponentCards: [],  // Clear opponent cards
            isSingleCardRound: true
          });
        });

        console.log(`First player to play: ${game.currentPlayerName}`);
      } else {
        // Normal round logic - update both currentPlayer and currentPlayerName
        game.phase = GAME_PHASES.SELECTING_TRUMP;
        game.highestBidder = getHighestBidder(game);
        game.currentPlayer = game.highestBidder;
        // Make sure to update the currentPlayerName to match the highest bidder
        game.currentPlayerName = game.players.find(p => p.id === game.highestBidder).name;
        
        console.log('Moving to trump selection:', {
          phase: game.phase,
          highestBidder: game.highestBidder,
          currentPlayer: game.currentPlayer,
          currentPlayerName: game.currentPlayerName
        });
      }
    }

    io.to(gameId).emit('gameStateUpdate', getGameState(game));
  });

  socket.on('selectTrump', ({ gameId, suit }) => {
    const game = games.get(gameId);
    if (!game || game.phase !== GAME_PHASES.SELECTING_TRUMP) return;

    if (socket.id !== game.currentPlayer) {
      socket.emit('error', 'Not your turn to select trump');
      return;
    }

    console.log('Trump selection before:', {
      currentPlayer: game.currentPlayer,
      highestBidder: game.highestBidder
    });

    game.trumpSuit = suit;
    game.phase = GAME_PHASES.PLAYING;

    // Assign first player to start the round (same as highest bidder)
    game.currentPlayer = game.highestBidder;
    game.currentPlayerName = game.players.find(p => p.id === game.highestBidder).name;

    console.log('Trump selection after:', {
      phase: game.phase,
      currentPlayer: game.currentPlayer,
      highestBidder: game.highestBidder,
      trumpSuit: game.trumpSuit
    });

    io.to(gameId).emit('gameStateUpdate', game);
  });

  socket.on('playCard', ({ gameId, card }) => {
    const game = games.get(gameId);
    if (!game || game.phase !== GAME_PHASES.PLAYING) return;

    // Add lock check
    const lockKey = `${gameId}-${socket.id}`;
    if (playerCardLocks.get(lockKey)) {
      socket.emit('error', 'Already played a card in this trick');
      return;
    }

    if (socket.id !== game.currentPlayer) {
      socket.emit('error', 'Not your turn');
      return;
    }

    // Prevent playing while trick is being evaluated
    if (game.isEvaluatingTrick) {
      socket.emit('error', 'Please wait for the current trick to complete');
      return;
    }

    // Validate the play
    const isValidPlay = validatePlay(game, socket.id, card);
    if (!isValidPlay.valid) {
      socket.emit('error', isValidPlay.message);
      return;
    }

    // Set the lock AFTER all validations pass
    playerCardLocks.set(lockKey, true);

    // Add card to current trick
    game.currentTrick.push({ 
      playerId: socket.id, 
      playerName: game.players.find(p => p.id === socket.id).name,
      card 
    });

    // Set lead suit if first card
    if (game.currentTrick.length === 1) {
      game.leadSuit = card.suit;
    }

    // Remove card from player's hand
    game.hands[socket.id] = game.hands[socket.id].filter(c => 
      !(c.suit === card.suit && c.value === card.value)
    );

    // Emit game state update BEFORE checking for trick completion
    io.to(gameId).emit('gameStateUpdate', getGameState(game));

    // If trick is complete (4 cards), evaluate winner
    if (game.currentTrick.length === 4) {
      game.isEvaluatingTrick = true;
      const winningPlay = evaluateTrick(game.currentTrick, game.trumpSuit, game.leadSuit, game.roundNumber);
      const winner = winningPlay.playerId;
      game.tricks[winner] = (game.tricks[winner] || 0) + 1;

      // Add fallback for player name
      const winningPlayer = game.players.find(p => p.id === winner);
      game.trickWinner = {
        playerId: winner,
        playerName: winningPlayer ? winningPlayer.name : winningPlay.playerName,
        card: winningPlay.card
      };

      // Emit state with winner before clearing
      io.to(gameId).emit('gameStateUpdate', getGameState(game));

      setTimeout(() => {
        // Clear locks for next trick
        game.players.forEach(player => {
          playerCardLocks.delete(`${gameId}-${player.id}`);
        });

        game.currentTrick = [];
        game.leadSuit = null;
        game.trickWinner = null;
        game.isEvaluatingTrick = false;

        // Check if round is over
        const totalTricks = Object.values(game.tricks).reduce((sum, count) => sum + count, 0);
        if (totalTricks === game.cardsPerPlayer) {
          calculateScores(game);
          if (game.roundNumber === 28) {
            game.phase = GAME_PHASES.GAME_OVER;
            game.message = 'Game Over!';
            
            // Create results table
            const resultsTable = game.players.map(player => ({
              playerName: player.name,
              score: game.scores[player.id] || 0,
              plumps: game.plumps[player.id] || 0,
              date: new Date().toISOString()
            }));

            // Send email with results
            sendGameResults(resultsTable);
          } else {
            startNewRound(game);
          }
        } else {
          // Round continues - winner of trick starts next trick
          game.currentPlayer = winner;
          game.currentPlayerName = game.players.find(p => p.id === winner).name;
        }

        io.to(gameId).emit('gameStateUpdate', getGameState(game));
      }, TRICK_DISPLAY_TIME);
    } else {
      // Move to next player
      const currentPlayerIndex = game.players.findIndex(p => p.id === socket.id);
      const nextPlayerIndex = getNextPlayerIndex(currentPlayerIndex, game.players);
      game.currentPlayer = game.players[nextPlayerIndex].id;
      game.currentPlayerName = game.players[nextPlayerIndex].name;
      
      // Emit updated state
      io.to(gameId).emit('gameStateUpdate', getGameState(game));
    }
  });

  socket.on('setHighestBidder', ({ gameId, highestBidder }) => {
    const game = games.get(gameId);
    if (!game || game.phase !== GAME_PHASES.PLAYING) return;

    if (!game.highestBidder) {
      game.highestBidder = highestBidder;
      io.to(gameId).emit('gameStateUpdate', game);
    }
  });

  socket.on('reconnect_attempt', () => {
    const game = Array.from(games.values()).find(g => 
      g.players.some(p => p.id === socket.id)
    );
    
    if (game) {
      // Silently attempt to restore game state
      socket.emit('syncGameState', {
        gameId: game.gameId,
        playerId: socket.id
      });
    }
  });

  // Add cleanup for abandoned locks
  const cleanupCardLocks = (gameId) => {
    const lockPrefix = `${gameId}-`;
    for (const key of playerCardLocks.keys()) {
      if (key.startsWith(lockPrefix)) {
        playerCardLocks.delete(key);
      }
    }
  };

  // Add to relevant places like game end, round end
  socket.on('endRound', ({ gameId }) => {
    cleanupCardLocks(gameId);
    // ... rest of end round logic
  });
});

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

async function sendGameResults(results) {
  // Sort players by score to determine rank
  const sortedResults = [...results].sort((a, b) => b.score - a.score);
  
  // Add rank to each player
  const rankedResults = sortedResults.map((result, index) => ({
    ...result,
    rank: index + 1
  }));

  try {
    // Store game results in database
    for (const result of rankedResults) {
      await pool.query(
        `INSERT INTO game_results 
         (player_name, score, plumps, rank, game_id, played_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          result.playerName,
          result.score,
          result.plumps,
          result.rank,
          result.gameId,
          new Date()
        ]
      );
    }
    console.log('Game results stored in database');

    // Send email as before
    const htmlTable = `
      <table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse;">
        <tr style="background-color: #f2f2f2;">
          <th>Name</th>
          <th>Score</th>
          <th>Plumps</th>
          <th>Rank</th>
        </tr>
        ${rankedResults.map(r => `
          <tr>
            <td>${r.playerName}</td>
            <td>${r.score}</td>
            <td>${r.plumps}</td>
            <td>${r.rank}</td>
          </tr>
        `).join('')}
      </table>
    `;

    await sgMail.send({
      to: 'debarbanson@debdc.nl',
      from: process.env.SENDGRID_VERIFIED_SENDER,
      subject: 'Plump results',
      html: htmlTable
    });
    console.log('Game results email sent successfully');
  } catch (error) {
    console.error('Error handling game results:', error);
    // Continue even if database storage fails
  }
}

// Add an endpoint that Power Automate can poll
app.get('/api/game-results', (req, res) => {
  const results = [];
  games.forEach(game => {
    if (game.phase === GAME_PHASES.GAME_OVER) {
      game.players.forEach(player => {
        results.push({
          playerName: player.name,
          score: game.scores[player.id] || 0,
          plumps: game.plumps[player.id] || 0,
          gameId: game.gameId,
          date: new Date().toISOString()
        });
      });
    }
  });
  res.json(results);
});

// Add this after your other endpoints
app.get('/test-email', async (req, res) => {
  try {
    const testResults = [{
      playerName: 'Test Player',
      score: 100,
      plumps: 5,
      date: new Date().toISOString()
    }];
    
    await sendGameResults(testResults);
    res.json({ message: 'Test email sent successfully' });
  } catch (error) {
    console.error('Error sending test email:', error);
    res.status(500).json({ error: 'Failed to send test email' });
  }
});

// Add this test endpoint
app.get('/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      success: true,
      message: 'Database connected successfully',
      timestamp: result.rows[0].now
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: 'Database connection failed',
      error: err.message
    });
  }
});

const PORT = process.env.PORT || 3001;

// After database connection test
const initTables = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_results (
        id SERIAL PRIMARY KEY,
        player_name VARCHAR(100) NOT NULL,
        score INTEGER NOT NULL,
        plumps INTEGER NOT NULL,
        rank INTEGER NOT NULL,
        game_id VARCHAR(6) NOT NULL,
        played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Database tables initialized');
  } catch (err) {
    console.error('Error initializing tables:', err);
  }
};

const calculateScores = (game) => {
  console.log('Calculating scores for round:', game.roundNumber);
  console.log('Current predictions:', game.predictions);
  console.log('Current tricks:', game.tricks);

  game.players.forEach(player => {
    const prediction = game.predictions[player.id] || 0;
    const tricks = game.tricks[player.id] || 0;
    
    // Calculate score for this round
    let roundScore = 0;
    if (prediction === tricks) {
      // For predictions 0-9: score = prediction + 10
      // For predictions 10+: score = prediction × 10
      roundScore = prediction >= 10 ? prediction * 10 : prediction + 10;
      console.log(`Player ${player.name} matched prediction ${prediction}. Score: ${roundScore}`);
    } else {
      // Add plump if prediction was wrong
      game.plumps[player.id] = (game.plumps[player.id] || 0) + 1;
      console.log(`Player ${player.name} got a plump. Prediction: ${prediction}, Tricks: ${tricks}`);
    }

    // Update total score
    game.scores[player.id] = (game.scores[player.id] || 0) + roundScore;

    console.log(`Player ${player.name} round summary:`, {
      prediction,
      tricks,
      roundScore,
      totalScore: game.scores[player.id],
      plumps: game.plumps[player.id]
    });
  });
};

// Add this helper function near the other card-related functions
const getCardDisplay = (card, language = 'en') => {
  if (cardValueTranslations[language]?.[card.value]) {
    return cardValueTranslations[language][card.value];
  }
  return card.display;
};

// Initialize tables and start server
const startServer = async () => {
  try {
    await initTables();
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();