-- Test database for integration tests (the main database is created by MYSQL_DATABASE).
CREATE DATABASE IF NOT EXISTS embroidery_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
GRANT ALL PRIVILEGES ON embroidery_test.* TO 'emb'@'%';
FLUSH PRIVILEGES;
