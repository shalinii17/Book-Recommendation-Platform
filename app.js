
import express from "express";
import pg from "pg";
import dotenv from "dotenv";
import session from "express-session";
import bcrypt from "bcryptjs";
import flash from "connect-flash";
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// --- Middleware (IMPORTANT: these come BEFORE routes)
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "mysecretkey",
    resave: false,
    saveUninitialized: true,
  })
);

app.use(flash()); 

// Middleware to make flash messages available to all templates:
app.use((req, res, next) => {
  res.locals.success = req.flash("success");  
  res.locals.error = req.flash("error");
  next();
});


let dbConfig;

if (process.env.DATABASE_URL) {
  // Use the single connection string provided by Render
  dbConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false // Required for Render to connect securely
    }
  };
} else {
  // Fallback for local development
  dbConfig = {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
  };
}

const db = new db(dbConfig);

await db.connect(); // top-level await allowed in modern node; if not, use .connect().then(...)

// make logged-in user available to all templates
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

app.set("view engine", "ejs");

// --- Helper middleware
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

// -------------------- Public routes --------------------

// Signup page
app.get("/signup", (req, res) => {
  res.render("signup.ejs", { title: "Sign Up" });
});

// Signup handler
app.post("/signup", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.send("All fields required.");

    const found = await db.query("SELECT id FROM users WHERE email=$1", [email]);
    if (found.rows.length > 0) {
      req.flash("error", "User already exists. Try logging in!");
      return res.redirect("/signup");
    }

    const hashed = await bcrypt.hash(password, 10);
    await db.query(
      "INSERT INTO users (username, email, password) VALUES ($1, $2, $3)",
      [username, email, hashed]
    );
    req.flash("success", "Signup successful! You can now log in.");
    res.redirect("/login");
  } catch (err) {
    console.error(err);
    req.flash("error", "Something went wrong during signup.");
    res.redirect("/signup");
  }
});




// Login page
app.get("/login", (req, res) => {
  res.render("login.ejs", { title: "Login" });
});

// Login handler
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.send("Please enter both email and password.");

    const result = await db.query("SELECT * FROM users WHERE email=$1", [email]);
  if (result.rows.length === 0) {
      req.flash("error", "User not found. Please sign up first.");
      return res.redirect("/login");
  }

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      req.flash("error", "Incorrect password. Try again.");
      return res.redirect("/login");
    }
    

    //success
    req.session.user = { id: user.id, username: user.username, email: user.email };
    req.flash("success", "Logged in successfully!");
    res.redirect("/");
  } catch (err) {
    console.error(err);
    req.flash("error", "Login error. Try again.");
    res.redirect("/login");
  }
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// -------------------- Protected actions --------------------

// Add Book route
app.post("/add", requireLogin, async (req, res) => {
  try {
    const { title, author, genre = "", rating } = req.body;
    const redirectTo = req.body.redirect || "/profile?tab=already";  // default to already read tab

    if (!title || !author) {
      return res.send("Title and Author are required to add a book.");
    }

    const cleanedGenre = genre.split(",").map(g => g.trim()).filter(Boolean).join(", ");
    const ratingValue = rating === "" || rating === undefined ? null : parseFloat(rating);

    // 1. Check if book exists in main books table
    const existing = await db.query(
      "SELECT id FROM books WHERE LOWER(title)=LOWER($1) AND LOWER(author)=LOWER($2)",
      [title, author]
    );

    let bookId;
    if (existing.rows.length > 0) {
      bookId = existing.rows[0].id;
    } else {
      const inserted = await db.query(
        "INSERT INTO books (title, author, genre, rating, description) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [title, author, cleanedGenre, ratingValue, null]
      );
      bookId = inserted.rows[0].id;
    }

    // 2. Insert into user_books for this user if not already present
    const userBookCheck = await db.query(
      "SELECT * FROM user_books WHERE user_id=$1 AND book_id=$2",
      [req.session.user.id, bookId]
    );


    if (userBookCheck.rows.length > 0) {
      req.flash("error", "You already have this book in your list.");
      return res.redirect(req.body.redirect || "/profile?tab=already");
    }

    if (userBookCheck.rows.length === 0) {
      await db.query(
        "INSERT INTO user_books (user_id, book_id, status, rating, review, created_at) VALUES ($1, $2, $3, $4, $5, NOW())",
        [req.session.user.id, bookId, "already read", ratingValue, null]
      );
    }

    // after adding book
    req.flash("success", "Book added to your list successfully!");
    res.redirect(req.body.redirect || "/profile?tab=already");

  } catch (err) {
     console.error("Error adding book", err);
     req.flash("error", "Could not add the book. Something went wrong.");
     res.redirect(req.body.redirect || "/profile?tab=already");
  }
});











// Profile route (already read tab fetch + others)
app.get("/profile", requireLogin, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const tab = req.query.tab || "already";
    const queryTerm = req.query.query?.trim() || "";

    // optional searchedBook logic if you have search

    let status;
    if (tab === "recommend") status = "recommend";
    else if (tab === "save") status = "save";
    else status = "already read";

    let sql = `
      SELECT b.*, ub.status, ub.rating AS user_rating, ub.review AS user_review
      FROM books b
      JOIN user_books ub ON b.id = ub.book_id
      WHERE ub.user_id = $1 AND ub.status = $2
    `;
    const params = [userId, status];

    // Optional search/filter inside user's books
    if (req.query.user_query && req.query.user_query.trim() !== "") {
      const uq = req.query.user_query.trim();
      params.push(`%${uq}%`);
      sql += ` AND (LOWER(b.title) LIKE LOWER($${params.length}) OR LOWER(b.author) LIKE LOWER($${params.length}))`;
    }

    sql += " ORDER BY b.rating DESC";

    const userBooksResult = await db.query(sql, params);

    res.render("profile.ejs", {
      title: "My Profile",
      tab,
      query: queryTerm,
      searchedBook: null,   // or set if you want search of main books
      books: userBooksResult.rows,
    });
  } catch (err) {
    console.error("Error in GET /profile:", err);
    res.status(500).send("Error loading profile");
  }
});



// Mark (update and insert ) user_book — action: 'already read' | 'recommend' | 'save'
app.post("/mark", requireLogin, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const bookId = parseInt(req.body.book_id, 10);
    const action = req.body.action === "recommend" ? "recommend" : (req.body.action === "save" ? "save" : "already read");
    const rating = req.body.rating === "" || req.body.rating === undefined ? null : parseFloat(req.body.rating);
    const review = req.body.review ? req.body.review.trim() : null;
    const redirectTo = req.body.redirect || "/profile";

    await db.query(
      `INSERT INTO user_books (user_id, book_id, status, rating, review, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (user_id, book_id)
       DO UPDATE SET status = EXCLUDED.status,
                     rating = EXCLUDED.rating,
                     review = EXCLUDED.review,
                     created_at = EXCLUDED.created_at`,
      [userId, bookId, action, rating, review]
    );

    req.flash("success", "Updated book status/rating/review successfully.");
    res.redirect(req.body.redirect || "/profile?tab=already");
  } catch (err) {
    console.error(err);
    req.flash("error", "Error updating book. Please try again.");
    res.redirect(req.body.redirect || "/profile?tab=already");
  }
});

// Unmark (remove) user_book
app.post("/unmark", requireLogin, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const bookId = parseInt(req.body.book_id, 10);
    const redirectTo = req.body.redirect || "/profile";
    await db.query("DELETE FROM user_books WHERE user_id=$1 AND book_id=$2", [userId, bookId]);

    req.flash("success", "Book removed from your list.");
    res.redirect(req.body.redirect || "/profile?tab=already");
  } catch (err) {
    console.error(err);
    req.flash("error", "Could not remove the book. Please try again.");
    res.redirect(req.body.redirect || "/profile?tab=already");
  }
});

// Edit book (update main books table)
app.post("/edit/:id", requireLogin, async (req, res) => {
  try {
    const bookId = parseInt(req.params.id, 10);
    const { title, author, genre, rating } = req.body;
    const ratingValue = rating === "" ? null : parseFloat(rating);
    await db.query("UPDATE books SET title=$1, author=$2, genre=$3, rating=$4 WHERE id=$5", [title, author, genre, ratingValue, bookId]);
    res.redirect("/");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error updating book");
  }
});

// Delete book (remove book completely — also remove user_books entries first)
app.post("/delete", requireLogin, async (req, res) => {
  try {
    const bookId = parseInt(req.body.id, 10);
    await db.query("DELETE FROM user_books WHERE book_id=$1", [bookId]); // clean user_books first
    await db.query("DELETE FROM books WHERE id=$1", [bookId]);
    

    req.flash("success", "Book deleted successfully.");
    res.redirect(req.body.redirect || "/");
  } catch (err) {
    console.error(err);
    req.flash("error", "Error deleting book.");
    res.redirect(req.body.redirect || "/");
  }
});

// -------------------- Public / Listing routes --------------------

// Home / universal page with optional search filters (query, genre, rating)
const BOOKS_PER_PAGE = 20;

app.get("/", async (req, res) => {
    try {
        let { query, genre, page, rating } = req.query;

        // --- 1. Sanitize Inputs and Pagination Setup ---
        query = query ? query.trim() : "";
        genre = genre ? genre.trim() : "";
        rating = rating ? Number(rating) : null;

        const currentPage = page ? parseInt(page) : 1;
        const offset = (currentPage - 1) * BOOKS_PER_PAGE;

        // --- 2. Build Filtering Logic ---
        let filterSql = " WHERE TRUE";
        const params = [];

        if (query) {
            params.push(`%${query}%`);
            filterSql += ` AND (title ILIKE $${params.length} OR author ILIKE $${params.length})`;
        }
        if (genre) {
            params.push(`%${genre}%`);
            filterSql += ` AND genre ILIKE $${params.length}`;
        }

        // --- 3. Run Count Query ---
        const countResult = await db.query(`SELECT COUNT(*) FROM books ${filterSql}`, params);
        const totalBooks = parseInt(countResult.rows[0].count);
        const totalPages = Math.ceil(totalBooks / BOOKS_PER_PAGE);

        // --- 4. Build Final Book Fetch Query ---
        // Select all key columns including genre & description
        let bookSql = `
            SELECT id, title, author, genre, description, cover_url
            FROM books
            ${filterSql}
            ORDER BY display_order ASC NULLS LAST
            LIMIT $${params.length + 1}
            OFFSET $${params.length + 2};
        `;

        params.push(BOOKS_PER_PAGE);
        params.push(offset);

        const result = await db.query(bookSql, params);

        res.render("home.ejs", {
            title: "Book Recommendation Platform",
            books: result.rows,
            query,
            genre,
            rating,
            currentPage,
            totalPages,
        });
    } catch (err) {
        console.error("Error in GET /:", err);
        res.status(500).send("Error fetching books");
    }
});












// Profile page (tabbed): ?tab=already|recommend|save and ?query=...
// In app.js

// This is part of your GET /profile route (or replace the old profile route)  
// app.js

// … inside your existing code …

app.get("/profile", requireLogin, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const tab = req.query.tab || "already";  // 'already', 'recommend', 'save'
    const queryTerm = req.query.query?.trim() || "";

    let searchedBook = null;  // default: no search yet or not found
    if (queryTerm) {
      const sb = await db.query(
        `SELECT * FROM books
         WHERE title ILIKE $1
           OR author ILIKE $1
         LIMIT 1`,
        [`%${queryTerm}%`]
      );
      if (sb.rows.length > 0) {
        searchedBook = sb.rows[0];
      }
    }

    // Fetch the user's books for the current tab
    let status;
    if (tab === "recommend") status = "recommend";
    else if (tab === "save") status = "save";
    else status = "already read";

    let sql = `
      SELECT b.*, ub.rating AS user_rating, ub.review AS user_review
      FROM books b
      JOIN user_books ub ON b.id = ub.book_id
      WHERE ub.user_id = $1 AND ub.status = $2
    `;
    const params = [userId, status];

    // Optional filter of user’s own books via a separate input (if you have one), e.g. `user_query`
    if (req.query.user_query && req.query.user_query.trim() !== "") {
      const uq = req.query.user_query.trim();
      params.push(`%${uq}%`);
      sql += ` AND (b.title ILIKE $${params.length} OR b.author ILIKE $${params.length})`;
    }

    sql += " ORDER BY b.rating DESC";

    const userBooksResult = await db.query(sql, params);

    // Render the view, passing searchedBook and queryTerm
    res.render("profile.ejs", {
      title: "My Profile",
      tab,
      query: queryTerm,
      searchedBook,
      books: userBooksResult.rows,
    });
  } catch (err) {
    console.error("Error in GET /profile:", err);
    res.status(500).send("Error loading profile");
  }
});



// 404 / error handling (keep last)
app.use((req, res) => res.status(404).send("Page not found"));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send("Something went wrong");
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
