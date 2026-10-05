---
{
  "schema": "subactor.knowledge-markdown/v1",
  "id": "architecture.digital-twin.public-site-service-map",
  "version": 10,
  "status": "active",
  "visibility": "internal",
  "language": "pl",
  "owners": ["bot:architecture-bot", "authority:domain-owner"],
  "tags": ["architecture", "digital-twin", "doql", "strategy-dsl", "intent-contract", "plesk", "cloudflaredns", "public-site", "controller", "ticket-lifecycle", "connector-rules", "publication-validation"],
  "provenance": [
    {"id": "founder-binding-intent", "kind": "internal-decision", "observed_at": "2026-07-24T16:31:00.000Z", "locator": "repo://platform/config/intent-contracts/founder-public-site-binding.v1.json", "note": "Intent INT-FOUNDER-PUBLIC-SITE-001: tunnel_mode=none, public_ingress_mode=plesk_public_origin."},
    {"id": "doql-service-map-v10", "kind": "internal-decision", "observed_at": "2026-07-25T08:34:00.000Z", "locator": "repo://platform/config/digital-twin/public-site-service-map.doql.json", "note": "DOQL public-site.service-map: reguła usuwania domyślnych plików index.html Pleska oraz detekcja przesłaniania index.php."},
    {"id": "connector-plesk-purge-rule", "kind": "internal-decision", "observed_at": "2026-07-25T08:34:00.000Z", "locator": "repo://platform/scripts/deploy-public-pages.mjs", "note": "Weryfikacja strict HTTPS odrzuca serwowane pliki domyślne Plesk (Domain Default page / plesk_default_page_shadowing)."}
  ],
  "validity": {"valid_from": "2026-07-25T08:34:00.000Z", "review_after": "2026-08-25T00:00:00.000Z"},
  "relations": [
    {"type": "updates", "target": "knowledge://subactor/architecture.digital-twin.public-site-service-map/v8"},
    {"type": "depends-on", "target": "knowledge://subactor/architecture.doql-digital-twin-situation/v2"},
    {"type": "depends-on", "target": "knowledge://subactor/ops.plesk.cloudflare-dns-management/v2"}
  ],
  "research": {"gaps": []},
  "llm": {
    "keywords": ["service map", "connector rules", "digital twin", "index.html shadowing", "plesk_default_page_shadowing", "index.php verification"],
    "use_when": "Gdy trzeba opisać zasady konektora Plesk oraz reguły weryfikacji publikacji Digital Twin zapobiegające przesłanianiu index.php przez domyślny index.html Pleska.",
    "do_not_infer": [
      "Obecność pliku index.html w katalogu produkcyjnym Plesk nie oznacza sukcesu wdrożenia aplikacji PHP."
    ]
  }
}
---

# Digital Twin: Mapa Usług Publicznych, Reguły Konektora i Walidacja Publikacji (v10)

> Ten wpis wiedzy określa zasady działania konektora Plesk i reguły walidacji Digital Twin chroniące przed przesłanianiem plików index.php przez domyślne szablony Pleska.

## Kontekst
Przy tworzeniu subdomen na serwerze Plesk, panel automatycznie generuje domyślny plik statyczny `index.html` (*Plesk Default Page*). Jeśli aplikacja PHP posiada punkt wejściowy `index.php`, serwer Nginx/Apache domyślnie serwuje `index.html` zamiast `index.php`, co powoduje, że użytkownik wchodzący na adres główny widzi stronę domyślną Pleska zamiast interfejsu aplikacji.

## Decyzje i Reguły Konektora
1. **Plesk Sync Clean Placeholders (`plesk_sync_clean_default_placeholders`)**:
   - Podczas wykonywania synchronizacji plików (`plesk://host/site/command/sync`) dla aplikacji PHP lub dedykowanej witryny, konektor automatycznie czyści domyślne pliki szablonowe Pleska (`index.html`, `default.html`, `default.htm`).
   - Pozwala to na bezpośrednie wykonywanie kodu aplikacji `index.php` pod głównym adresem `/`.

## Procedura Walidacji Publikacji
1. **Detekcja `plesk_default_page_shadowing`**:
   - Skany weryfikacyjne w `deploy-public-pages` oraz kontrolerze projektu odpytują ścieżkę korzenia `/` oraz nagłówki/treść HTML.
   - Wyrycie znaczników Pleska (`Domain Default page`, `default-website-index.js`) klasyfikuje wdrożenie jako **`unhealthy`** z powodem **`plesk_default_page_shadowing`**.
2. **Warunek Przejścia (DoD Evidence)**:
   - Wdrożenie uznaje się za zbieżne (*converged* / *healthy*) wyłącznie wtedy, gdy wywołanie korzenia `/` nie zwraca szablonu Pleska i serwuje właściwy nagłówek/aplikację PHP.
