// PULS ZEGAROW W PAMIECI PROCESU — dla GET /health.
//
// Istnieje WYLACZNIE dla czuwacza KSeF: to jedyny zegar, ktory nie zostawia w bazie zadnego
// sladu po udanym przebiegu (poller pisze stan_pollera, koszty pisza stan_kosztow — /health
// czyta je wprost z bazy, bo przezywaja restart). Dokladanie tu pollera i kosztow byloby
// DRUGIM zrodlem prawdy obok bazy — i pierwszym miejscem, w ktorym oba klamia inaczej.
//
// ⚠️ PAMIEC PROCESU, I TO JEST WLASCIWOSC, NIE WADA: po restarcie kontenera puls startuje
// pusty, a ocena w domain/zdrowie.js daje mlodemu procesowi lagodny start (pierwszy przebieg
// czuwacza ma prawo przyjsc dopiero za godzine). Zawieszony czuwacz NIE bije pulsu wcale —
// wiek ostatniego sukcesu rosnie i to jest dokladnie ten sygnal, ktory /health ma pokazac.

export function createPuls({ teraz = () => new Date() } = {}) {
  const startAt = teraz();
  const zapisy = new Map();

  return {
    startAt,
    ok(nazwa) {
      const w = zapisy.get(nazwa) ?? {};
      w.okAt = teraz().toISOString();
      zapisy.set(nazwa, w);
    },
    blad(nazwa, tresc) {
      const w = zapisy.get(nazwa) ?? {};
      w.bladAt = teraz().toISOString();
      w.blad = String(tresc?.message ?? tresc ?? '').trim() || 'bez treści';
      zapisy.set(nazwa, w);
    },
    // Kopia, nie referencja — czytelnik /health nie ma prawa mimochodem dopisac niczego
    // do stanu, ktory potem ktos wezmie za zapis zegara.
    stan() {
      return Object.fromEntries([...zapisy].map(([k, w]) => [k, { ...w }]));
    },
  };
}
