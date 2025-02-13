const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later'
});

const socketLimiter = {
  windowMs: 1000, // 1 second
  maxRequests: 20,
  clients: new Map(),

  checkLimit(socket) {
    const now = Date.now();
    const clientData = this.clients.get(socket.id) || { requests: [], blocked: false };
    
    // Remove old requests
    clientData.requests = clientData.requests.filter(time => 
      time > now - this.windowMs
    );

    if (clientData.requests.length >= this.maxRequests) {
      clientData.blocked = true;
      this.clients.set(socket.id, clientData);
      return false;
    }

    clientData.requests.push(now);
    this.clients.set(socket.id, clientData);
    return true;
  },

  // Add cleanup function
  cleanup() {
    const now = Date.now();
    for (const [socketId, clientData] of this.clients.entries()) {
      if (clientData.requests.every(time => time < now - this.windowMs)) {
        this.clients.delete(socketId);
      }
    }
  }
};

// Run cleanup every minute
setInterval(() => socketLimiter.cleanup(), 60000);

module.exports = { limiter, socketLimiter }; 