--This table stores all the books in the system (one place for all books).
CREATE TABLE books (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    author VARCHAR(255),
    genre VARCHAR(255),
    rating NUMERIC(2,1) CHECK (rating >= 1 AND rating <= 5)
);

--This table stores all users in the system (one place for all users).
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL, -- We'll store a hashed password later
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);



--acts like a link between users and books, so we know:
---1. Which user read which book
---2. Which user recommended which book
---3. Ratings & reviews for each user-book pair
CREATE TABLE user_books (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,  --means If a user is deleted, all their book records will also be deleted
    book_id INT REFERENCES books(id) ON DELETE CASCADE,
    status VARCHAR(20), -- e.g., 'already read' or 'recommended'
    rating NUMERIC(2,1), -- rating given by the user (optional)
    review TEXT          -- user's review/comment (optional)
);



-- creating two more columns - cover_url and description
ALTER TABLE books
  ADD COLUMN IF NOT EXISTS cover_url TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT;


-- Add simple uniqueness to prevent duplicate title+author rows
-- cover_url lets you display book thumbnails on the home page.
ALTER TABLE books
ADD CONSTRAINT books_title_author_unique
UNIQUE (title, author);
