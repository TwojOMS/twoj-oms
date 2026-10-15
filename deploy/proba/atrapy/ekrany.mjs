// PRZ-082 — ekrany, których demo nie pokazuje gościowi (decyzja właściciela 14.10: „Cele: usuń z demo”).
//
// Cele to plan pracy firmy, nie funkcja, którą kupujący ocenia na zmyślonych danych — generator ich nie wypełnia,
// a gość (rola Sprzedaż, deploy/demo/start.mjs) nie ma zakładki ani dostępu. Bez zmiany kodu produkcji: zabieramy
// ekran rolom bez uprawnień administratora w bazie demo, ZANIM wstanie aplikacja. Kolejność ma znaczenie —
// synchronizacja ról przy starcie (moduł ustawień) zamienia konto, którego ptaszki nie zgadzają się z rolą,
// w rolę osobistą z tymi ptaszkami; po `materializujKonta` ptaszki gościa zgadzają się z rolą, więc start nic nie
// przywraca (rozdanie nowych uprawnień przy starcie pomija `cele` — oznacza je migracja rdzenia nr 2). Administrator demo widzi Cele (pustą zakładkę) — to jego instancja.
// ⛔ Poza OMS_TRYB=proba odmawia (tryb.mjs).
import { synchronizujRole, materializujKonta, wTransakcji } from '../../../src/moduly/ustawienia/role.js';
import { wymagajTrybuProby } from './tryb.mjs';

export const EKRANY_UKRYTE_W_DEMO = Object.freeze(['cele']);

export function ukryjEkranyDemo(db, env) {
  wymagajTrybuProby(env, 'ekrany demo');
  synchronizujRole(db);
  wTransakcji(db, () => {
    const usun = db.prepare('DELETE FROM role_ekrany WHERE ekran = ? AND rola IN (SELECT klucz FROM role WHERE admin = 0)');
    for (const ekran of EKRANY_UKRYTE_W_DEMO) usun.run(ekran);
    materializujKonta(db);
  });
}
