# twin-plesk — Digital Twin Docker & Pre-Deploy Simulator for Plesk

`twin-plesk` to komponent Digital Twin symulujący środowisko produkcyjne serwera Plesk. Umożliwia lokalne uruchamianie aplikacji w środowisku Docker (Nginx + PHP-FPM) z zachowaniem produkcyjnych zasad serwowania vhostów Pleska.

## Funkcje

1. **Plesk Nginx & PHP-FPM Simulation**:
   - Domyślna konfiguracja `DirectoryIndex index.html index.htm index.php`.
   - Obsługa wykonania PHP 8.3/8.5 oraz izolacji wirtualnych hostów.

2. **Detekcja `plesk_default_page_shadowing`**:
   - Wykrywa obecność domyślnych plików `index.html` przesłaniających `index.php`.
   - Weryfikuje poprawność automatycznych przekierowań HTML -> PHP.

3. **Weryfikacja kompletności źródeł przed wdrożeniem (`Source Completeness`)**:
   - Skanuje pliki PHP w poszukiwaniu zależności (np. `require '/lib/...'`) i sprawdza, czy wszystkie wymagane podkatalogi wchodzą w zakres synchronizowanego `source_dir`.

4. **Uwierzytelniona weryfikacja profilu administratora (`verifyAdminProfile`, §4.1)**:
   - Poświadczenie pobierane z prywatnego Vault (`resolvePleskCredential`, KV v2) —
     zasilonego human intake, API mint albo grantowanym harvestem do Vault.
     Sekret żyje tylko w pamięci; token i hasło nigdy nie trafiają do URL ani logu.
   - `verifyAdminProfile` robi read-only call do Plesk REST (`GET /api/v2/server`), hasło jedynie w nagłówku `Authorization: Basic`. Zwraca `{ok, checks, twinUpdate}` bez wartości sekretu.
   - `verifyPleskForTicket` spina `secrets-routes.json` (ticket→`vault_path`+`base_url`) → Vault → weryfikacja → aktualizacja twina. Wynik jest audit-safe (referencje: `vault_path`, `lease_id`; brak sekretu).
   - Wzorzec tras: [`secrets-routes.example.json`](secrets-routes.example.json). Testy offline (wstrzyknięty `fetch`): `test/plesk-verify.test.mjs`.

## Uruchomienie lokalne

```bash
# Uruchomienie środowiska symulacji Plesk
docker compose up -d

# Skanowanie źródła przed wdrożeniem
node src/index.mjs --smoke /path/to/project/app
```
