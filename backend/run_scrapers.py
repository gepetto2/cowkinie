import asyncio
import sys
from config import supabase

# Importujemy funkcje scrapujące z naszych plików
from scrapers.multikino import scrape_and_save as scrape_multikina
from scrapers.cinema_city import scrape_and_save as scrape_cinema_city
from scrapers.helios import scrape_and_save as scrape_helios
from db.database import consolidate_movie_data, consolidate_release_dates, dedupe_by_normalized_title, dedupe_ukrainian_by_tmdb
from core.enrich_movies import enrich_movies_data

TARGET_CITIES = ["Poznań", "Bydgoszcz"]

async def run_all() -> bool:
    """Zwraca True, jeśli wszystkie źródła zeskrapowały się bez błędu."""
    print(f"Rozpoczynamy pobieranie danych ze wszystkich kin dla miast: {', '.join(TARGET_CITIES)}...\n")

    sources = ["Multikino", "Cinema City", "Helios"]
    # return_exceptions=True: awaria jednego źródła nie przerywa pozostałych ani konsolidacji.
    results = await asyncio.gather(
        scrape_multikina(supabase, TARGET_CITIES),
        scrape_cinema_city(supabase, TARGET_CITIES),
        scrape_helios(supabase, TARGET_CITIES),
        return_exceptions=True
    )

    failed = [name for name, res in zip(sources, results) if isinstance(res, Exception)]
    if failed:
        print(f"\nUWAGA: nieudane źródła: {', '.join(failed)}. Kontynuuję konsolidację na danych częściowych.")
    else:
        print("\nWszystkie dane z Multikina, Cinema City i Heliosa zostały pomyślnie pobrane i zapisane!")

    # Łączymy rekordy różniące się tylko diakrytykami w tytule (np. Andre/André Rieu)
    # przed konsolidacją, żeby dalsze kroki pracowały na odchudzonym zbiorze.
    dedupe_by_normalized_title(supabase)

    # Konsolidacja zeskrapowanych danych z kin (np. wyciągnięcie wspólnego release_year)
    consolidate_movie_data(supabase)

    # Po zakończeniu scrapowania kin uzupełniamy brakujące dane z TMDB i Filmwebu
    await enrich_movies_data(supabase)

    # Scalenie rekordów ukraińskiego dubbingu tego samego filmu z różnych sieci (po tmdb_id nadanym w enrich).
    dedupe_ukrainian_by_tmdb(supabase)

    # Konsolidacja daty premiery MUSI być po enrich - dopiero wtedy znamy daty z TMDB/Filmweb,
    # więc min liczy się ze wszystkich źródeł naraz.
    consolidate_release_dates(supabase)

    return not failed

if __name__ == "__main__":
    success = asyncio.run(run_all())
    # Niezerowy kod wyjścia sygnalizuje awarię źródła (np. dla crona/monitoringu).
    sys.exit(0 if success else 1)
