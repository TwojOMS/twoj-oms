// Scalanie zamówień — trasy (PRZ-101.04). Reguły: domena/scalanie.js, zapis: oms/db/scalenia.js.
//
// Ten sam wzorzec, co nadanie hurtem: zaznaczenie na liście → POST podgląd (nic nie zapisuje) →
// POST wykonanie → przekierowanie na kartę głównego (PRG). Adresy leżą pod /zamowienia, więc
// uprawnienie jest to samo, co przy edycji zamówienia (domena/ekrany.js), a gość demo dostaje
// odmowę każdego POST-a z haka podglądu.
import { pobierzZamowienie, dopiszLog } from '../../oms/db/zamowienia.js';
import { scalZamowienia, rozdzielZamowienia, zalogujScalenie, dolaczoneZamowienia, odlaczAnulowane } from '../../oms/db/scalenia.js';
import {
  powodyOdmowyScalenia, ostrzezeniaScalenia, roznicaKupujacego, domyslneGlowne, wysylkaGrupyGrosze, kwotaGrupyGrosze,
  WYSYLKA_Z_GLOWNEGO, WYSYLKA_SUMA, opisWysylekGrupy,
} from '../../domena/scalanie.js';
import { zl, kwotaOczekiwanaGrosze, wysylkaBruttoGrosze } from '../../domena/suma-pozycji.js';
import { adresKanalu } from '../../domena/kanaly.js';
import { komunikatDlaOperatora } from '../../domena/bledy.js';
import { ktoKlikal } from './wspolne.js';

// Rzadka funkcja na „nietypowe sytuacje” (właściciel) — sufit chroni ekran przed przypadkowym
// „zaznacz wszystkie” na 200 zamówieniach.
const SUFIT_SCALENIA = 10;

const bezpieczneGr = (f) => { try { return f(); } catch { return null; } };

export function registerScalanieRoutes(app, kontekst) {
  const { db, config, renderujKarte } = kontekst;
  const definicje = config.definicje ?? [];

  function wczytaj(body) {
    const ids = [...new Set([].concat(body?.id ?? []).map(Number).filter(Number.isInteger))].slice(0, SUFIT_SCALENIA + 1);
    return ids.map((id) => pobierzZamowienie(db, id)).filter(Boolean);
  }

  function proformyZamowien(ids) {
    if (!ids.length) return new Set();
    return new Set(db.prepare(`SELECT DISTINCT zamowienie_id FROM proformy WHERE zamowienie_id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids).map((w) => w.zamowienie_id));
  }

  function ocena(zamowienia, glowneId) {
    const powody = zamowienia.length > SUFIT_SCALENIA
      ? [`Scalić można najwyżej ${SUFIT_SCALENIA} zamówień naraz.`]
      : powodyOdmowyScalenia(zamowienia, { glowneId });
    const ostrzezenia = ostrzezeniaScalenia(zamowienia, { glowneId, proformy: proformyZamowien(zamowienia.map((z) => z.id)) });
    return { powody, ostrzezenia };
  }

  function ekran(reply, zamowienia, { glowneId, wysylka = WYSYLKA_Z_GLOWNEGO, blad = null, powrot = '/' }, kod = 200) {
    const { powody, ostrzezenia } = ocena(zamowienia, glowneId);
    const glowne = zamowienia.find((z) => z.id === glowneId);
    const dolaczone = zamowienia.filter((z) => z.id !== glowneId);
    const kwota = (decyzja) => (glowne ? bezpieczneGr(() => zl(kwotaGrupyGrosze(glowne, dolaczone, decyzja))) : null);
    return reply.code(kod).view('scalanie.ejs', {
      title: 'Scalanie zamówień',
      powrot,
      blad,
      glowneId,
      wysylka,
      powody,
      ostrzezenia,
      roznice: roznicaKupujacego(zamowienia),
      wiersze: zamowienia.map((z) => ({
        id: z.id,
        numer: z.numer,
        kanal: adresKanalu(z.sklep, definicje),
        data: String(z.utworzone_at ?? '').slice(0, 10),
        pozycji: z.pozycje.length,
        kwota: bezpieczneGr(() => zl(kwotaOczekiwanaGrosze(z))),
        wysylka: bezpieczneGr(() => zl(wysylkaBruttoGrosze(z))),
      })),
      wysylkaGlowne: glowne ? bezpieczneGr(() => zl(wysylkaGrupyGrosze(glowne, dolaczone, WYSYLKA_Z_GLOWNEGO))) : null,
      wysylkaSuma: glowne ? bezpieczneGr(() => zl(wysylkaGrupyGrosze(glowne, dolaczone, WYSYLKA_SUMA))) : null,
      razemGlowne: kwota(WYSYLKA_Z_GLOWNEGO),
      razemSuma: kwota(WYSYLKA_SUMA),
      // PRZ-101.11: jedno zdanie pod każdą opcją — co pojedzie na fakturę, z kwotami.
      opisGlowne: glowne ? bezpieczneGr(() => opisWysylekGrupy(glowne, dolaczone, WYSYLKA_Z_GLOWNEGO)) : null,
      opisSuma: glowne ? bezpieczneGr(() => opisWysylekGrupy(glowne, dolaczone, WYSYLKA_SUMA)) : null,
    });
  }

  const powrotZ = (body) => (typeof body?.powrot === 'string' && body.powrot.startsWith('/') && !body.powrot.startsWith('//') ? body.powrot : '/');

  app.post('/zamowienia/masowe/scal-podglad', async (req, reply) => {
    const zamowienia = wczytaj(req.body);
    const wybrane = Number(req.body?.glowne);
    const glowneId = zamowienia.some((z) => z.id === wybrane) ? wybrane : domyslneGlowne(zamowienia);
    const wysylka = req.body?.wysylka === WYSYLKA_SUMA ? WYSYLKA_SUMA : WYSYLKA_Z_GLOWNEGO;
    return ekran(reply, zamowienia, { glowneId, wysylka, powrot: powrotZ(req.body) });
  });

  app.post('/zamowienia/scal', async (req, reply) => {
    const zamowienia = wczytaj(req.body);
    const glowneId = Number(req.body?.glowne);
    const wysylka = String(req.body?.wysylka ?? '');
    const powrot = powrotZ(req.body);
    // Odmowy liczone OD NOWA na świeżym odczycie — ekran podglądu mógł stać otwarty, a wybór
    // innego głównego zmienia odmowy (pobranie i faktura liczą się tylko w dołączanych).
    const { powody, ostrzezenia } = ocena(zamowienia, glowneId);
    if (powody.length) return ekran(reply, zamowienia, { glowneId, wysylka, powrot, blad: 'Scalenie odrzucone — powody poniżej.' }, 400);
    if (![WYSYLKA_Z_GLOWNEGO, WYSYLKA_SUMA].includes(wysylka)) {
      return ekran(reply, zamowienia, { glowneId, powrot, blad: 'Wybierz koszt wysyłki.' }, 400);
    }
    if (ostrzezenia.length && req.body?.rozumiem !== '1') {
      return ekran(reply, zamowienia, { glowneId, wysylka, powrot, blad: 'Zaznacz „Rozumiem” przy ostrzeżeniach.' }, 400);
    }
    const glowne = zamowienia.find((z) => z.id === glowneId);
    const dolaczone = zamowienia.filter((z) => z.id !== glowneId);
    try {
      scalZamowienia(db, { glowneId, dolaczoneIds: dolaczone.map((z) => z.id), wysylka, kto: ktoKlikal(req) });
    } catch (e) {
      return ekran(reply, zamowienia, { glowneId, wysylka, powrot, blad: komunikatDlaOperatora(e) }, 409);
    }
    zalogujScalenie(db, glowne, dolaczone, `Ręcznie (${ktoKlikal(req)}): scalono zamówienia ${[glowne, ...dolaczone].map((z) => z.numer).join(' + ')}, `
      + `wysyłka: ${wysylka === WYSYLKA_SUMA ? 'suma wysyłek' : 'z zamówienia głównego'}`
      + `${ostrzezenia.length ? `; potwierdzone ostrzeżenia: ${ostrzezenia.join(' | ')}` : ''}.`);
    return reply.redirect(`/zamowienia/${glowneId}#scalenie`);
  });

  // N1 (ponowna recenzja): „Odłącz anulowane”. Bez wystawionej faktury grupy — PRG na kartę. Z fakturą
  // NIE przekierowujemy: karta od razu mówi o korekcie (ten sam napis, co w logu), tak jak ekran wyniku
  // po wystawieniu faktury. Odświeżenie powtórzy POST i dostanie odmowę „nie ma czego odłączać”.
  app.post('/zamowienia/:id/odlacz-anulowane', async (req, reply) => {
    const id = Number(req.params.id);
    if (!pobierzZamowienie(db, id)) return reply.code(404).send('Nie ma takiego zamówienia');
    let wynik;
    try {
      wynik = odlaczAnulowane(db, id);
    } catch (e) {
      return reply.code(400).send(`Nie udało się odłączyć: ${komunikatDlaOperatora(e)}`);
    }
    const { glowne, odlaczone, fakturaGrupy } = wynik;
    const numery = odlaczone.map((d) => d.numer).join(', ');
    const korekta = fakturaGrupy
      ? `faktura grupy obejmuje pozycje anulowanego zamówienia ${numery} — wystaw korektę`
        + `${fakturaGrupy.numer ? ` (faktura ${fakturaGrupy.numer})` : ''}`
      : null;
    dopiszLog(db, id, {
      akcja: 'scalenie',
      wynik: `Ręcznie (${ktoKlikal(req)}): odłączono od scalenia anulowane ${odlaczone.length > 1 ? 'zamówienia' : 'zamówienie'} ${numery}, `
        + `${odlaczone.length > 1 ? 'znów osobne' : 'znów osobno'}.${korekta ? ` Uwaga: ${korekta}.` : ''}`,
    });
    for (const d of odlaczone) {
      dopiszLog(db, d.id, { akcja: 'scalenie', wynik: `Ręcznie (${ktoKlikal(req)}): odłączone od ${glowne.numer} jako anulowane.` });
    }
    if (!korekta) return reply.redirect(`/zamowienia/${id}`);
    return renderujKarte(req, reply, pobierzZamowienie(db, id), { komunikatScalenia: `Odłączono ${numery}. Uwaga: ${korekta}.` });
  });

  app.post('/zamowienia/:id/rozdziel', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return reply.code(404).send('Nie ma takiego zamówienia');
    const dolaczone = dolaczoneZamowienia(db, z);
    try {
      rozdzielZamowienia(db, id);
    } catch (e) {
      return reply.code(400).send(`Nie udało się rozdzielić: ${komunikatDlaOperatora(e)}`);
    }
    const numery = dolaczone.map((d) => d.numer).join(', ');
    zalogujScalenie(db, z, dolaczone, `Ręcznie (${ktoKlikal(req)}): rozdzielono scalenie, `
      + `${dolaczone.length > 1 ? `zamówienia ${numery} znów osobne` : `zamówienie ${numery} znów osobno`}.`);
    return reply.redirect(`/zamowienia/${id}`);
  });
}
