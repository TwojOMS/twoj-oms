// Zapis progu niskiego stanu karty. Osobna trasa, nie formularz danych karty: pole stoi w sekcji stanu
// magazynowego, a formularz danych ma własną, wąską listę pól — tak jego zapis nie dotyka progu i odwrotnie.
// Uprawnienie „magazyn” i CSRF sprawdzają wspólne haki panelu (prefiks `/magazyn`).
import { kartaPoId, zapiszKarte } from '../../oms/db/magazyn.js';
import { parsujProg } from '../../domena/prog-stanu.js';
import { stronaOdmowy } from '../../core/web/odmowa.js';

const POLE = 'prog_niskiego_stanu';
const SEKCJA = '#stan-karty';

export function registerProgStanu(app, { db, magazyn, pomoc }) {
  app.post('/magazyn/:id/prog-stanu', async (req, reply) => {
    if (!magazyn || magazyn.gotowy?.() === false) return reply.view('pusta-strona.ejs', pomoc.BEZ_SKLEPOW);
    const karta = kartaPoId(db, req.params.id);
    if (!karta) {
      return stronaOdmowy(reply, 404, 'Nie ma takiej karty produktu.', {
        tytul: 'Nie zapisano progu niskiego stanu',
        wroc: '/magazyn',
        napisWroc: 'Wróć do magazynu',
      });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const prog = parsujProg(Object.hasOwn(body, POLE) ? body[POLE] : undefined);
    if (prog !== null && typeof prog === 'object') {
      return stronaOdmowy(reply, 400, prog.blad, {
        tytul: 'Nie zapisano progu niskiego stanu',
        wroc: `/magazyn/${karta.id}${SEKCJA}`,
        napisWroc: 'Wróć do karty',
      });
    }
    zapiszKarte(db, karta.id, { [POLE]: prog });
    return reply.code(303).redirect(`/magazyn/${karta.id}?zapisano=prog-stanu${SEKCJA}`);
  });
}
