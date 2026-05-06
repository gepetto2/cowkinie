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
    """Wypełnia główne kolumny release_year i movie_type na podstawie danych z poszczególnych kin."""
    print("\nKonsolidacja danych o filmach (release_year, movie_type)...")
    
    # Pobieramy filmy, które nie mają jeszcze głównego release_year lub movie_type
    response = supabase.table("movies").select(
        "id, title, release_year, movie_type, "
        "release_year_cc, release_year_multikino, release_year_helios, "
        "movie_type_cc, movie_type_multikino, movie_type_helios"
    ).or_("release_year.is.null,movie_type.is.null").execute()
    movies = response.data
    
    if not movies:
        print("Wszystkie filmy mają już określony release_year oraz movie_type.")
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
                
        if update_data:
            supabase.table("movies").update(update_data).eq("id", movie["id"]).execute()
            updated_count += 1
            
    print(f"Zaktualizowano dane dla {updated_count} filmów.")
