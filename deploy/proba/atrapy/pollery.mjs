// PRZ-082 — puls pollerów zamówień w piaskownicy i demo.
//
// Pollery w trybie próby nie wstają (moduł kanałów buduje je z pustej konfiguracji, index.mjs), więc `stan_pollera`
// zostaje pusty, a zdrowie (domena/zdrowie.js) po 15 min życia procesu krzyczy na stronie głównej „Poller polcien
// stoi — ostatni przebieg nieznany” — przy każdym kanale, u każdego gościa demo (zgłoszenie właściciela 14.10, zrzut).
// Atrapa robi to, co poller po przebiegu bez nowych zamówień: odnotowuje udany przebieg, kursor bez zmian.
// Nic nie pobiera i nic nie zapisuje w zamówieniach. ⛔ Poza OMS_TRYB=proba odmawia (tryb.mjs).
import { wymagajTrybuProby } from './tryb.mjs';

/** Co ile atrapa odnotowuje przebieg — dużo poniżej progu zdrowia (PROG_POLLERA_S, 15 min). */
export const CO_ILE_MS_PULSU_POLLEROW = 60_000;

export function uruchomPulsPollerow({ db, env, zrodla, teraz = () => new Date() }) {
  wymagajTrybuProby(env, 'puls pollerów');
  const zapisz = db.prepare(`INSERT INTO stan_pollera (sklep, zsynchronizowane_do, ostatni_przebieg_at, ostatni_blad,
      ostatni_blad_od_at, ostatni_blad_rodzaj, ostatni_blad_prob) VALUES (?, NULL, ?, NULL, NULL, NULL, NULL)
    ON CONFLICT(sklep) DO UPDATE SET ostatni_przebieg_at = excluded.ostatni_przebieg_at, ostatni_blad = NULL,
      ostatni_blad_od_at = NULL, ostatni_blad_rodzaj = NULL, ostatni_blad_prob = NULL`);
  const puls = () => {
    const at = teraz().toISOString();
    for (const z of zrodla) zapisz.run(z, at);
  };
  puls();
  const zegar = setInterval(() => { try { puls(); } catch { /* baza zamknięta przy wyłączaniu */ } }, CO_ILE_MS_PULSU_POLLEROW);
  zegar.unref?.();
  return () => clearInterval(zegar);
}
