import os
import aiohttp
from dotenv import load_dotenv
from typing import Optional

load_dotenv()

TMDB_API_KEY = os.environ.get("TMDB_API_KEY")

async def get_tmdb_movie_details(title: str, year: Optional[int] = None, session: Optional[aiohttp.ClientSession] = None):
    """
    Wyszukuje film w bazie TMDB na podstawie tytułu i (opcjonalnie) roku premiery,
    a następnie zwraca jego szczegóły.
    Zwraca słownik z danymi lub None, jeśli filmu nie znaleziono.
    """
    if not TMDB_API_KEY:
        print("Brak TMDB_API_KEY w zmiennych środowiskowych.")
        return None

    # Używamy przekazanej sesji lub tworzymy własną
    if session is None:
        async with aiohttp.ClientSession() as new_session:
            return await _fetch_and_extract(new_session, title, year)
    else:
        return await _fetch_and_extract(session, title, year)

async def _fetch_and_extract(session: aiohttp.ClientSession, title: str, year: Optional[int]):
    search_url = "https://api.themoviedb.org/3/search/movie"
    
    search_titles = [title]
    lower_title = title.lower()
            
    data = None
    for query_title in search_titles:
        params = {
            "api_key": TMDB_API_KEY,
            "query": query_title,
            "language": "pl-PL"
        }
        if year:
            params["primary_release_year"] = str(year)
            
        async with session.get(search_url, params=params) as response:
            if response.status == 200:
                json_data = await response.json()
                if json_data.get("results"):
                    data = json_data
                    break

    # Jeżeli z rokiem nie znaleziono niczego (a został podany), ponów próbę bez roku
    if (not data or not data.get("results")) and year:
        for query_title in search_titles:
            params = {
                "api_key": TMDB_API_KEY,
                "query": query_title,
                "language": "pl-PL"
            }
            async with session.get(search_url, params=params) as response:
                if response.status == 200:
                    json_data = await response.json()
                    if json_data.get("results"):
                        data = json_data
                        break
                    
    if not data or not data.get("results"):
        return None
            
    best_match = None
    for result in data["results"]:
        res_title = result.get("title", "").lower()
        res_orig = result.get("original_title", "").lower()
        if res_title == lower_title or res_orig == lower_title:
            best_match = result
            break
            
    if not best_match:
        best_match = data["results"][0]
        
    movie_id = best_match["id"]
        
    details_url = f"https://api.themoviedb.org/3/movie/{movie_id}"
    details_params = {
        "api_key": TMDB_API_KEY,
        "language": "pl-PL",
        "append_to_response": "credits"
    }
    
    async with session.get(details_url, params=details_params) as details_resp:
        if details_resp.status != 200:
            return None
        tmdb_movie = await details_resp.json()

    release_date = tmdb_movie.get("release_date", "")
    release_year = int(release_date[:4]) if release_date else None
    
    directors = []
    if "credits" in tmdb_movie and "crew" in tmdb_movie["credits"]:
        for crew_member in tmdb_movie["credits"]["crew"]:
            if crew_member.get("job") == "Director":
                directors.append(crew_member.get("name"))
                
    director = ", ".join(directors) if directors else None
                
    return {
        "tmdb_id": movie_id,
        "title": tmdb_movie.get("title"),
        "release_year": release_year,
        "length": tmdb_movie.get("runtime") if tmdb_movie.get("runtime") > 0 else None,
        "director": director,
        "poster_path": tmdb_movie.get("poster_path"),
        "overview": tmdb_movie.get("overview")
    }
