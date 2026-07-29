import logging
import difflib
from supabase import Client


logger = logging.getLogger(__name__)

def get_similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, str(a).lower(), str(b).lower()).ratio()

# Markery WERSJI filmu (inny montaż, nie inne wydanie tego samego). Wersja rozszerzona/reżyserska ma
# to samo tmdb_id co podstawowa, ale to OSOBNY film - nie wolno ich scalać po tmdb_id.
_VERSION_MARKERS = ("rozszerzon", "reżysersk", "rezysersk", "zremasterowan", "extended", "director", "niemy")

def version_key(title: str) -> frozenset:
    """Zbiór markerów wersji obecnych w tytule. Różne zbiory = różne wersje = nie scalamy."""
    t = (title or "").lower()
    return frozenset(m for m in _VERSION_MARKERS if m in t)

def check_and_merge_movie(supabase: Client, current_movie: dict, tmdb_id: int, seen_tmdb_ids: dict, tmdb_title: str) -> bool:
    """
    Sprawdza czy film o danym tmdb_id już istnieje (w seen_tmdb_ids).
    Jeśli tak, porównuje oba tytuły do tytułu z TMDB i wybiera bardziej zbliżony.
    Przepina seanse na wybrany film główny i usuwa ten gorszy.
    Zwraca True jeśli film był duplikatem (i został usunięty), w przeciwnym razie False.
    """
    # DLA DZIECI: prawdziwe filmy dziecięce mają ten sam tmdb_id co event Heliosa (np. karaoke/poranki),
    # ale to osobne pokazy - nie scalamy po tmdb_id (scalanie po tytule i tak działa dla zwykłych filmów).
    if current_movie.get("movie_type") in ("LADIES NIGHT/KNO", "UKRAIŃSKI DUBBING", "UNLIMITED SHOW", "DLA DZIECI"):
        return False

    # Klucz uwzględnia wersję: wersja rozszerzona/reżyserska tego samego filmu (to samo tmdb_id)
    # dostaje inny klucz niż podstawowa, więc NIE zostanie z nią scalona (to osobny film).
    key = (tmdb_id, version_key(current_movie.get("title")))

    if key in seen_tmdb_ids:
        seen_movie = seen_tmdb_ids[key]
        seen_movie_id = seen_movie["id"]
        seen_movie_title = seen_movie.get("title", "Nieznany tytuł")
        
        current_movie_id = current_movie.get("id")
        current_movie_title = current_movie.get("title", "Nieznany tytuł")
        
        # Obliczamy podobieństwo tytułów do tytułu z TMDB
        sim_seen = get_similarity(seen_movie_title, tmdb_title)
        sim_current = get_similarity(current_movie_title, tmdb_title)
        
        if sim_seen >= sim_current:
            # Zostawiamy dotychczasowy film (seen), usuwamy obecny (current)
            source_id, source_title = current_movie_id, current_movie_title
            target_id, target_title = seen_movie_id, seen_movie_title
            current_is_duplicate = True
        else:
            # Zostawiamy obecny film (current), usuwamy dotychczasowy (seen)
            source_id, source_title = seen_movie_id, seen_movie_title
            target_id, target_title = current_movie_id, current_movie_title
            current_is_duplicate = False
            
        logger.info(f"-> [Merge] Znaleziono duplikat! Łączenie: '{source_title}' -> '{target_title}' (TMDB ID {tmdb_id}).")
        logger.info(f"Podobieństwo do '{tmdb_title}': '{seen_movie_title}' ({sim_seen:.2f}) vs '{current_movie_title}' ({sim_current:.2f})")
        
        try:
            # 1. Scalenie danych z obu rekordów (np. scraperów), aby nie utracić informacji
            source_res = supabase.table("movies").select("*").eq("id", source_id).execute()
            target_res = supabase.table("movies").select("*").eq("id", target_id).execute()
            
            if source_res.data and target_res.data:
                source_data = source_res.data[0]
                target_data = target_res.data[0]
                
                update_payload = {}
                # Przenosimy tylko niepuste wartości z usuwanego filmu w puste miejsca pozostawianego
                for key, value in source_data.items():
                    if key not in ("id", "created_at") and target_data.get(key) is None and value is not None:
                        update_payload[key] = value
                        
                if update_payload:
                    supabase.table("movies").update(update_payload).eq("id", target_id).execute()

            # 2. Przepięcie seansów z duplikatu na główny film
            supabase.table("screenings").update({"movie_id": target_id}).eq("movie_id", source_id).execute()
            # 3. Usunięcie zduplikowanego filmu
            supabase.table("movies").delete().eq("id", source_id).execute()
            logger.info(f"-> [Merge] Pomyślnie przeniesiono seanse, scalono brakujące dane i usunięto zduplikowany wpis.")
            
            # Aktualizacja pamięci, jeśli nowym głównym filmem został ten obecnie przetwarzany
            if not current_is_duplicate:
                seen_tmdb_ids[key] = {"id": target_id, "title": target_title}
                
        except Exception as e:
            logger.error(f"-> [Merge] Błąd podczas łączenia duplikatów: {e}")
            
        return current_is_duplicate
    else:
        # Zapisujemy w pamięci, aby kolejne duplikaty w tej samej pętli mogły zostać połączone
        seen_tmdb_ids[key] = {"id": current_movie.get("id"), "title": current_movie.get("title")}
        return False
