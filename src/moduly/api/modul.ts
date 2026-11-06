import type { ModulOms } from '../../core/kontrakty.ts';
import { pluginApiV1 } from './plugin.js';
import { wyczyscDziennikApi } from '../../core/bezpieczenstwo/klucze-api.js';
import { wyczyscIdempotencje } from './idempotencja.js';
import { kanalIndywidualnyWlaczony } from '../kanaly/klasyfikacja.ts';

const DOBA_MS = 86_400_000;
const GODZINA_MS = 3_600_000;
/** PRZ-153.E1.3: dziennik wywołań API trzymamy 90 dni. */
export const DNI_DZIENNIKA_API = 90;
/** PRZ-153.E5.1: wynik zapisu z `Idempotency-Key` trzymamy 7 dni. */
export const DNI_IDEMPOTENCJI = 7;

/** Publiczne API v1; trasy i obsługa błędów zamknięte we własnym pluginie. */
export const modulApi: ModulOms<{ kanalIndywidualny: boolean }> = {
  nazwa: 'api', wersja: '1.0.0', wymaga: ['rdzen', 'web', 'kanaly', 'faktury', 'zamowienia'],
  konfiguracja: env => ({ kanalIndywidualny: kanalIndywidualnyWlaczony(env) }),
  migracje: [], uprawnienia: [], menu: [],
  zbuduj: ctx => ({
    trasy: app => { app.register(pluginApiV1, { prefix: '/api/v1', ctx: {
      ...ctx,
      config: ctx.usluga<any>('kanaly', 'config'),
      proforma: ctx.usluga<any>('faktury', 'proforma'),
      syncSklep: ctx.usluga<any>('zamowienia', 'syncSklep'),
      opcjeZw: ctx.usluga<any>('zamowienia', 'opcjeZw'),
      kanalIndywidualny: ctx.konfiguracja.kanalIndywidualny,
    } }); },
    // Raz na dobę; wyjątek ląduje w logu i nie wywraca procesu.
    zegary: [{ nazwa: 'api-dziennik', odstepMs: GODZINA_MS, przebieg: async () => {
      try {
        const starszeNiz = new Date(ctx.teraz().getTime() - DNI_DZIENNIKA_API * DOBA_MS).toISOString();
        wyczyscDziennikApi(ctx.db, { starszeNiz });
      } catch (e) { ctx.log(`api: sprzątanie dziennika — ${e instanceof Error ? e.message : String(e)}`); }
    } }, { nazwa: 'api-idempotencja', odstepMs: GODZINA_MS, przebieg: async () => {
      try {
        const starszeNiz = new Date(ctx.teraz().getTime() - DNI_IDEMPOTENCJI * DOBA_MS).toISOString();
        wyczyscIdempotencje(ctx.db, { starszeNiz });
      } catch (e) { ctx.log(`api: sprzątanie idempotencji — ${e instanceof Error ? e.message : String(e)}`); }
    } }],
  }),
};
