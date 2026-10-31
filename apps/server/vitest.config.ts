import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The API tests share one test database, so run files one at a time.
  test: { fileParallelism: false },
});
