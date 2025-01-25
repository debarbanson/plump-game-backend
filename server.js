const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
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
  }
});

// Game constants and utilities
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
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

const getNextPlayerIndex = (currentIndex, players) => {
  return (currentIndex + 1) % players.length;
};

// Game state storage
const games = new Map();
const playerSockets = new Map();
const connectedPlayers = new Map();
const activeConnections = new Map();
const disconnectedPlayers = new Map();  // Keep only one instance of each

// New helper function for card validation
const validatePlay = (game, playerId, card) => {
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
const getCardValue = (value) => {
  const valueOrder = {
    'A': 14, 'K': 13, 'Q': 12, 'J': 11,
    '10': 10, '9': 9, '8': 8, '7': 7,
    '6': 6, '5': 5, '4': 4, '3': 3, '2': 2
  };
  return valueOrder[value] || parseInt(value);
};

// Updated evaluateTrick function
const evaluateTrick = (trick, trumpSuit, leadSuit) => {
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

// Helper function to start a new round
const startNewRound = (game) => {
  game.roundNumber++;
  game.phase = GAME_PHASES.DEALING;
  game.tricks = {};
  game.predictions = {};
  game.trumpSuit = null;
  game.leadSuit = null;
  game.currentTrick = [];
  game.highestBidder = null;

  // Calculate cards for this round
  if (game.roundNumber <= 13) {
    game.cardsPerPlayer = 14 - game.roundNumber; // 13,12,11...2,1
  } else if (game.roundNumber <= 16) {
    game.cardsPerPlayer = 1; // Four rounds of 1 (rounds 13,14,15,16)
  } else {
    game.cardsPerPlayer = game.roundNumber - 15; // 2,3,4...12,13
  }

  // Deal new cards
  const deck = shuffleDeck(createDeck());
  const hands = dealCards(deck, 4, game.cardsPerPlayer);

  // Validate hands before assigning
  const handSizes = hands.map(hand => hand.length);
  if (handSizes.some(size => size !== game.cardsPerPlayer)) {
    console.error('Invalid deal detected:', {
      round: game.roundNumber,
      expectedCards: game.cardsPerPlayer,
      actualSizes: handSizes
    });
    // Retry the deal
    const newHands = dealCards(shuffleDeck(createDeck()), 4, game.cardsPerPlayer);
    if (newHands.every(hand => hand.length === game.cardsPerPlayer)) {
      hands = newHands;
    }
  }

  game.hands = {};
  if (game.roundNumber >= 13 && game.roundNumber <= 16) {
    // For 1-card rounds, each player only sees others' cards initially
    game.players.forEach((player, index) => {
      // Store the actual hand
      game.hands[player.id] = hands[index];
      
      // Send other players' cards to this player
      const visibleCards = game.players.map((p, i) => {
        if (p.id !== player.id) {
          return { playerId: p.id, card: hands[i][0] };
        }
        return null;
      }).filter(Boolean);

      // Only send visible cards initially, own card will be sent after predictions
      io.to(player.id).emit('dealVisibleCards', visibleCards);
    });
  } else {
    // Normal rounds - players see their own cards
    game.players.forEach((player, index) => {
      game.hands[player.id] = hands[index];
      io.to(player.id).emit('dealCards', hands[index]);
    });
  }

  // Set first player (after dealer) for predictions
  const currentDealerIndex = game.players.findIndex(p => p.id === game.dealerId);
  const nextDealerIndex = getNextPlayerIndex(currentDealerIndex, game.players);
  game.dealerId = game.players[nextDealerIndex].id;
  game.dealer = game.players[nextDealerIndex].name;

  const firstPlayerIndex = getNextPlayerIndex(nextDealerIndex, game.players);
  game.currentPlayer = game.players[firstPlayerIndex].id;
  game.currentPlayerName = game.players[firstPlayerIndex].name;
  game.phase = GAME_PHASES.MAKING_PREDICTIONS;

  // Initialize tricks for all players
  game.tricks = {};
  game.players.forEach(player => {
    game.tricks[player.id] = 0;  // Initialize all players with 0 tricks
  });
};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  activeConnections.set(socket.id, { connected: true });

  socket.on('createGame', ({ playerName }) => {
    console.log(`Create game attempt - Player: ${playerName}`);
    
    const gameId = generateGameId();
    const player = { id: socket.id, name: playerName, isHost: true, score: 0 };
    
    const gameState = {
      gameId,
      players: [player],
      phase: GAME_PHASES.WAITING_FOR_PLAYERS,
      currentPlayer: null,
      currentPlayerName: null,
      dealer: playerName,
      dealerId: socket.id,
      roundNumber: 1,
      cardsPerPlayer: 1,
      predictions: {},
      tricks: {},
      scores: {},
      hands: {},  // New: track player hands
      trumpSuit: null,
      leadSuit: null,
      currentTrick: [],
      message: null,
      highestBidder: null,
      isEvaluatingTrick: false
    };
    
    games.set(gameId, gameState);
    playerSockets.set(socket.id, { gameId, playerName });
    connectedPlayers.set(playerName, socket.id);
    
    socket.join(gameId);
    socket.emit('gameCreated', gameState);
  });

  socket.on('joinGame', ({ gameId, playerName }) => {
    // Check if this is a reconnecting player
    const disconnectedPlayer = disconnectedPlayers.get(playerName);
    if (disconnectedPlayer && disconnectedPlayer.gameId === gameId) {
      const game = games.get(gameId);
      if (game) {
        // Update the player's socket id
        const playerIndex = game.players.findIndex(p => p.name === playerName);
        if (playerIndex !== -1) {
          game.players[playerIndex].id = socket.id;
          game.players[playerIndex].disconnected = false;
        }

        // Remove from disconnected players
        disconnectedPlayers.delete(playerName);

        // If all players are back, resume the game
        if (!game.players.some(p => p.disconnected)) {
          game.phase = game.previousPhase || GAME_PHASES.WAITING_FOR_PLAYERS;
          delete game.previousPhase;
          game.message = 'Game resumed';
        }

        socket.join(gameId);
        socket.emit('gameJoined', { gameId, gameState: game });
        io.to(gameId).emit('gameStateUpdate', game);
        return;
      }
    }

    const connectionInfo = activeConnections.get(socket.id);
    if (connectionInfo && connectionInfo.lastJoinAttempt === `${gameId}-${playerName}`) {
      console.log('Duplicate join attempt, ignoring');
      return;
    }
    
    console.log(`Join game attempt - Game: ${gameId}, Player: ${playerName}`);
    
    const game = games.get(gameId);
    if (!game) {
      socket.emit('error', 'Game not found');
      return;
    }
    
    if (game.players.length >= 4) {
      socket.emit('error', 'Game is full');
      return;
    }
    
    if (game.phase !== GAME_PHASES.WAITING_FOR_PLAYERS) {
      socket.emit('error', 'Game already started');
      return;
    }
    
    if (game.players.some(p => p.name === playerName)) {
      socket.emit('error', 'Player name already taken');
      return;
    }
    
    const player = { id: socket.id, name: playerName, isHost: false, score: 0 };
    game.players.push(player);
    
    playerSockets.set(socket.id, { gameId, playerName });
    connectedPlayers.set(playerName, socket.id);
    
    socket.join(gameId);
    io.to(gameId).emit('gameStateUpdate', game);
    
    activeConnections.set(socket.id, {
      ...connectionInfo,
      lastJoinAttempt: `${gameId}-${playerName}`
    });
  });

  socket.on('startGame', ({ gameId }) => {
    const game = games.get(gameId);
    if (!game) return;

    if (game.players.length !== 4) {
      socket.emit('error', 'Need exactly 4 players to start');
      return;
    }

    game.phase = GAME_PHASES.DEALING;
    game.roundNumber = 1;
    game.cardsPerPlayer = 13;
    game.tricks = {};
    game.scores = {};
    game.hands = {};
    game.highestBidder = null;

    const deck = shuffleDeck(createDeck());
    const hands = dealCards(deck, 4, game.cardsPerPlayer);
    
    game.players.forEach((player, index) => {
      game.hands[player.id] = hands[index];
      io.to(player.id).emit('dealCards', hands[index]);
    });

    const dealerIndex = game.players.findIndex(p => p.id === game.dealerId);
    const firstPredictorIndex = getNextPlayerIndex(dealerIndex, game.players);
    
    game.phase = GAME_PHASES.MAKING_PREDICTIONS;
    game.currentPlayer = game.players[firstPredictorIndex].id;
    game.currentPlayerName = game.players[firstPredictorIndex].name;
    game.predictions = {};

    io.to(gameId).emit('gameStateUpdate', game);
  });

  socket.on('makePrediction', ({ gameId, prediction }) => {
    const game = games.get(gameId);
    if (!game || game.phase !== GAME_PHASES.MAKING_PREDICTIONS) return;

    if (socket.id !== game.currentPlayer) {
      socket.emit('error', 'Not your turn');
      return;
    }

    // Only validate the last predictor to prevent total equaling number of tricks
    const isLastPredictor = Object.keys(game.predictions).length === 3;
    if (isLastPredictor) {
      const predictionsSum = Object.values(game.predictions).reduce((sum, pred) => sum + pred, 0);
      if ((predictionsSum + prediction) === game.cardsPerPlayer) {
        socket.emit('error', `Your prediction cannot make the total equal ${game.cardsPerPlayer}`);
        return;
      }
    }

    console.log(`Player ${socket.id} made prediction: ${prediction}`);
    game.predictions[socket.id] = prediction;

    if (Object.keys(game.predictions).length === 4) {
      if (game.roundNumber >= 13 && game.roundNumber <= 16) {
        // Now reveal each player's own card
        game.players.forEach((player) => {
          io.to(player.id).emit('dealCards', game.hands[player.id]);
        });
        
        // Find first player who predicted 1, or current player if all predicted 0
        let startingPlayer = null;
        for (const [playerId, pred] of Object.entries(game.predictions)) {
          if (pred === 1) {
            startingPlayer = playerId;
            break;
          }
        }
        // If no one predicted 1, use current player
        if (!startingPlayer) {
          startingPlayer = game.currentPlayer;
        }

        game.phase = GAME_PHASES.PLAYING;
        game.currentPlayer = startingPlayer;
        game.currentPlayerName = game.players.find(p => p.id === startingPlayer).name;
        game.highestBidder = startingPlayer;
      } else {
        // Normal rounds - proceed to trump selection
        let highestPrediction = -1;
        let trumpSelector = null;
        
        Object.entries(game.predictions).forEach(([playerId, pred]) => {
          if (pred > highestPrediction) {
            highestPrediction = pred;
            trumpSelector = playerId;
          }
        });
        
        game.phase = GAME_PHASES.SELECTING_TRUMP;
        game.currentPlayer = trumpSelector;
        game.currentPlayerName = game.players.find(p => p.id === trumpSelector).name;
        game.highestBidder = trumpSelector;
      }
    } else {
      const currentPlayerIndex = game.players.findIndex(p => p.id === socket.id);
      const nextPlayerIndex = getNextPlayerIndex(currentPlayerIndex, game.players);
      game.currentPlayer = game.players[nextPlayerIndex].id;
      game.currentPlayerName = game.players[nextPlayerIndex].name;
    }

    io.to(gameId).emit('gameStateUpdate', game);
  });

  socket.on('selectTrump', ({ gameId, suit }) => {
    const game = games.get(gameId);
    if (!game || game.phase !== GAME_PHASES.SELECTING_TRUMP) return;

    if (socket.id !== game.currentPlayer) {
      socket.emit('error', 'Not your turn to select trump');
      return;
    }

    console.log('Before trump selection:', {
      currentPlayer: game.currentPlayer,
      highestBidder: game.highestBidder
    });

    game.trumpSuit = suit;
    game.phase = GAME_PHASES.PLAYING;
    
    // Ensure highest bidder is maintained and set as current player
    if (!game.highestBidder) {
      // If somehow highestBidder was lost, recalculate it
      let highestPrediction = -1;
      Object.entries(game.predictions).forEach(([playerId, pred]) => {
        if (pred > highestPrediction) {
          highestPrediction = pred;
          game.highestBidder = playerId;
        }
      });
    }
    
    game.currentPlayer = game.highestBidder;
    game.currentPlayerName = game.players.find(p => p.id === game.highestBidder).name;

    console.log('After trump selection:', {
      phase: game.phase,
      currentPlayer: game.currentPlayer,
      highestBidder: game.highestBidder,
      predictions: game.predictions
    });

    io.to(gameId).emit('gameStateUpdate', game);
  });

  socket.on('playCard', ({ gameId, card }) => {
    const game = games.get(gameId);
    if (!game || game.phase !== GAME_PHASES.PLAYING) return;

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

    // Remove card from player's hand
    game.hands[socket.id] = game.hands[socket.id].filter(c => 
      !(c.suit === card.suit && c.value === card.value)
    );

    // Add card to current trick
    game.currentTrick.push({ playerId: socket.id, card });

    // Set lead suit if first card
    if (game.currentTrick.length === 1) {
      game.leadSuit = card.suit;
    }

    // If trick is complete (4 cards), evaluate winner
    if (game.currentTrick.length === 4) {
      game.isEvaluatingTrick = true;  // Set the lock
      const winningPlay = evaluateTrick(game.currentTrick, game.trumpSuit, game.leadSuit);
      const winner = winningPlay.playerId;
      game.tricks[winner] = (game.tricks[winner] || 0) + 1;

      game.trickWinner = {
        playerId: winner,
        playerName: game.players.find(p => p.id === winner).name,
        card: winningPlay.card
      };
      
      io.to(gameId).emit('gameStateUpdate', game);

      setTimeout(() => {
        game.currentTrick = [];
        game.leadSuit = null;
        game.trickWinner = null;
        game.isEvaluatingTrick = false;

        // Check if round is over
        const totalTricks = Object.values(game.tricks).reduce((sum, count) => sum + count, 0);
        if (totalTricks === game.cardsPerPlayer) {
          console.log('Round complete - All predictions and tricks:', {
            predictions: game.predictions,
            tricks: game.tricks,
            cardsPerPlayer: game.cardsPerPlayer,
            totalTricksPlayed: totalTricks
          });

          game.players.forEach(player => {
            const trickCount = game.tricks[player.id] || 0;  // Ensure we get 0 if undefined
            const prediction = game.predictions[player.id];
            
            console.log('Checking player score:', {
              playerName: player.name,
              playerId: player.id,
              prediction: prediction,
              trickCount: trickCount,
              isEqual: Number(trickCount) === Number(prediction)
            });

            if (Number(trickCount) === Number(prediction)) {
              let points;
              
              // Rule 1: For predictions 10-13, multiply by 10
              if (prediction >= 10 && prediction <= 13) {
                points = prediction * 10;
              } 
              // Rule 2: For predictions 0-9, prediction + 10
              else {
                points = Number(prediction) + 10;
              }

              console.log('Scoring calculation:', {
                player: player.name,
                prediction: prediction,
                trickCount: trickCount,
                points: points,
                rule: prediction >= 10 ? `${prediction} × 10 = ${points}` : `${prediction} + 10 = ${points}`
              });

              game.scores[player.id] = (game.scores[player.id] || 0) + points;
              
              // Log after scoring
              console.log('Points awarded:', {
                playerName: player.name,
                oldScore: game.scores[player.id] - points,
                pointsAwarded: points,
                newScore: game.scores[player.id]
              });
            }
          });

          // Check if game is over or start new round
          if (game.roundNumber === 28) {
            game.phase = GAME_PHASES.GAME_OVER;
            game.message = 'Game Over!';
          } else {
            startNewRound(game);
          }
        } else {
          // Round continues - winner of trick starts next trick
          game.currentPlayer = winner;
          game.currentPlayerName = game.players.find(p => p.id === winner).name;
        }

        io.to(gameId).emit('gameStateUpdate', game);
      }, TRICK_DISPLAY_TIME);
    } else {
      // Move to next player
      const currentPlayerIndex = game.players.findIndex(p => p.id === socket.id);
      const nextPlayerIndex = getNextPlayerIndex(currentPlayerIndex, game.players);
      game.currentPlayer = game.players[nextPlayerIndex].id;
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

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Find game this player was in
    const gameToUpdate = [...games.values()].find(game => 
      game.players.some(p => p.id === socket.id)
    );

    if (gameToUpdate) {
      const player = gameToUpdate.players.find(p => p.id === socket.id);
      
      // Store disconnected player info
      disconnectedPlayers.set(player.name, {
        gameId: gameToUpdate.gameId,
        timestamp: Date.now(),
        playerId: socket.id
      });

      // Mark player as disconnected
      const playerIndex = gameToUpdate.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        gameToUpdate.players[playerIndex].disconnected = true;
      }

      // If game is in progress, pause it
      if (gameToUpdate.phase !== GAME_PHASES.WAITING_FOR_PLAYERS) {
        gameToUpdate.previousPhase = gameToUpdate.phase;
        gameToUpdate.phase = GAME_PHASES.PAUSED;
        gameToUpdate.message = `Game paused - waiting for ${player.name} to reconnect`;
      }

      // Notify other players
      io.to(gameToUpdate.gameId).emit('gameStateUpdate', gameToUpdate);
    }
  });

  socket.on('rejoinGame', ({ gameId, playerName }) => {
    console.log(`Rejoin attempt - Game: ${gameId}, Player: ${playerName}`);
    
    const game = games.get(gameId);
    if (game) {
      // Update player's new socket ID
      const player = game.players.find(p => p.name === playerName);
      if (player) {
        player.id = socket.id;
        player.disconnected = false;  // Clear disconnected flag
        
        // Update tracking maps
        playerSockets.set(socket.id, { gameId, playerName });
        connectedPlayers.set(playerName, socket.id);
        disconnectedPlayers.delete(playerName);  // Remove from disconnected list
        
        // Restore game phase if all players reconnected
        if (game.phase === GAME_PHASES.PAUSED && 
            !game.players.some(p => p.disconnected)) {
          game.phase = game.previousPhase;
          game.message = null;
        }
        
        // Join socket room
        socket.join(gameId);
        
        // Send current game state
        socket.emit('gameStateUpdate', game);
        io.to(gameId).emit('gameStateUpdate', game);  // Update all players
        console.log(`Player ${playerName} rejoined game ${gameId}`);
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});