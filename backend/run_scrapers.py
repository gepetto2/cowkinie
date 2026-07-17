import logging
import asyncio
import sys

# Konfigurujemy logowanie ZANIM zaimportujemy config (który loguje przy starcie).
from logging_config import setup_logging
setup_logging()

from config import supabase

# Importujemy funkcje scrapujące z naszych plików
from scrapers.multikino import scrape_and_save as scrape_multikina
from scrapers.cinema_city import scrape_and_save as scrape_cinema_city
from scrapers.helios import scrape_and_save as scrape_helios
from scrapers.kino_muza import scrape_and_save as scrape_muza
from db.database import consolidate_movie_data, consolidate_release_dates, dedupe_by_normalized_title, dedupe_ukrainian_by_tmdb
from core.enrich_movies import enrich_movies_data


logger = logging.getLogger(__name__)
TARGET_CITIES = ["Poznań", "Bydgoszcz"]

async def run_all() -> bool:
    """Zwraca True, jeśli wszystkie źródła zeskrapowały się bez błędu."""
    logger.info("=== START: pobieranie danych ze wszystkich kin dla miast: %s ===", ", ".join(TARGET_CITIES))

    sources = ["Multikino", "Cinema City", "Helios", "Kino Muza"]
    # return_exceptions=True: awaria jednego źródła nie przerywa pozostałych ani konsolidacji.
    results = await asyncio.gather(
        scrape_multikina(supabase, TARGET_CITIES),
        scrape_cinema_city(supabase, TARGET_CITIES),
        scrape_helios(supabase, TARGET_CITIES),
        scrape_muza(supabase, TARGET_CITIES),
        return_exceptions=True
    )

    failed = [name for name, res in zip(sources, results) if isinstance(res, Exception)]
    if failed:
        logger.warning("Nieudane źródła: %s. Kontynuuję konsolidację na danych częściowych.", ", ".join(failed))
    else:
        logger.info("Wszystkie źródła (Multikino, Cinema City, Helios) pobrane i zapisane.")

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

    logger.info("=== KONIEC: proces zakończony (bez błędów źródeł: %s) ===", not failed)
    return not failed

if __name__ == "__main__":
    success = asyncio.run(run_all())
    # Niezerowy kod wyjścia sygnalizuje awarię źródła (np. dla crona/monitoringu).
    sys.exit(0 if success else 1)
