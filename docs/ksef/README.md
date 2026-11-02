# Publiczne schematy KSeF

Schematy Ministerstwa Finansów służą testom zgodności XML. Panel nie pobiera ich w czasie działania.
Pliki pozostają bajt w bajt zgodne ze źródłem. Walidator w testach podstawia lokalne pliki zamiast pobierać importy z sieci.

| plik | źródło | SHA-256 |
|---|---|---|
| `fa3/schemat_FA3_v1-0E.xsd` | http://crd.gov.pl/wzor/2025/06/25/13775/schemat.xsd | `b646b6b525f51adf1bb2545f111fc8ca6e7aa6dd2f98948f1667d3695c06d958` |
| `fa3/bazowe/StrukturyDanych_v10-0E.xsd` | http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/01/05/eD/DefinicjeTypy/StrukturyDanych_v10-0E.xsd | `1137ce6e3c11c2b9ef3f05e4e72d6dcd6b4fa94908ea558f2ba15de0259bb2aa` |
| `fa3/bazowe/ElementarneTypyDanych_v10-0E.xsd` | http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/01/05/eD/DefinicjeTypy/ElementarneTypyDanych_v10-0E.xsd | `8a531cb181d3e298d11b28766655ae91fee2d7851440095932ffc82137ed2be1` |
| `fa3/bazowe/KodyKrajow_v10-0E.xsd` | http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/01/05/eD/DefinicjeTypy/KodyKrajow_v10-0E.xsd | `1d41a1b3184188f2d20a51d3afde26204dda182ec5dacf018204dcc9870dc644` |
| `upo/upo-v4-3.xsd` | https://github.com/CIRFMF/ksef-api/tree/main/faktury/upo/schemy | `1e5ff386a29324021a9e0126319680aec0b1e0d4f4a18add30b2f5d12ce6fa86` |

Plik LICENSE-MF.txt zawiera licencję MIT repozytorium Ministerstwa Finansów.
