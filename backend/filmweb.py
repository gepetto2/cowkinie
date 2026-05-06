import asyncio
import aiohttp
import urllib.parse
from typing import Optional

async def get_filmweb_movie_id(title: str, year: Optional[int], session: aiohttp.ClientSession):
    # Kodowanie tytułu do formatu URL (zamiana spacji na %20 itp.)
    query = urllib.parse.quote(title)
    url = f"https://www.filmweb.pl/api/v1/search?query={query}"
    
    # Dodajemy nagłówek User-Agent, aby Filmweb nie zablokował naszego skryptu
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    
    try:
        async with session.get(url, headers=headers, timeout=10) as response:
            response.raise_for_status() # Wyrzuci błąd dla kodów HTTP 4xx i 5xx
            
            data = await response.json()
            search_hits = data.get("searchHits", [])
            
            # Filtrujemy tylko wyniki, które są filmami
            film_hits = [hit for hit in search_hits if hit.get("type") == "film"]
            
            if not film_hits:
                print(f"Nie znaleziono żadnych filmów dla zapytania: '{title}'")
                return None
                
            if year:
                for hit in film_hits:
                    hit_year = hit.get("year")
                    if hit_year and str(hit_year) == str(year):
                        film_id = hit.get("id")
                        film_title = hit.get("matchedTitle")
                        print(f"Znaleziono dokładne dopasowanie: '{film_title}' ({hit_year}) z ID: {film_id}")
                        return film_id
                print(f"Nie znaleziono filmu '{title}' z roku {year}. Próba dopasowania pierwszego wyniku...")

            # Zwracamy ID pierwszego znalezionego filmu (wartość zapasowa / brak roku)
            first_film_id = film_hits[0].get("id")
            first_film_title = film_hits[0].get("matchedTitle")
            
            print(f"Znaleziono film: '{first_film_title}' z ID: {first_film_id}")
            return first_film_id
                
    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
        print(f"Błąd podczas łączenia z API Filmwebu: {e}")
        return None

async def get_filmweb_movie_details(movie_id: int, session: aiohttp.ClientSession):
    """Pobiera szczegółowe informacje o filmie na podstawie jego ID."""
    url = f"https://www.filmweb.pl/api/v1/film/{movie_id}/preview"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    
    try:
        async with session.get(url, headers=headers, timeout=10) as response:
            response.raise_for_status()
            
            data = await response.json()
            
            # Reżyserzy to lista obiektów, więc wyciągamy z nich imiona
            directors_list = data.get("directors", [])
            directors = ", ".join([d.get("name") for d in directors_list if d.get("name")])
            
            # Wyciąganie tytułu - fallback na 'originalTitle', jeśli 'title' nie istnieje
            film_title = data.get("title", {}).get("title") or data.get("originalTitle", {}).get("title")
            
            return {
                "title": film_title,
                "year": data.get("year"),
                "duration": data.get("duration"),
                "directors": directors
            }
            
    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
        print(f"Błąd podczas pobierania szczegółów filmu (ID: {movie_id}): {e}")
        return None

async def search_movie_details(title: str, year: Optional[int] = None, session: Optional[aiohttp.ClientSession] = None):
    """Funkcja główna: pobiera szczegóły filmu na podstawie tytułu i opcjonalnie roku."""
    if session is None:
        async with aiohttp.ClientSession() as new_session:
            movie_id = await get_filmweb_movie_id(title, year, new_session)
            if movie_id:
                return await get_filmweb_movie_details(movie_id, new_session)
            return None
    else:
        movie_id = await get_filmweb_movie_id(title, year, session)
        if movie_id:
            return await get_filmweb_movie_details(movie_id, session)
        return None