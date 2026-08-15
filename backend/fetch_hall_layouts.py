"""Pobiera układy sal z Heliosa, Multikina i Cinema City do tabeli `cinema_halls`.

Uruchamiany RĘCZNIE, nie w potoku - sale zmieniają się raz na kilka lat. Wymaga tabeli
z sql/2026-08-14-sale-kin.sql.

Każda sieć oddaje układ inaczej, więc wszystko sprowadzamy do jednego kształtu:
    {"rows": [{"label", "y", "seats": [{"label", "x", "kind", "area", "pair"}]}], "areas": [...]}
gdzie `x`/`y` to współrzędne SIATKI (nie piksele), `kind` to standard | sofa | wheelchair,
a `pair` (tylko dla kanap) mówi, czy fotel jest lewym, środkowym czy prawym segmentem siedziska.

Użycie:
    python fetch_hall_layouts.py                      # podgląd, nic nie zapisuje
    python fetch_hall_layouts.py --zapisz
    python fetch_hall_layouts.py --siec helios --zapisz
    python fetch_hall_layouts.py --braki --zapisz     # tylko sale, których jeszcze nie ma
"""
import asyncio
import logging
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from logging_config import setup_logging
setup_logging()

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from curl_cffi import requests

from config import supabase

logger = logging.getLogger(__name__)

HELIOS_CINEMAS = "https://api.helios.pl/api/v1/cinemas"
HELIOS_SCREENS = "https://restapi.helios.pl/api/cinema/{uuid}/screen"
MK_HOME = "https://www.multikino.pl/"
MK_SEATS = "https://www.multikino.pl/api/microservice/booking/Session/{cinema}/{session}/seats"
CC_PRESENTATION = "https://tickets.cinema-city.pl/api/presentations/{pid}"
CC_SEATPLAN = "https://tickets.cinema-city.pl/api/seats/seatplanV2?venueId={venue}&seatplanId={plan}"

# Seans musi być PRZYSZŁY: po zakończeniu sprzedaży Cinema City zwraca TICKETING_ENDED,
# a Multikino przestaje wystawiać mapę. Zapas godzinowy, żeby nie trafić w seans trwający.
FUTURE_MARGIN = timedelta(hours=6)


def _join(seats):
    """Oznacza fotele jednego siedziska: `pair` = "l" | "m" | "r" (skrajny lewy, środkowy, prawy).
    Multikino ma też kanapy TRZYOSOBOWE, więc grupa nie zawsze liczy dwa fotele. Sklejamy wyłącznie
    fotele sąsiadujące - grupa z przerwą w numeracji nie jest jednym siedziskiem."""
    ordered = sorted(seats, key=lambda s: s["x"])
    if len(ordered) < 2 or any(b["x"] - a["x"] != 1 for a, b in zip(ordered, ordered[1:])):
        return
    for i, seat in enumerate(ordered):
        seat["pair"] = "l" if i == 0 else "r" if i == len(ordered) - 1 else "m"


def _hall(rows, areas=None):
    """Składa znormalizowany układ + liczniki. `rows` to [(label, y, [seat...])]."""
    rows = [{"label": lbl, "y": y, "seats": sorted(seats, key=lambda s: s["x"])}
            for lbl, y, seats in sorted(rows, key=lambda r: r[1]) if seats]
    flat = [s for r in rows for s in r["seats"]]
    return {
        "seats_total": len(flat),
        "rows_count": len(rows),
        "wheelchair_seats": sum(1 for s in flat if s["kind"] == "wheelchair"),
        "sofa_seats": sum(1 for s in flat if s["kind"] == "sofa"),
        "layout": {"rows": rows, "areas": areas or []},
    }


# --- Helios: publiczne API, dane PER KINO (jedno żądanie daje wszystkie sale) ---

async def helios_halls(client, cinema_uuid):
    r = await client.get(HELIOS_SCREENS.format(uuid=cinema_uuid), timeout=30.0)
    if r.status_code != 200:
        return {}
    out = {}
    for screen in r.json():
        groups = {g["id"]: (g.get("name") or "") for g in (screen.get("groups") or [])}
        row_label = {row["id"]: row.get("legend") or "" for row in (screen.get("rows") or [])}
        by_row = defaultdict(list)
        by_group = defaultdict(list)
        for s in screen.get("seats") or []:
            # kind '0' to realny fotel, '1' to pusta komórka siatki (przejście).
            # Sprawdzone: suma kind='0' po salach = numberOfSeats z API kina, co do jednego.
            if s.get("kind") != "0":
                continue
            area = groups.get(s.get("groupId")) or ""
            kind = ("wheelchair" if s.get("wheelchairSeat")
                    else "sofa" if "sofa" in area.lower() else "standard")
            seat = {"label": s.get("symbol") or "", "x": s.get("coordinateX") or 0, "kind": kind, "area": area}
            by_row[(row_label.get(s.get("rowId"), ""), s.get("coordinateY") or 0)].append(seat)
            if kind == "sofa":
                by_group[s.get("groupId")].append(seat)
        for seats in by_group.values():
            _join(seats)
        rows = [(lbl, y, seats) for (lbl, y), seats in by_row.items()]
        areas = sorted({g for g in groups.values() if g})
        out[screen.get("name") or ""] = _hall(rows, [{"name": a} for a in areas])
    return out


# --- Multikino: mapa per SEANS, ale zawiera nazwę sali. Wymaga ciasteczka ze strony głównej ---

# `seatStatus` miesza typ ze stanem sprzedaży. 3 nie występuje w `seatIcons` żadnego obszaru
# i pojawia się dokładnie 2 razy na salę - to miejsce na wózek (legenda: "bez fotela").
# Reszta wartości (0/1/4/7/8/9) to wolne/sprzedane/wybrane, czyli stan konkretnego seansu.
MK_WHEELCHAIR_STATUS = 3


async def multikino_hall(client, cinema_code, session_id):
    r = await client.get(MK_SEATS.format(cinema=cinema_code, session=session_id), timeout=30.0)
    if r.status_code != 200:
        return None, None
    data = (r.json() or {}).get("result") or {}
    if not data.get("seatRows"):
        return None, None
    areas = {a["areaCategoryCode"]: a for a in data.get("areaCategories") or []}
    rows = []
    by_group = defaultdict(list)
    # `rowIndex` Multikina rośnie W STRONĘ TYŁU sali - rząd 1 (przy ekranie) ma NAJWYŻSZY indeks.
    # Sortowanie po nim odwracało salę, więc numerujemy rzędy kolejnością z odpowiedzi, która
    # idzie od ekranu.
    for position, row in enumerate(data["seatRows"]):
        seats = []
        # To samo co z rzędami: `columnIndex` liczy od PRZECIWNEGO końca rzędu (pozycja 0 to
        # "A1" z columnIndex 14), więc branie go za współrzędną odbijało salę lustrzanie.
        # Kolejność w tablicy jest właściwa, a `null` w niej to przerwa - pozycja zachowuje ją sama.
        for column, cell in enumerate(row["columns"]):
            if not cell:
                continue
            area = areas.get(cell.get("areaCategoryCode")) or {}
            # O kanapie świadczy WYŁĄCZNIE `sofaSeatCount`. `seatsInGroup` to zwykłe "sprzedawane
            # razem" i łączy też miejsce dla osoby niepełnosprawnej z fotelem opiekuna - branie go
            # za kanapę robiło z opiekuna kanapę przy co drugim takim miejscu.
            kind = ("wheelchair" if cell.get("seatStatus") == MK_WHEELCHAIR_STATUS
                    else "sofa" if cell.get("sofaSeatCount") else "standard")
            seat = {"label": cell.get("name") or "", "x": column,
                    "kind": kind, "area": area.get("areaName") or ""}
            seats.append(seat)
            if cell.get("seatsInGroup") and kind == "sofa":
                by_group[tuple(cell["seatsInGroup"])].append(seat)
        rows.append((row.get("rowLabel") or "", position, seats))
    # `seatsInGroup` to identyfikatory wszystkich foteli siedziska - każdy z nich ma tę samą listę.
    for seats in by_group.values():
        _join(seats)
    named = [{"name": a.get("areaName"), "description": a.get("areaDescription")} for a in areas.values()]
    return (data.get("seatingData") or {}).get("screenLabel"), _hall(rows, named)


# --- Cinema City: seatplanV2 to POST (GET wpada w catch-all SPA), recaptcha nie jest sprawdzana ---

async def cinema_city_hall(client, presentation_id):
    r = await client.get(CC_PRESENTATION.format(pid=presentation_id), timeout=30.0)
    pres = (r.json() or {}).get("presentation") if r.text.strip().startswith("{") else None
    if not pres:
        return None, None
    plan = await client.post(
        CC_SEATPLAN.format(venue=pres["venueId"], plan=pres["seatplanId"]), json={}, timeout=30.0)
    if plan.status_code != 200:
        return None, None
    data = plan.json()
    rows_raw = [row for screen in (data.get("S") or {}).values()
                for group in (screen.get("G") or {}).values()
                for row in (group.get("R") or {}).values()]

    # Klucz miejsca w mapie `S` to IDENTYFIKATOR, nie kolumna: miejsca dla niepełnosprawnych i
    # kanapy bywają pozycjonowane pikselami (`rd.cx`) niezależnie od klucza, przez co blok wózków
    # lądował o kilka kolumn za daleko. Kolumnę liczymy więc z `cx`, a rozstaw bierzemy z danych -
    # najczęstszy odstęp między sąsiednimi fotelami w sali.
    diffs = Counter()
    for row in rows_raw:
        cxs = sorted(s["rd"]["cx"] for s in (row.get("S") or {}).values())
        diffs.update(b - a for a, b in zip(cxs, cxs[1:]) if b > a)
    pitch = diffs.most_common(1)[0][0] if diffs else 60
    all_cx = [s["rd"]["cx"] for row in rows_raw for s in (row.get("S") or {}).values()]
    base = min(all_cx) if all_cx else 0

    by_row = defaultdict(list)
    for screen in (data.get("S") or {}).values():
        for group in (screen.get("G") or {}).values():
            for y, row in (group.get("R") or {}).items():
                # Kanapy stoją na pół-krokach rozstawu, więc samo zaokrąglenie potrafi wsadzić dwa
                # fotele w tę samą kolumnę. Idziemy po kolei od lewej i wymuszamy rosnące kolumny:
                # pozycja jest najbliższa pikselom, a fotele nigdy na siebie nie wchodzą.
                previous = -1
                for x, seat in sorted((row.get("S") or {}).items(),
                                      key=lambda kv: kv[1]["rd"]["cx"]):
                    column = max(previous + 1, round((seat["rd"]["cx"] - base) / pitch))
                    previous = column
                    # `hc` to miejsce dla osoby niepełnosprawnej, a `cl`/`cr` to LEWA i PRAWA
                    # połówka kanapy - zawsze parami i zawsze na sąsiednich pozycjach.
                    # `tg` jest stałe (=1) we wszystkich sprawdzonych salach, więc nie niesie obszaru.
                    side = "l" if seat.get("cl") else "r" if seat.get("cr") else None
                    by_row[(row.get("n") or "", int(y))].append({
                        "label": seat.get("n") or "", "x": column,
                        "kind": "wheelchair" if seat.get("hc") else "sofa" if side else "standard",
                        "area": "",
                        **({"pair": side} if side else {}),
                    })
    return pres.get("venueName"), _hall([(lbl, y, seats) for (lbl, y), seats in by_row.items()])


# Ile seansów na salę trzymamy w zapasie. Seans potrafi zniknąć z systemu sieci między naszym
# scrapem a tym przebiegiem (Cinema City odpowiada wtedy PRESENTATION_NOT_FOUND) - jeden kandydat
# na salę wystarczał w 950 przypadkach na 951.
CANDIDATES = 3


def targets(skip=frozenset()):
    """{franczyza: {(cinema_id, nazwa_kina, room_name): [link, ...]}} - PRZYSZŁE seanse, najwcześniejsze."""
    cinemas = {c["id"]: c for c in supabase.table("cinemas").select("id,name,franchise").execute().data}
    cutoff = datetime.now(timezone.utc) + FUTURE_MARGIN
    found = defaultdict(list)
    offset = 0
    while True:
        batch = (supabase.table("screenings").select("cinema_id,room_name,booking_link,start_time")
                 .range(offset, offset + 999).execute().data)
        for row in batch:
            cinema = cinemas.get(row["cinema_id"])
            if not cinema or not row["room_name"] or not row["booking_link"]:
                continue
            if (cinema["id"], row["room_name"]) in skip:
                continue
            if datetime.fromisoformat(row["start_time"]) <= cutoff:
                continue
            key = (cinema["franchise"], cinema["id"], cinema["name"], row["room_name"])
            found[key].append((row["start_time"], row["booking_link"]))
        offset += 1000
        if len(batch) < 1000:
            break

    out = defaultdict(dict)
    for (franchise, cinema_id, name, room), links in found.items():
        out[franchise][(cinema_id, name, room)] = [l for _, l in sorted(links)[:CANDIDATES]]
    return out


def existing_halls():
    """{(cinema_id, room_name)} już zapisane - do trybu --braki."""
    out, offset = set(), 0
    while True:
        batch = (supabase.table("cinema_halls").select("cinema_id,room_name")
                 .range(offset, offset + 999).execute().data)
        out |= {(r["cinema_id"], r["room_name"]) for r in batch}
        offset += 1000
        if len(batch) < 1000:
            return out


def save(rows, do_save):
    if do_save and rows:
        supabase.table("cinema_halls").upsert(rows, on_conflict="cinema_id,room_name").execute()


async def main(do_save: bool, only: str | None, gaps_only: bool) -> int:
    done = existing_halls() if gaps_only else frozenset()
    goals = targets(done)
    saved, failed = 0, []

    async with requests.AsyncSession(impersonate="chrome") as client:
        # HELIOS - per kino, więc nazwy sal bierzemy prosto ze źródła, nie z naszej bazy.
        if only in (None, "helios"):
            ours = {c["name"]: c["id"] for c in
                    supabase.table("cinemas").select("id,name,franchise").execute().data
                    if c["franchise"] == "Helios"}
            # W trybie --braki ruszamy tylko kina, którym faktycznie brakuje sal. Nazw sal Heliosa
            # nie znamy przed pobraniem, ale wiemy z `goals`, w których kinach są luki.
            needed = {cid for cid, _, _ in goals.get("Helios", {})} if gaps_only else None
            api = (await client.get(HELIOS_CINEMAS, timeout=30.0)).json()
            api = api.get("data", api) if isinstance(api, dict) else api
            for cinema in api:
                # Helios oddaje część nazw z podwójną spacją ("Gdańsk  Forum"). upsert_cinema
                # normalizuje białe znaki przy zapisie, więc tutaj musimy zrobić to samo -
                # inaczej 12 kin nie dopasuje się do naszej bazy.
                name = re.sub(r"\s+", " ", (cinema.get("name") or "").replace("Helios", "")).strip()
                cinema_id = ours.get(name)
                if not cinema_id or not cinema.get("sourceId"):
                    continue
                if needed is not None and cinema_id not in needed:
                    continue
                halls = await helios_halls(client, cinema["sourceId"])
                rows = [{"cinema_id": cinema_id, "room_name": room, "source": "helios", **hall}
                        for room, hall in halls.items()
                        if room and (cinema_id, room) not in done]
                if not rows:
                    continue
                save(rows, do_save)
                saved += len(rows)
                logger.info("Helios %s: %s sal, %s miejsc", name, len(rows),
                            sum(r["seats_total"] for r in rows))

        # MULTIKINO - mapa siedzi w ścieżce rezerwacji, ale wystarczy anonimowe ciasteczko.
        if only in (None, "multikino"):
            await client.get(MK_HOME, timeout=30.0)
            for (cinema_id, name, room), links in goals.get("Multikino", {}).items():
                label = hall = None
                for link in links:
                    m = re.search(r"/(\d{4})/[^/]+/(\d+)", link)
                    if m:
                        label, hall = await multikino_hall(client, m.group(1), m.group(2))
                    if hall:
                        break
                if not hall:
                    failed.append(f"Multikino {name} {room}: brak mapy ({len(links)} prób)")
                    continue
                _warn_mismatch("Multikino", name, room, label)
                save([{"cinema_id": cinema_id, "room_name": room, "source": "multikino", **hall}], do_save)
                saved += 1
                logger.info("Multikino %s %s: %s miejsc", name, room, hall["seats_total"])

        # CINEMA CITY - dwa żądania na salę: rozwiązanie seansu, potem plan.
        if only in (None, "cc"):
            for (cinema_id, name, room), links in goals.get("Cinema City", {}).items():
                label = hall = None
                for link in links:
                    m = re.search(r"/order/(\d+)", link)
                    if m:
                        label, hall = await cinema_city_hall(client, m.group(1))
                    if hall:
                        break
                if not hall:
                    failed.append(f"Cinema City {name} {room}: brak mapy ({len(links)} prób)")
                    continue
                _warn_mismatch("Cinema City", name, room, label)
                save([{"cinema_id": cinema_id, "room_name": room, "source": "cinema-city", **hall}], do_save)
                saved += 1
                logger.info("Cinema City %s %s: %s miejsc", name, room, hall["seats_total"])

    print(f"\n=== sal: {saved} | nieudane: {len(failed)}{'' if do_save else '  (TRYB PODGLĄDU - bez zapisu)'}")
    for f in failed:
        print("   ", f)
    return 0


def _warn_mismatch(chain, cinema, room, label):
    """Nazwa sali ze źródła musi się zgadzać z naszym `room_name` - to klucz złączenia."""
    if label and label.strip() != room.strip():
        logger.warning("%s %s: źródło mówi %r, u nas %r - sprawdź złączenie.", chain, cinema, label, room)


if __name__ == "__main__":
    args = sys.argv[1:]
    chain = args[args.index("--siec") + 1] if "--siec" in args else None
    sys.exit(asyncio.run(main("--zapisz" in args, chain, "--braki" in args)))
