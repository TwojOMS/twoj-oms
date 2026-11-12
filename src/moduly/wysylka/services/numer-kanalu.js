import { numerZwrotnyZamowienia } from '../../../integracje/kanal-modul.ts';
import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';
import { pobierzPrzesylke, zapiszBladSync } from '../db/przesylki.js';
import { czyTylkoOdczyt } from '../../../domena/woo-uprawnienia.js';
import { bladOperatora } from '../../../domena/bledy.js';

// Ślad przyjęcia powiązany z konkretną paczką. Oryginalna odpowiedź kuriera (także XML) zostaje bez zmian.
function ostatniZapis(db, p) {
  const wiersze = db.prepare("SELECT wynik FROM log WHERE zamowienie_id=? AND akcja='sync-numer.przyjeto' ORDER BY id DESC").all(p.zamowienie_id);
  for (const w of wiersze) {
    try { const dane = JSON.parse(w.wynik); if (dane.przesylkaId === p.id) return dane; } catch { /* starszy log */ }
  }
  return null;
}
function usuniety(db, p) {
  return db.prepare("SELECT 1 FROM log WHERE zamowienie_id=? AND akcja='sync-numer.usunieto' AND wynik=?").get(p.zamowienie_id, String(p.id));
}

/** null oznacza kanał korzystający z dotychczasowej notatki Woo/Allegro. */
export async function przekazNumerKanalu({ db, klienci, klienciKanalow = {} }, przesylkaId, usun = false) {
  const p = pobierzPrzesylke(db, przesylkaId);
  if (!p) throw bladOperatora('Nie ma takiej przesyłki.');
  const z = pobierzZamowienie(db, p.zamowienie_id);
  if (!z) throw bladOperatora('Nie ma takiego zamówienia.');
  const klient = klienciKanalow?.[z.sklep] ?? klienci[z.sklep];
  const zapis = numerZwrotnyZamowienia(z, klient);
  if (!zapis) return null;
  if (czyTylkoOdczyt(klient)) { zapiszBladSync(db, p.id, null); return { pominiety: true }; }
  const przyjeto = ostatniZapis(db, p);
  if ((usun && !przyjeto) || usuniety(db, p) || (!usun && przyjeto)) {
    zapiszBladSync(db, p.id, null); return { pominiety: true };
  }
  try {
    if (!klient) throw new Error('Brak połączenia z kanałem zamówienia.');
    if (usun) {
      await zapis.usunNumer(przyjeto.id);
      dopiszLog(db, z.id, { akcja: 'sync-numer.usunieto', wynik: String(p.id) });
    } else {
      const wynik = await zapis.przekazNumer(z, p);
      if (wynik.id) dopiszLog(db, z.id, { akcja: 'sync-numer.przyjeto', wynik: JSON.stringify({ przesylkaId: p.id, id: wynik.id }) });
    }
    zapiszBladSync(db, p.id, null);
    return { ok: true };
  } catch {
    // Bez treści wyjątku transportu: nie może trafić tu klucz ani treść odpowiedzi.
    const blad = usun ? 'numer kanału: usuwanie' : 'numer kanału: wysyłanie';
    zapiszBladSync(db, p.id, `notatka: ${blad}`);
    dopiszLog(db, z.id, { akcja: 'sync-numer.blad', wynik: blad });
    return { blad };
  }
}
