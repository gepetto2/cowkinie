def upsert_cinema(supabase, name: str, city: str, franchise: str) -> str:
    """Dodaje lub aktualizuje kino w bazie danych i zwraca jego ID."""
    cinema_res = supabase.table("cinemas").upsert(
        {"name": name, "city": city, "franchise": franchise},
        on_conflict="name,franchise"
    ).execute()
    return cinema_res.data[0]["id"]

def upsert_movies_batch(supabase, movies_to_upsert: dict) -> dict:
    """
    Upsertuje słownik z filmami i aktualizuje cache filmów o nowe ID z bazy.
    Zwraca zaktualizowany cache: {title: movie_id}
    """
    if not movies_to_upsert:
        return {}
        
    movie_res = supabase.table("movies").upsert(
        list(movies_to_upsert.values()),
        on_conflict="title"
    ).execute()
    
    return {m["title"]: m["id"] for m in movie_res.data}

def upsert_screenings_chunked(supabase, screenings_dict: dict, cinema_name: str, chunk_size: int = 1000):
    """Zapisuje seanse do bazy danych z uwzględnieniem paginacji."""
    if not screenings_dict:
        return
        
    screenings_list = list(screenings_dict.values())
    for i in range(0, len(screenings_list), chunk_size):
        supabase.table("screenings").upsert(
            screenings_list[i:i+chunk_size],
            on_conflict="movie_id,cinema_id,start_time,room_name",
            ignore_duplicates=True
        ).execute()
    print(f"Zapisano {len(screenings_list)} seansów do bazy dla kina {cinema_name}.")

def consolidate_movie_data(supabase):
    """Wypełnia główne kolumny release_year, movie_type, director, original_title i poster na podstawie danych z poszczególnych źródeł."""
    print("\nKonsolidacja danych o filmach (release_year, movie_type, director, original_title, poster)...")
    
    # Pobieramy filmy, które nie mają jeszcze głównego release_year, movie_type, director, original_title lub poster
    response = supabase.table("movies").select(
        "id, title, release_year, movie_type, director, original_title, poster, "
        "release_year_cc, release_year_multikino, release_year_helios, "
        "movie_type_cc, movie_type_multikino, movie_type_helios, "
        "director_multikino, director_helios, director_cc, "
        "original_title_cc, original_title_helios, "
        "poster_cc, poster_multikino, poster_helios"
    ).or_("release_year.is.null,movie_type.is.null,director.is.null,original_title.is.null,poster.is.null").execute()
    movies = response.data
    
    if not movies:
        print("Wszystkie filmy mają już określony release_year, movie_type, director, original_title oraz poster.")
        return
        
    updated_count = 0
    for movie in movies:
        update_data = {}
        
        if movie.get("release_year") is None:
            years = [movie.get("release_year_multikino"), movie.get("release_year_cc"), movie.get("release_year_helios")]
            valid_years = [y for y in years if y is not None]
            
            if valid_years:
                # Wybieramy najstarszy zeskrapowany rok
                update_data["release_year"] = min(valid_years)

        if movie.get("movie_type") is None:
            types = [movie.get("movie_type_multikino"), movie.get("movie_type_cc"), movie.get("movie_type_helios")]
            valid_types = [t for t in types if t] # Pobieramy tylko niepuste stringi
            
            if valid_types:
                unique_types = list(set(valid_types))
                if len(unique_types) > 1:
                    print(f"  Uwaga: Niezgodność typów dla filmu '{movie.get('title')}': {unique_types}")
                
                # Wybieramy pierwszą z brzegu niepustą wartość
                update_data["movie_type"] = valid_types[0]
                
        if movie.get("director") is None:
            directors = [
                movie.get("director_multikino"),
                movie.get("director_helios"),
                movie.get("director_cc")
            ]
            valid_directors = [d for d in directors if d]
            
            if valid_directors:
                unique_directors = list({d.lower(): d for d in valid_directors}.values())
                if len(unique_directors) > 1:
                    longest_director_lower = max(unique_directors, key=len).lower()
                    if not all(d.lower() in longest_director_lower for d in unique_directors):
                        print(f"  Uwaga: Niezgodność reżyserów dla filmu '{movie.get('title')}': {unique_directors}")
                
                # Wybieramy najdłuższą z dostępnych wartości
                update_data["director"] = max(valid_directors, key=len)
                
        if movie.get("original_title") is None:
            original_titles = [
                movie.get("original_title_helios"),
                movie.get("original_title_cc")
            ]
            valid_titles = [t for t in original_titles if t]
            
            if valid_titles:
                unique_titles = list(set(valid_titles))
                if len(unique_titles) > 1:
                    print(f"  Uwaga: Niezgodność oryginalnych tytułów dla filmu '{movie.get('title')}': {unique_titles}")
                
                # Preferujemy tytuł z Heliosa, w drugiej kolejności z Cinema City
                update_data["original_title"] = movie.get("original_title_helios") or movie.get("original_title_cc")
                
        if movie.get("poster") is None:
            posters = [
                movie.get("poster_cc"),
                movie.get("poster_helios"),
                movie.get("poster_multikino")
            ]
            valid_posters = [p for p in posters if p]
            
            if valid_posters:
                update_data["poster"] = valid_posters[0]

        if update_data:
            supabase.table("movies").update(update_data).eq("id", movie["id"]).execute()
            updated_count += 1
            
    print(f"Zaktualizowano dane dla {updated_count} filmów.")
