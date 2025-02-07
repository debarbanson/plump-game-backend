const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');

// Create pool using environment variables from Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Render's PostgreSQL
  }
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

module.exports = { pool, initDb }; 