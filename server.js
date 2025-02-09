require('dotenv').config();
// Added backup version - latest working version with all game logic and socket handling
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const sgMail = require('@sendgrid/mail');
const { pool } = require('./db');  // Import pool from db module

const app = express();
app.use(cors());
app.use(express.json({ extended: true }));

// Add UTF-8 encoding
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

const server = http.createServer(app);

// Add health check endpoint before socket setup
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Add test endpoint
app.get('/test', (req, res) => {
  res.json({ 
    status: 'Test environment running!',
    environment: 'test',
    timestamp: new Date().toISOString()
  });
});

// Test database connection
pool.connect((err, client, done) => {
  if (err) {
    console.error('Error connecting to the database', err);
  } else {
    console.log('Successfully connected to database');
    done();
  }
});

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
      "https://www.debdc.nl/playplump",
      "https://debdc.nl/test",
      "https://www.debdc.nl/test",
      "https://plump-game-backend-test.onrender.com"
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["*"],
    credentials: false
  },
  pingTimeout: 60000,           // Added: 1 minute ping timeout
  pingInterval: 25000,          // Added: 25 second ping interval
  connectTimeout: 120000,       // Added: 2 minute connection timeout
  transports: ['websocket', 'polling'],     
  allowUpgrades: false,          
  perMessageDeflate: false,
  maxHttpBufferSize: 1e8,        
  cookie: false                  
});


// Game constants and utilities
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

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
    for (const value of VALUES) {
      deck.push({ suit, value });
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

const getNextPlayerIndex = (currentIndex, playerCount) => {
  return (currentIndex + 1) % playerCount;
};

// Game state storage
const games = new Map();
const playerSockets = new Map();
const connectedPlayers = new Map();
const activeConnections = new Map();
const disconnectedPlayers = new Map();  // Keep only one instance of each
const tabConnections = new Map();  // Track which tab belongs to which player

// Track active player names and their connection status
const activePlayers = new Map(); // playerName -> {socketId, lastConnected}

// New helper function for card validation
const validatePlay = (game, playerName, card) => {
  const playerHand = game.hands[playerName];
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
const getCardValue = (value) => {
  const valueOrder = {
    'A': 14, 'K': 13, 'Q': 12, 'J': 11,
    '10': 10, '9': 9, '8': 8, '7': 7,
    '6': 6, '5': 5, '4': 4, '3': 3, '2': 2
  };
  return valueOrder[value] || parseInt(value);
};

// Add this helper function at the top with other utilities
const getHighestBidder = (game) => {
  console.log('Current predictions:', game.predictions);

  let highestBid = -1;
  let highestBidders = [];

  // Find highest bid using player names
  Object.entries(game.predictions).forEach(([playerName, bid]) => {
    if (bid > highestBid) {
      highestBid = bid;
      highestBidders = [playerName];
    } else if (bid === highestBid) {
      highestBidders.push(playerName);
    }
  });

  console.log(`Highest bid: ${highestBid}, Possible highest bidders:`, highestBidders);

  // If only one highest bidder, return their socket ID
  if (highestBidders.length === 1) {
    return highestBidders[0];  // Return player name instead of socket ID
  }

  // Find first highest bidder after dealer in playerOrder
  const dealerIndex = game.playerOrder.indexOf(game.dealer);
  const orderedPlayers = [
    ...game.playerOrder.slice(dealerIndex + 1),
    ...game.playerOrder.slice(0, dealerIndex)
  ];

  for (const playerName of orderedPlayers) {
    if (highestBidders.includes(playerName)) {
      return playerName;  // Return player name instead of socket ID
    }
  }

  return null;
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
          getCardValue(playedCard.value) > getCardValue(winningCard.value))) {
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
      return getCardValue(playedCard.value) > getCardValue(winningCard.value) ? play : winner;
    }
    
    // If no trump, highest card of lead suit wins
    if (playedCard.suit === leadSuit && winningCard.suit !== trumpSuit) {
      if (winningCard.suit !== leadSuit || getCardValue(playedCard.value) > getCardValue(winningCard.value)) {
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
  game.roundNumber++;
  game.cardsPerPlayer = getCardsForRound(game.roundNumber);
  
  // Update dealer
  const currentDealerIndex = game.playerOrder.indexOf(game.dealer);
  const nextDealerIndex = getNextPlayerIndex(currentDealerIndex, game.playerOrder.length);

  // Reset game state
  game.trumpSuit = null;
  game.leadSuit = null;
  game.currentTrick = [];
  game.tricks = {};
  game.predictions = {};
  game.hands = {};
  game.phase = GAME_PHASES.DEALING;

  // Deal new hands
  const deck = shuffleDeck(createDeck());
  const hands = dealCards(deck, 4, game.cardsPerPlayer);
  
  // Deal cards to players
  game.playerOrder.forEach((playerName, index) => {
    const player = game.players[playerName];
    game.hands[playerName] = hands[index];
    io.to(player.socketId).emit('dealCards', hands[index]);
  });

  // Set first predictor (player after dealer)
  const firstPredictorIndex = getNextPlayerIndex(nextDealerIndex, game.playerOrder.length);
  const firstPredictor = game.playerOrder[firstPredictorIndex];
  game.currentPlayerName = firstPredictor;
  game.currentPlayer = game.players[firstPredictor].socketId;

  game.phase = GAME_PHASES.MAKING_PREDICTIONS;

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

io.on('connection', (socket) => {
  console.log('New socket connection:', {
    id: socket.id,
    playerName: socket.handshake.auth.playerName
  });

  const playerName = socket.handshake.auth.playerName;
  
  // Validate player name
  if (activePlayers.has(playerName)) {
    const existingPlayer = activePlayers.get(playerName);
    // Allow reconnection if last connection was > 30 seconds ago
    if (Date.now() - existingPlayer.lastConnected < 30000) {
      socket.emit('error', 'Player name already in use');
      socket.disconnect();
      return;
    }
  }

  // Update active players
  activePlayers.set(playerName, {
    socketId: socket.id,
    lastConnected: Date.now()
  });

  socket.on('disconnect', () => {
    const playerName = Array.from(activePlayers.entries())
      .find(([_, data]) => data.socketId === socket.id)?.[0];
    
    if (playerName && activePlayers.has(playerName)) {
      // Keep the player entry for 30 seconds to allow for reconnection
      setTimeout(() => {
        if (activePlayers.get(playerName)?.socketId === socket.id) {
          activePlayers.delete(playerName);
        }
      }, 30000);
    }
  });

  socket.on('rejoinGame', ({ gameId, playerName }) => {
    const game = games.get(gameId);
    if (!game) {
      socket.emit('error', 'Game not found');
      return;
    }

    const player = game.players.find(p => p.name === playerName);
    if (!player) {
      socket.emit('error', 'Player not found in game');
      return;
    }

    // Store old socket ID to transfer state
    const oldSocketId = player.id;
    
    // Update socket ID
    player.id = socket.id;
    
    // Restore player's hand if it exists
    if (game.hands && game.hands[oldSocketId]) {
      game.hands[socket.id] = game.hands[oldSocketId];
      delete game.hands[oldSocketId];
    }

    // Update any game references to the old socket ID
    if (game.currentPlayer === oldSocketId) game.currentPlayer = socket.id;
    if (game.highestBidder === oldSocketId) game.highestBidder = socket.id;

    // Rejoin room and send full state
    socket.join(gameId);
    socket.emit('gameStateUpdate', getGameState(game));
    
    console.log(`Player ${playerName} reconnected to game ${gameId}`);
  });

  socket.on('heartbeat', ({ tabId }) => {
    // Keep connection alive and track active players
    activeConnections.set(socket.id, { 
      connected: true,
      lastHeartbeat: Date.now(),
      tabId 
    });
  });

  socket.on('ping', () => {
    // Just acknowledge the ping
    socket.emit('pong');
  });

  socket.on('createGame', ({ playerName }) => {
    console.log('Create game request:', {
      socketId: socket.id,
      playerName: playerName
    });
    if (activePlayers.has(playerName) && 
        activePlayers.get(playerName).socketId !== socket.id &&
        Date.now() - activePlayers.get(playerName).lastConnected < 30000) {
      console.log('Player name in use:', playerName);
      socket.emit('error', 'Player name already in use');
      return;
    }
    console.log('Create game attempt - Player:', playerName);
    const gameId = generateGameId();
    const game = {
      gameId,
      phase: GAME_PHASES.WAITING_FOR_PLAYERS,
      players: {},
      playerOrder: [playerName],
      scores: {},
      plumps: {},
      hands: {},
      predictions: {},
      tricks: {},
      roundNumber: 0,
      cardsPerPlayer: 0,
      currentPlayer: null,
      currentPlayerName: null,
      dealer: playerName,
      trumpSuit: null,
      leadSuit: null,
      currentTrick: [],
      isEvaluatingTrick: false
    };

    // Add first player
    game.players[playerName] = {
      socketId: socket.id,
      name: playerName,
      isHost: true,
      isConnected: true,
      lastConnected: Date.now()
    };

    // Initialize scores and plumps for the first player
    game.scores[socket.id] = 0;
    game.plumps[socket.id] = 0;

    games.set(gameId, game);
    socket.join(gameId);
    console.log('Emitting gameCreated event:', game);
    socket.emit('gameCreated', game);
    // Also emit initial game state
    socket.emit('gameStateUpdate', game);
  });

  socket.on('joinGame', ({ gameId, playerName }) => {
    if (activePlayers.has(playerName) && 
        activePlayers.get(playerName).socketId !== socket.id &&
        Date.now() - activePlayers.get(playerName).lastConnected < 30000) {
      socket.emit('error', 'Player name already in use');
      return;
    }
    console.log(`Join game attempt - Game: ${gameId}, Player: ${playerName}`);
    
    const game = games.get(gameId);
    if (!game) {
      socket.emit('error', 'Game not found');
      return;
    }

    if (Object.keys(game.players).length >= 4) {
      socket.emit('error', 'Game is full');
      return;
    }

    // Add new player to players object
    game.players[playerName] = {
      socketId: socket.id,
      name: playerName,
      isHost: false,
      isConnected: true,
      lastConnected: Date.now()
    };
    game.playerOrder.push(playerName);
    
    // Initialize scores and plumps for the new player
    game.scores[playerName] = 0;
    game.plumps[playerName] = 0;
    
    playerSockets.set(socket.id, { gameId, playerName });
    connectedPlayers.set(playerName, socket.id);
    
    socket.join(gameId);
    socket.emit('joinedGame', game);
    io.to(gameId).emit('gameStateUpdate', getGameState(game));
  });

  socket.on('startGame', ({ gameId }) => {
    console.log(`Start game request received for game: ${gameId}`);
    const game = games.get(gameId);
    if (!game) {
      console.error('Game not found:', gameId);
      socket.emit('error', 'Game not found');
      return;
    }

    if (game.playerOrder.length !== 4) {
      socket.emit('error', 'Need exactly 4 players to start');
      return;
    }

    console.log('Starting game with players:', game.playerOrder);

    // Ensure all players are in the room
    Object.values(game.players).forEach(player => {
      if (!io.sockets.adapter.rooms.get(gameId)?.has(player.socketId)) {
        io.sockets.sockets.get(player.socketId)?.join(gameId);
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
    game.playerOrder.forEach((playerName, index) => {
      const player = game.players[playerName];
      game.hands[playerName] = hands[index];
      io.to(player.socketId).emit('dealCards', hands[index]);
      console.log(`Dealt cards to ${player.name}`);
    });

    // Find dealer index and set first predictor
    const dealerIndex = game.playerOrder.indexOf(game.dealer);
    const firstPredictorIndex = getNextPlayerIndex(dealerIndex, game.players);
    
    game.phase = GAME_PHASES.MAKING_PREDICTIONS;
    const firstPredictor = game.playerOrder[firstPredictorIndex];
    game.currentPlayerName = firstPredictor;
    game.currentPlayer = game.players[firstPredictor].socketId;
    game.predictions = {};

    // Emit to room and directly to each player
    const gameState = getGameState(game);
    io.to(gameId).emit('gameStateUpdate', gameState);
    Object.values(game.players).forEach(player => {
      io.to(player.socketId).emit('gameStateUpdate', gameState);
    });
  });

  socket.on('makePrediction', ({ gameId, prediction }) => {
    const game = games.get(gameId);
    if (!game || game.phase !== GAME_PHASES.MAKING_PREDICTIONS) return;

    // Get player name from socket id
    const playerName = Object.keys(game.players).find(name => 
      game.players[name].socketId === socket.id
    );
    if (!playerName) return;

    // Store prediction by player name
    game.predictions[playerName] = Number(prediction);
    
    // Move to next player if not all predictions are made
    if (Object.keys(game.predictions).length < game.playerOrder.length) {
      const currentPlayerIndex = game.playerOrder.indexOf(playerName);
      const nextPlayerIndex = getNextPlayerIndex(currentPlayerIndex, game.players);
      const nextPlayerName = game.playerOrder[nextPlayerIndex];
      game.currentPlayerName = nextPlayerName;
      game.currentPlayer = game.players[nextPlayerName].socketId;
    }
    // When all predictions are made
    else if (Object.keys(game.predictions).length === game.playerOrder.length) {
      if (isSingleCardRound(game.roundNumber)) {
        console.log("All predictions made in single-card round - sending players their cards");
        game.phase = GAME_PHASES.PLAYING;
        
        // Set the first player (highest bidder) before sending cards
        game.highestBidder = getHighestBidder(game);
        game.currentPlayer = game.highestBidder;
        game.currentPlayerName = game.players.find(p => p.id === game.highestBidder).name;
        
        game.playerOrder.forEach((playerName) => {
          const player = game.players[playerName];
          io.to(player.socketId).emit('dealCards', {
            ownHand: game.hands[playerName],
            visibleOpponentCards: [],
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

    const playerName = Object.keys(game.players).find(name => 
      game.players[name].socketId === socket.id
    );
    if (playerName !== game.currentPlayerName) {
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

    const playerName = Object.keys(game.players).find(name => 
      game.players[name].socketId === socket.id
    );
    if (playerName !== game.currentPlayerName) {
      socket.emit('error', 'Not your turn');
      return;
    }

    // Prevent playing while trick is being evaluated
    if (game.isEvaluatingTrick) {
      socket.emit('error', 'Please wait for the current trick to complete');
      return;
    }

    // Validate the play
    const isValidPlay = validatePlay(game, playerName, card);
    if (!isValidPlay.valid) {
      socket.emit('error', isValidPlay.message);
      return;
    }

    // Remove card from player's hand
    game.hands[playerName] = game.hands[playerName].filter(c => 
      !(c.suit === card.suit && c.value === card.value)
    );

    // Add card to current trick
    game.currentTrick.push({ playerName, card });

    // Set lead suit if first card
    if (game.currentTrick.length === 1) {
      game.leadSuit = card.suit;
    }

    // If trick is complete (4 cards), evaluate winner
    if (game.currentTrick.length === 4) {
      game.isEvaluatingTrick = true;  // Set the lock
      const winningPlay = evaluateTrick(game.currentTrick, game.trumpSuit, game.leadSuit, game.roundNumber);
      const winnerName = winningPlay.playerName;
      game.tricks[winnerName] = (game.tricks[winnerName] || 0) + 1;

      game.trickWinner = {
        playerName: winnerName,
        socketId: game.players[winnerName].socketId,
        card: winningPlay.card
      };
      
      io.to(gameId).emit('gameStateUpdate', getGameState(game));

      setTimeout(() => {
        // Clear the current trick and lead suit
        game.currentTrick = [];
        game.leadSuit = null;
        game.trickWinner = null;

        // Check if round is complete
        const totalTricks = Object.values(game.tricks).reduce((sum, count) => sum + count, 0);
        if (totalTricks === game.cardsPerPlayer) {
          // Update scores based on predictions
          Object.entries(game.tricks).forEach(([playerName, trickCount]) => {
            const prediction = game.predictions[playerName];
            if (prediction === trickCount) {
              game.scores[playerName] = (game.scores[playerName] || 0) + 10 + trickCount;
            } else {
              game.plumps[playerName] = (game.plumps[playerName] || 0) + 1;
            }
          });

          console.log('Round complete - All predictions and tricks:', {
            predictions: game.predictions,
            tricks: game.tricks,
            cardsPerPlayer: game.cardsPerPlayer,
            totalTricksPlayed: totalTricks
          });

          calculateScores(game);

          // Check if game is over or start new round
          if (game.roundNumber === 28) {
            game.phase = GAME_PHASES.GAME_OVER;
            game.message = 'Game Over!';
            
            // Create results table
            const resultsTable = game.playerOrder.map(playerName => ({
              playerName,
              score: game.scores[playerName] || 0,
              plumps: game.plumps[playerName] || 0,
              date: new Date().toISOString()
            }));

            // Send email with results
            sendGameResults(resultsTable);
          } else {
            startNewRound(game);
          }
        } else {
          // Round continues - winner of trick starts next trick
          game.currentPlayer = winnerName;
          game.currentPlayerName = game.players.find(p => p.name === winnerName).name;
        }

        io.to(gameId).emit('gameStateUpdate', game);
      }, TRICK_DISPLAY_TIME);
    } else {
      // Move to next player
      const currentPlayerIndex = game.players.findIndex(p => p.name === playerName);
      const nextPlayerIndex = getNextPlayerIndex(currentPlayerIndex, game.players);
      game.currentPlayer = game.players[nextPlayerIndex].name;
      game.currentPlayerName = game.players[nextPlayerIndex].name;
    }

    io.to(gameId).emit('gameStateUpdate', game);
  });

  socket.on('setHighestBidder', ({ gameId, highestBidder }) => {
    const game = games.get(gameId);
    if (!game || game.phase !== GAME_PHASES.PLAYING) return;

    if (!game.highestBidder) {
      game.highestBidder = highestBidder;
      io.to(gameId).emit('gameStateUpdate', game);
    }
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
      game.playerOrder.forEach(playerName => {
        results.push({
          playerName,
          score: game.scores[playerName] || 0,
          plumps: game.plumps[playerName] || 0,
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

// Before starting server
server.listen(PORT, '0.0.0.0', async () => {
  await initTables();
  console.log(`Server running on port ${PORT}`);
});

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