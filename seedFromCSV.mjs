import dotenv from "dotenv";
import pg from "pg";
import fs from "fs";
import csv from "csv-parser";

dotenv.config();

const { Client } = pg;
const FINAL_CSV = "./books_1.Best_Books_Ever.csv";

// Database connection
const db = new Client(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      }
    : {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
      }
);

// --- Helper function to clean genres ---
function cleanGenres(genresString) {
  if (!genresString) return null;
  let cleaned = genresString.replace(/^[\[]/, "").replace(/[\]]$/, "");
  cleaned = cleaned.replace(/'/g, "").replace(/\s+/g, " ").trim();
  return cleaned === "" ? null : cleaned;
}

async function runSeed() {
  await db.connect();
  console.log("✅ Connected to DB — starting CSV seed...");

  // ✅ Ensure unique constraint exists for ON CONFLICT to work
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'unique_title_author'
      ) THEN
        ALTER TABLE books ADD CONSTRAINT unique_title_author UNIQUE (title, author);
      END IF;
    END
    $$;
  `);

  // ✅ Ensure display_order column exists
  await db.query(`ALTER TABLE books ADD COLUMN IF NOT EXISTS display_order INTEGER;`);

  // ✅ Clear old data
  await db.query("DELETE FROM books;");
  console.log("🧹 Old data cleared.");

  let totalInserted = 0;
  let displayOrder = 1;
  const BATCH_SIZE = 100;
  let batch = [];

  const stream = fs.createReadStream(FINAL_CSV).pipe(csv());

  // Insert a batch of rows
  async function insertBatch(rows) {
    if (rows.length === 0) return;
    const values = [];
    const params = [];
    let i = 1;
    for (const r of rows) {
      values.push(
  `($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`
);
      params.push(
        r.title,
        r.author,
        r.genre,
        r.rating,
        r.description,
        r.cover_url
      );
    }

    const sql = `
      INSERT INTO books (title, author, genre, rating, description, cover_url)
      VALUES ${values.join(", ")}
      ON CONFLICT (title, author) DO NOTHING;
    `;
    await db.query(sql, params);
    totalInserted += rows.length;
    console.log(`📚 Inserted ${rows.length} books (Total: ${totalInserted})`);
  }

  stream.on("data", (row) => {
    const book = {
      title: row["title"]?.trim() || null,
      author: row["author"]?.trim() || null,
      rating: parseFloat(row["rating"]) || null,
      description: row["description"]?.trim() || null,
      cover_url: row["coverImg"]?.trim() || null,
      genre: cleanGenres(row["genres"]),
      display_order: displayOrder++,
    };

    if (book.title && book.author) batch.push(book);

    if (batch.length >= BATCH_SIZE) {
      stream.pause();
      insertBatch(batch.splice(0, batch.length))
        .then(() => stream.resume())
        .catch((err) => {
          console.error("⚠️ Batch insert error:", err.message);
          stream.resume();
        });
    }
  });

  stream.on("end", async () => {
    await insertBatch(batch);
    console.log(`✅ Finished seeding! Total books inserted: ${totalInserted}`);
    await db.end();
    console.log("🔒 DB connection closed.");
  });

  stream.on("error", (err) => {
    console.error("❌ Stream error:", err);
    db.end();
  });
}

runSeed().catch((err) => {
  console.error("❌ Fatal error:", err);
  db.end();
});
