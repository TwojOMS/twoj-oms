// PRZ-101.01: strony „wkrótce” w Ustawieniach — jedna trasa GET na pozycję, treść z domena/ustawienia-wkrotce.js.
// Uprawnienie „ustawienia” sprawdza strażnik po prefiksie `/ustawienia`, jak przy reszcie ekranów.
import { STRONY_WKROTCE } from '../../../domena/ustawienia-wkrotce.js';
import { nawigacjaUstawien } from '../nawigacja.js';

/** @param {any} app @param {{ kopie?: (() => any) | null, drukFaktur?: (() => any) | null }} [opcje] */
export function registerUstawieniaWkrotceRoutes(app, { kopie = null, drukFaktur = null } = {}) {
  for (const strona of STRONY_WKROTCE) {
    if (strona.klucz === 'kopie') continue; // PRZ-127: rzeczywisty odczyt w trasy/kopie.js.
    app.get(strona.href, async (req, reply) => {
      let stan = null;
      let stanDruku = null;
      if (strona.klucz === 'druk') {
        try { stanDruku = drukFaktur?.() ?? null; } catch { /* usługa może nie być dostępna */ }
      }
      if (strona.klucz === 'kopie') {
        try {
          const k = kopie?.();
          if (k?.brakNadzoru) stan = 'ten OMS nie widzi katalogu kopii (instalacja bez oms-kopia).';
          else if (k && !k.katalogDostepny) stan = 'OMS nie widzi katalogu kopii.';
          else if (k) {
            const opis = { ok: 'ustawiona', nieustawiona: 'nieustawiona', 'brak-nosnika': 'ustawiona, ale nośnik niepodłączony', 'ten-sam-dysk': 'ustawiona, ale nośnik niezamontowany', 'stara-na-nosniku': 'ustawiona, ale na nośniku brak świeżej kopii' };
            stan = `${k.ostatnia ? `ostatnia kopia ${k.ostatnia.plik}, ${k.ostatnia.wiekH} h temu` : 'brak kopii bazy'}; kopia poza dyskiem: ${opis[k.zewnetrznaStan] ?? (k.zewnetrzna ? 'ustawiona' : 'nieustawiona')}.`;
          }
        } catch { /* usługa może nie być dostępna */ }
      }
      return reply.view('ustawienia-wkrotce.ejs', {
        nawigacja: nawigacjaUstawien(req, reply), title: strona.tytul, strona: { ...strona, stan, stanDruku },
      });
    });
  }
}
