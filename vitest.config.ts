import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Database tests share one Postgres database and reset its schema.
    fileParallelism: false,
  },
});
