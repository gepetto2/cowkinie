import logging
import os
from dotenv import load_dotenv
from supabase import create_client, Client

# Załadowanie zmiennych z pliku .env do środowiska

logger = logging.getLogger(__name__)

load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    logger.error("Błąd inicjalizacji: Brak wymaganych zmiennych środowiskowych SUPABASE_URL lub SUPABASE_KEY!")
    exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Miasta objete serwisem. Wspolne dla run_scrapers.py (repertuar) i update_cinemas.py
# (dane o kinach), zeby oba widzialy ten sam zasieg.
TARGET_CITIES = ["Poznań", "Bydgoszcz", "Suwałki", "Gdańsk", "Gdynia", "Sopot", "Kraków", "Warszawa"]
