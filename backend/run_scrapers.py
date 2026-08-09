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
from scrapers.cinema_lumiere import scrape_and_save as scrape_lumiere
from scrapers.kino_apollo import scrape_and_save as scrape_apollo
from scrapers.kino_bulgarska import scrape_and_save as scrape_bulgarska
from scrapers.kino_rialto import scrape_and_save as scrape_rialto
from scrapers.kino_palacowe import scrape_and_save as scrape_palacowe
from scrapers.kino_malta import scrape_and_save as scrape_malta
from db.database import (
    consolidate_movie_data, consolidate_post_enrich, dedupe_by_normalized_title,
    dedupe_ukrainian_by_tmdb, delete_past_screenings, delete_orphan_movies, log_run_summary,
)
from core.enrich_movies import enrich_movies_data, refresh_movie_ratings
from core.small_sources import save_small_sources


logger = logging.getLogger(__name__)
TARGET_CITIES = ["Poznań", "Bydgoszcz", "Suwałki", "Gdańsk", "Gdynia", "Sopot", "Kraków", "Warszawa"]

async def run_all() -> bool:
    """Zwraca True, jeśli wszystkie źródła zeskrapowały się bez błędu."""
    logger.info("=== START: pobieranie danych ze wszystkich kin dla miast: %s ===", ", ".join(TARGET_CITIES))

    sources = ["Multikino", "Cinema City", "Helios", "Kino Muza", "Cinema Lumiere", "Kino Apollo", "Kino Bułgarska 19", "Kino Rialto", "Kino Pałacowe", "Kino Malta"]
    # return_exceptions=True: awaria jednego źródła nie przerywa pozostałych ani konsolidacji.
    results = await asyncio.gather(
        scrape_multikina(supabase, TARGET_CITIES),
        scrape_cinema_city(supabase, TARGET_CITIES),
        scrape_helios(supabase, TARGET_CITIES),
        scrape_muza(supabase, TARGET_CITIES),
        scrape_lumiere(supabase, TARGET_CITIES),
        scrape_apollo(supabase, TARGET_CITIES),
        scrape_bulgarska(supabase, TARGET_CITIES),
        scrape_rialto(supabase, TARGET_CITIES),
        scrape_palacowe(supabase, TARGET_CITIES),
        scrape_malta(supabase, TARGET_CITIES),
        return_exceptions=True
    )

    failed = [name for name, res in zip(sources, results) if isinstance(res, Exception)]
    if failed:
        # Powód per źródło - przy blokadzie (ScraperError) widać ją od razu, bez grzebania w logu wyżej.
        for name, res in zip(sources, results):
            if isinstance(res, Exception):
                logger.warning("Źródło nieudane - %s: %s: %s", name, type(res).__name__, res)
        logger.warning("Nieudane źródła: %s. Kontynuuję konsolidację na danych częściowych.", ", ".join(failed))
    else:
        logger.info("Wszystkie źródła (%s) pobrane i zapisane.", ", ".join(sources))

    # Dane z małych kin scalamy PO zakończeniu wszystkich scraperów, wg jawnego priorytetu.
    # Scrapery działają równolegle, więc gdyby każdy zapisywał wspólne kolumny *_small sam,
    # o wartości decydowałby ten, który akurat skończy później (patrz core/small_sources.py).
    # Klucze muszą odpowiadać nazwom w small_sources.PRIORITY - to one ustalają pierwszeństwo.
    SMALL_SOURCE_KEYS = {"Kino Rialto": "rialto", "Kino Pałacowe": "palacowe", "Kino Bułgarska 19": "bulgarska", "Kino Malta": "malta"}  # Apollo pomijamy - patrz komentarz w scrapers/kino_apollo.py
    small_data = {
        SMALL_SOURCE_KEYS[name]: res
        for name, res in zip(sources, results)
        if name in SMALL_SOURCE_KEYS and isinstance(res, dict)
    }
    if small_data:
        save_small_sources(supabase, small_data)

    # Łączymy rekordy różniące się tylko diakrytykami w tytule (np. Andre/André Rieu)
    # przed konsolidacją, żeby dalsze kroki pracowały na odchudzonym zbiorze.
    dedupe_by_normalized_title(supabase)

    # Konsolidacja zeskrapowanych danych z kin (np. wyciągnięcie wspólnego release_year)
    consolidate_movie_data(supabase)

    # Po zakończeniu scrapowania kin uzupełniamy brakujące dane z TMDB i Filmwebu
    enriched_count = await enrich_movies_data(supabase)

    # Odświeżenie ocen filmów JUŻ dopasowanych - enrich bierze wyłącznie nowe (bez title_tmdb),
    # więc bez tego kroku oceny zostawałyby zamrożone w dniu pierwszego dopasowania, czyli wtedy,
    # gdy film ma najmniej głosów i najbardziej chwiejną średnią.
    await refresh_movie_ratings(supabase)

    # Scalenie rekordów ukraińskiego dubbingu tego samego filmu z różnych sieci (po tmdb_id nadanym w enrich).
    dedupe_ukrainian_by_tmdb(supabase)

    # Konsolidacja po enrich MUSI być po enrich - dopiero wtedy znamy dane z TMDB/Filmweb
    # (daty, rok, czas, plakat-fallback, gatunek), więc liczą się ze wszystkich źródeł naraz.
    consolidate_post_enrich(supabase)

    # Sprzątanie (umożliwia scrapowanie bez czyszczenia bazy):
    # - przeszłe seanse usuwamy zawsze (są zawsze nieaktualne),
    # - osierocone filmy tylko gdy WSZYSTKIE źródła OK (inaczej skasowalibyśmy filmy nieudanego źródła).
    past_deleted = delete_past_screenings(supabase)
    orphans_deleted = 0
    if not failed:
        orphans_deleted = delete_orphan_movies(supabase)
    else:
        logger.warning("Pomijam kasowanie osieroconych filmów - było nieudane źródło.")

    log_run_summary(supabase, enriched_count or 0, past_deleted, orphans_deleted, failed_sources=failed)

    logger.info("=== KONIEC: proces zakończony (bez błędów źródeł: %s) ===", not failed)
    return not failed

if __name__ == "__main__":
    success = asyncio.run(run_all())
    # Niezerowy kod wyjścia sygnalizuje awarię źródła (np. dla crona/monitoringu).
    sys.exit(0 if success else 1)
