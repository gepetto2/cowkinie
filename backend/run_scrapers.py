import os
import asyncio
from supabase import create_client, Client
from dotenv import load_dotenv

# Załadowanie zmiennych z pliku .env do środowiska
load_dotenv()

# Ustawienia Supabase
SUPABASE_URL = os.environ.get("SUPABASE_URL", "twoj-url-z-supabase")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "twoj-klucz-z-supabase")

try:
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
except Exception as e:
    print(f"Błąd inicjalizacji klienta Supabase: {e}")
    exit(1)

# Importujemy funkcje scrapujące z naszych plików
from scrapers.multikino import scrape_and_save as scrape_multikina
from scrapers.cinema_city import scrape_and_save as scrape_cinema_city
from scrapers.helios import scrape_and_save as scrape_helios
from database import consolidate_movie_data
from enrich_movies import enrich_movies_data

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
