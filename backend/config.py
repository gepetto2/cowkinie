import os
from dotenv import load_dotenv
from supabase import create_client, Client

# Załadowanie zmiennych z pliku .env do środowiska
load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("Błąd inicjalizacji: Brak wymaganych zmiennych środowiskowych SUPABASE_URL lub SUPABASE_KEY!")
    exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
