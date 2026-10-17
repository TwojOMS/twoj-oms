// vitest.config.ts
import { defineConfig } from 'vitest/config';

// PRZ-089 (vitest 2 → 5): od nowszych wersji limit czasu przerywa też testy SYNCHRONICZNE (spawnSync, execFileSync
// — aktualizator, przejście na pracę, tsc), których vitest 2 nie przerywał; z domyślnymi 5 s padało ich ~80.
// 120 s to zapas na pełną suitę pod obciążeniem; cena: zawieszony test asynchroniczny zgłosi się po 2 min, nie po 5 s.
export default defineConfig({ test: { environment: 'node', include: ['tests/**/*.test.{js,ts}'], globalSetup: ['tests/pomoc/global-setup-temp.ts'],
  testTimeout: 120_000, hookTimeout: 120_000 } });
