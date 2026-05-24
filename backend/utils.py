import re
from datetime import datetime
from zoneinfo import ZoneInfo

def parse_start_time(start_time_raw: str) -> str:
    """Parsuje ciąg daty i w razie braku strefy czasowej dodaje Europe/Warsaw."""
    if not start_time_raw:
        return ""
    try:
        dt_obj = datetime.fromisoformat(start_time_raw)
        if dt_obj.tzinfo is None:
            dt_obj = dt_obj.replace(tzinfo=ZoneInfo("Europe/Warsaw"))
        return dt_obj.isoformat()
    except ValueError:
        return start_time_raw

def clean_title(title: str) -> str:
    if not title:
        return ""
    
    original_title = title

    # Ujednolicenie myślników (półpauza i pauza na zwykły dywiz)
    title = title.replace("–", "-").replace("—", "-")
    # Usuwa przedrostki kinowe
    title = re.sub(r'^(?:NMF|NT Live)[:\s\-]+', '', title, flags=re.IGNORECASE)
    # Usuwa rocznice np. " 40. Rocznica", " 40th Anniversary"
    title = re.sub(r'(?:\.\s*)?\s*\d+(?:\.|st|nd|rd|th)?\s*(?:[Rr]ocznica|Anniversary)\b.*$', '', title, flags=re.IGNORECASE)
    # Usuwa typowy dopisek CC
    title = title.replace(" - National Theatre Live 2026", "")
    title = title.removesuffix(" - wersja oryginalna")
    title = title.removesuffix(". Wersja zremasterowana")
    title = title.removesuffix("- powrót do kin")
    # Zamiana skrótu na pełne słowo (np. "Diuna: cz. 2" -> "Diuna: część 2")
    title = title.replace("cz.", "część").replace("Cz.", "Część")
    
    cleaned_title = title.strip()
    if original_title != cleaned_title:
        print(f"Zmieniono tytuł: '{original_title}' -> '{cleaned_title}'")
        
    return cleaned_title
