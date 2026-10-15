// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { environment: 'node', include: ['tests/**/*.test.{js,ts}'], globalSetup: ['tests/pomoc/global-setup-temp.ts'] } });
