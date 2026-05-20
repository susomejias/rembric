import { defineConfig } from 'drizzle-kit';

const dataDir = process.env['REMBRIC_DATA_DIR'] ?? `${process.env['HOME'] ?? '.'}/.rembric`;

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: `file:${dataDir}/data.db`,
  },
  verbose: true,
  strict: true,
});
