import dotenv from "dotenv";
import pg from "pg";
import fs from "fs";
import csv from "csv-parser";

dotenv.config();

const { Client } = pg;

const FINAL_CSV = './books_1.Best_Books_Ever.csv';

const db = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

const cleanGenres = (genresString) => {
  if (!genresString) return null;
  let cleaned = genresString.replace(/^[\[]/, '').replace(/[\]]$/, '');
  cleaned = cleaned.replace(/'/g, '').replace(/\s+/g, ' ').trim();
  if (cleaned === "") return null;
  return cleaned;
};

async function upsertBook(client, bookData) {
  const sql = `
    INSERT INTO books (title, author, genre, rating, description, cover_url, display_order)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (title, author) DO NOTHING;
  `;
  const params = [
    bookData.title,
    bookData.author,
    bookData.genre,
    bookData.rating,
    bookData.description,
    bookData.cover_url,
    bookData.display_order
  ];
  await client.query(sql, params);
}

async function runSeed() {
  await db.connect();
  console.log("✅ Connected to DB — starting CSV seed...");

  // --- Step 1: Ensure display_order column exists ---
  await db.query(`
    ALTER TABLE books 
    ADD COLUMN IF NOT EXISTS display_order INTEGER;
  `);

  // --- Step 2: Clear old data ---
  await db.query('DELETE FROM books;');
  console.log("🧹 Old data cleared.");

  let totalInserted = 0;
  let displayOrderCounter = 1; // start order from 1

  const stream = fs.createReadStream(FINAL_CSV).pipe(csv());

  stream.on('data', async (row) => {
    stream.pause();

    const bookData = {
      title: row['title']?.trim() || null,
      author: row['author']?.trim() || null,
      rating: parseFloat(row['rating']) || null,
      description: row['description']?.trim() || null,
      cover_url: row['coverImg']?.trim() || null,
      genre: cleanGenres(row['genres']),
      display_order: displayOrderCounter++
    };

    if (bookData.title && bookData.author) {
      try {
        await upsertBook(db, bookData);
        totalInserted++;
      } catch (err) {
        console.error(`⚠️ DB error for "${bookData.title}": ${err.message}`);
      }
    }

    stream.resume();
  });

  await new Promise((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  console.log(`✅ Finished. Total books inserted: ${totalInserted}`);
  await db.end();
  console.log("🔒 DB closed. Done.");
}

runSeed().catch(err => {
  console.error("❌ Fatal error during seed:", err);
  db.end();
});
