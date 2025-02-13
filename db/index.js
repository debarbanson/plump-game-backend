const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');

// Create pool using environment variables from Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Render's PostgreSQL
  },
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection not established
  maxUses: 7500, // Close and replace a connection after it has been used 7500 times
});

// Test database connection
pool.connect((err, client, done) => {
  if (err) {
    console.error('Error connecting to database:', err);
  } else {
    console.log('Successfully connected to database');
    done();
  }
});

// Initialize database with schema
async function initDb() {
  try {
    const schema = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('Database schema initialized');
  } catch (err) {
    console.error('Error initializing database:', err);
    throw err;
  }
}

// Add event listeners for pool
pool.on('connect', (client) => {
  console.log('New client connected to pool');
});

pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
});

pool.on('remove', () => {
  console.log('Client removed from pool');
});

// Add transaction wrapper
const withTransaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// Export the transaction wrapper
module.exports = { pool, initDb, withTransaction }; 