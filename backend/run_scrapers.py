import asyncio
from config import supabase

# Importujemy funkcje scrapujące z naszych plików
from scrapers.multikino import scrape_and_save as scrape_multikina
from scrapers.cinema_city import scrape_and_save as scrape_cinema_city
from scrapers.helios import scrape_and_save as scrape_helios
from db.database import consolidate_movie_data
from core.enrich_movies import enrich_movies_data

async def run_all():
    cities_to_scrape = ["Poznań", "Bydgoszcz"]
    
    print(f"Rozpoczynamy pobieranie danych ze wszystkich kin dla miast: {', '.join(cities_to_scrape)}...\n")
    
    # asyncio.gather uruchamia przekazane zadania współbieżnie (jednocześnie).
    await asyncio.gather(
        scrape_multikina(supabase, cities_to_scrape),
        scrape_cinema_city(supabase, cities_to_scrape),
        scrape_helios(supabase, cities_to_scrape)
    )
    print("\nWszystkie dane z Multikina, Cinema City i Heliosa zostały pomyślnie pobrane i zapisane!")
    
    # Konsolidacja zeskrapowanych danych z kin (np. wyciągnięcie wspólnego release_year)
    consolidate_movie_data(supabase)

    # Po zakończeniu scrapowania kin uzupełniamy brakujące dane z TMDB i Filmwebu
    await enrich_movies_data(supabase)

if __name__ == "__main__":
    asyncio.run(run_all())
