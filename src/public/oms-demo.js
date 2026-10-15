// PRZ-083 — pasek demo publicznego: licznik do resetu danych, ostrzeżenie w ostatnich 2 minutach i nakładka
// „Trwa restart demo”, która czeka na nową instancję panelu i przenosi do logowania.
//
// Skąd wiadomo, że restart minął: termin resetu instancji (data-demo-reset) stoi też na ekranie logowania, a nowa
// instancja ma termin następny. Nakładka pyta /login co 2 s; inny termin = nowa baza, sesja gościa już nie istnieje.
// Spóźniony generator (deploy/demo/cykl.mjs) = nakładka po prostu czeka dłużej, zamiast odliczać od nowa.
//
// Zegar: przeglądarka gościa może się mylić o minuty — liczymy od czasu serwera z chwili wysłania strony
// (data-demo-teraz), nie od Date.now() przeglądarki.

const BLISKO_MS = 2 * 60_000;
const ODPYTUJ_CO_MS = 2_000;
const DLUGO_MS = 90_000;

/** Stan paska na `zostalo` ms przed resetem. Czysta funkcja — testowana bez przeglądarki. */
export function stanPaska(zostalo) {
  const s = Math.max(0, Math.ceil(zostalo / 1000));
  return {
    licznik: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`,
    blisko: zostalo > 0 && zostalo <= BLISKO_MS,
    restart: zostalo <= 0,
  };
}

function uruchom() {
  const pasek = document.querySelector('.pasek-demo[data-demo-reset]');
  if (!pasek) return;
  const termin = Date.parse(pasek.dataset.demoReset);
  const przesuniecie = Number(pasek.dataset.demoTeraz) - Date.now();
  const teraz = () => Date.now() + przesuniecie;
  const tekst = pasek.querySelector('.pasek-demo-tekst');
  const dopisek = pasek.querySelector('.pasek-demo-dopisek');
  const { demoLogin: login, demoHaslo: haslo } = pasek.dataset;
  let zegar = null;

  const odswiez = () => {
    const stan = stanPaska(termin - teraz());
    if (stan.restart) { clearInterval(zegar); pokazNakladke(); return; }
    pasek.classList.toggle('pasek-demo--blisko', stan.blisko);
    if (stan.blisko) {
      tekst.innerHTML = `Restart danych za <strong>${stan.licznik}</strong> — Twoje zmiany znikną.`;
      dopisek.textContent = `Po restarcie zaloguj się ponownie: ${login} / ${haslo}.`;
    } else {
      tekst.innerHTML = `Wersja DEMO — restart danych za <strong>${stan.licznik}</strong>`;
      dopisek.textContent = 'Zmiany gości znikają przy każdym restarcie.';
    }
  };

  function pokazNakladke() {
    if (document.querySelector('.nakladka-demo')) return;
    const nakladka = document.createElement('div');
    nakladka.className = 'nakladka-demo';
    nakladka.innerHTML = `<div class="nakladka-demo-okno" role="alertdialog" aria-modal="true" aria-labelledby="nakladka-demo-tytul">
      <h2 id="nakladka-demo-tytul">Trwa restart demo</h2>
      <p>Dane wracają do stanu początkowego. Za kilka sekund przeniesiemy Cię do logowania.</p>
      <p class="nakladka-demo-dlugo" hidden>Restart trwa dłużej niż zwykle. <a href="/login">Przejdź do logowania</a></p>
    </div>`;
    document.body.append(nakladka);
    const start = Date.now();
    const czekaj = async () => {
      try {
        const html = await (await fetch('/login', { cache: 'no-store', credentials: 'same-origin' })).text();
        const nowy = html.match(/data-demo-reset="([^"]+)"/)?.[1];
        if (nowy && nowy !== pasek.dataset.demoReset) { location.assign('/login'); return; }
      } catch { /* panel w trakcie podmiany — pytamy dalej */ }
      if (Date.now() - start > DLUGO_MS) nakladka.querySelector('.nakladka-demo-dlugo').hidden = false;
      setTimeout(czekaj, ODPYTUJ_CO_MS);
    };
    setTimeout(czekaj, ODPYTUJ_CO_MS);
  }

  odswiez();
  zegar = setInterval(odswiez, 1000);
  // Karta w tle: przeglądarka spowalnia setInterval — po powrocie liczymy od razu.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !document.querySelector('.nakladka-demo')) odswiez(); });
}

if (typeof document !== 'undefined') uruchom();
