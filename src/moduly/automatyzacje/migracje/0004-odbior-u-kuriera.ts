import type { Migracja } from '../../../core/kontrakty.ts';

// PRZ-108.09 (recenzja 09, usterka 1): obok chwili, w której OMS ZOBACZYŁ odbiór (`odebrana_at`, migracja 0003), także
// chwila odbioru U KURIERA (`odebrana_kurier_at`, ISO z `Z`; DPD bez strefy przeliczone jako czas warszawski —
// domena/dowod-odbioru.js, msCzasuKuriera). Różnica ponad 48 h = dowód spóźniony: odbiór zostaje w historii, a reguła
// „Kurier odebrał paczkę” pomija wykonanie z powodem.
//
// Osobny numer zamiast dopisania do 0003: 0003 mogła już zostać zastosowana w jakiejś bazie (pętla, piaskownica), a baza
// z zapisaną migracją 3 nie wykonałaby jej drugi raz — kolumny by nie było. Addytywna: jedna kolumna NULL, bez indeksu
// (czytana tylko przy wykonaniu, po id paczki). Odporna na ponowne uruchomienie.
export const migracjaOdbioruUKuriera: Migracja = {
  numer: 4,
  nazwa: 'chwila odbioru przesyłki u kuriera',
  wykonaj(db) {
    const jest = db.prepare('PRAGMA table_info(przesylki)').all().some((k) => (k as { name: string }).name === 'odebrana_kurier_at');
    if (!jest) db.exec('ALTER TABLE przesylki ADD COLUMN odebrana_kurier_at TEXT');
  },
};
