import { opisDoSekcji, poprawneSekcje } from '../../domena/opis-sekcje.js';
import { kartaPoId, zapiszKarte } from '../../oms/db/magazyn.js';

export function odczytajOpis(body) {
  if (typeof body?.opis_sekcje_json === 'string') return JSON.parse(body.opis_sekcje_json);
  const liczba = Number(body?.opis_liczba);
  if (!Number.isSafeInteger(liczba) || liczba < 0 || liczba > 200) throw new Error('sekcje');
  return {
    sekcje: Array.from({ length: liczba }, (_, i) => {
      const ile = Number(body[`s${i}_liczba`]);
      if (!Number.isSafeInteger(ile) || ile < 0 || ile > 200) throw new Error('elementy');
      return {
        elementy: Array.from({ length: ile }, (_, j) =>
          body[`t${i}_${j}`] === 'zdjecie'
            ? { typ: 'zdjecie', adres: body[`a${i}_${j}`] }
            : { typ: body[`t${i}_${j}`], html: body[`h${i}_${j}`] },
        ),
      };
    }),
  };
}

// Zostawiamy strukturę do walidacji (także trzeci element). HTML nie może
// przemycić obrazka — zdjęcia wybiera się wyłącznie z galerii karty.
function oczyscOpis(opis) {
  // Tekst nie będący napisem (tablica z powtórzonego pola, obiekt z JSON) staje się pusty — nigdy surowym wejściem.
  return {
    sekcje: opis?.sekcje?.map((s) => ({
      elementy: s?.elementy?.map((e) =>
        e?.typ === 'tekst'
          ? {
              typ: 'tekst',
              html:
                typeof e.html === 'string'
                  ? opisDoSekcji(e.html)
                      .sekcje.flatMap((s) => s.elementy)
                      .filter((e) => e.typ === 'tekst')
                      .map((e) => e.html)
                      .join('')
                  : '',
            }
          : e,
      ),
    })),
  };
}

export function daneOpisu(db, kartaId, formularz = null) {
  const zdjecia =
    kartaId === null
      ? []
      : db
          .prepare('SELECT * FROM zdjecia_kart WHERE karta_id=? ORDER BY kolejnosc, id')
          .all(kartaId)
          .map((z) => ({
            adres: z.adres_zrodlowy || `/magazyn/zdjecia/${z.plik}`,
            podglad: z.plik ? `/magazyn/zdjecia/${z.plik}` : z.adres_zrodlowy,
          }));
  let opis;
  try {
    opis = JSON.parse((kartaId === null ? null : kartaPoId(db, kartaId)?.opis_sekcje_json) || '{"sekcje":[]}');
  } catch {
    opis = { sekcje: [] };
  }
  const wpisany = formularz?.opis ?? opis;
  const sekcje = Array.isArray(wpisany?.sekcje) ? wpisany.sekcje : [];
  const bezpieczny = oczyscOpis({ sekcje: sekcje.filter((s) => Array.isArray(s?.elementy)) });
  const doPodgladu = bezpieczny.sekcje.map((s) => ({
    elementy: s.elementy.filter(
      (e) =>
        (e?.typ === 'tekst' && typeof e.html === 'string') ||
        (e?.typ === 'zdjecie' && zdjecia.some((z) => z.adres === e.adres)),
    ),
  }));
  return {
    sekcje: sekcje.map((s) => ({
      elementy: Array.isArray(s?.elementy)
        ? s.elementy.map((e) => ({
            typ: e?.typ ?? '',
            html: typeof e?.html === 'string' ? e.html : '',
            adres: typeof e?.adres === 'string' ? e.adres : '',
          }))
        : [],
    })),
    zdjecia,
    podglad: doPodgladu,
    blad: formularz?.blad ?? null,
  };
}

export function zmienSekcje(opis, akcja) {
  if (akcja === 'dodaj') {
    opis.sekcje.push({ elementy: [{ typ: 'tekst', html: '' }] });
    return true;
  }
  const [operacja, numer] = akcja.split(':');
  const i = Number(numer);
  if (!Number.isSafeInteger(i) || i < 0 || i >= opis.sekcje.length) return false;
  const elementy = opis.sekcje[i].elementy;
  if (operacja === 'usun') opis.sekcje.splice(i, 1);
  else if (operacja === 'gora' && i > 0) [opis.sekcje[i - 1], opis.sekcje[i]] = [opis.sekcje[i], opis.sekcje[i - 1]];
  else if (operacja === 'dol' && i + 1 < opis.sekcje.length)
    [opis.sekcje[i + 1], opis.sekcje[i]] = [opis.sekcje[i], opis.sekcje[i + 1]];
  else if (operacja === 'dodaj-element' && elementy.length === 1) elementy.push({ typ: 'tekst', html: '' });
  else if (operacja === 'usun-element' && elementy.length === 2) elementy.pop();
  else return false;
  return true;
}

export function walidujOpis(opis, zdjecia) {
  let czysty;
  try {
    czysty = oczyscOpis(opis);
  } catch {
    return { blad: 'Nieprawidłowy opis. Sprawdź listę sekcji i elementów.' };
  }
  const walidacja = poprawneSekcje(czysty);
  if (!walidacja.ok) return { blad: walidacja.bledy.join(' ') };
  if (
    czysty.sekcje.some((s) => s.elementy.some((e) => e.typ === 'zdjecie' && !zdjecia.some((z) => z.adres === e.adres)))
  )
    return { blad: 'Zdjęcie nie należy do tej karty. Wybierz zdjęcie z listy.' };
  return { czysty };
}

export function opisDoZapisu(czysty) {
  // Dopiero zapis usuwa puste pola; podgląd i operacje edytora zachowują strukturę formularza.
  return {
    sekcje: czysty.sekcje
      .map((s) => ({ elementy: s.elementy.filter((e) => e.typ !== 'tekst' || e.html.trim() !== '') }))
      .filter((s) => s.elementy.length > 0),
  };
}

export function registerOpisMagazynu(app, { db, karta, magazyn }) {
  app.post('/magazyn/:id/opis', async (req, reply) => {
    if (magazyn?.gotowy?.() === false) return reply.code(302).redirect('/magazyn');
    const rekord = kartaPoId(db, req.params.id);
    if (!rekord) return karta.brakKarty(reply, req.params.id);
    let opis = { sekcje: [] };
    const ekran = (kod, blad = null) => {
      req.opisFormularz = { opis, blad };
      return karta.ekranKarty(req, reply, { karta: rekord, kod });
    };
    try {
      opis = odczytajOpis(req.body);
    } catch {
      return ekran(400, 'Nieprawidłowy opis. Sprawdź listę sekcji i elementów.');
    }
    const { czysty, blad } = walidujOpis(opis, daneOpisu(db, rekord.id).zdjecia);
    if (blad) return ekran(400, blad);
    const akcja = req.body?.akcja ?? 'zapisz';
    if (akcja === 'podglad') return ekran(200);
    if (typeof akcja === 'string' && zmienSekcje(opis, akcja)) return ekran(200);
    if (akcja !== 'zapisz') return ekran(400, 'Nieznana operacja edytora opisu.');
    zapiszKarte(db, rekord.id, { opis_sekcje_json: JSON.stringify(opisDoZapisu(czysty)) });
    return reply.code(303).redirect(`/magazyn/${rekord.id}#opis-karty`);
  });
}
