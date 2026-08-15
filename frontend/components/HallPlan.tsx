"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";

// Układ sali waży w medianie 10 KB, a komplet 951 sal - 10 MB, więc pobieramy go DOPIERO tutaj,
// dla jednej sali, którą użytkownik faktycznie ogląda. Kształt zapisuje backend/fetch_hall_layouts.py.
// `pair` to pozycja fotela w siedzisku: skrajny lewy, środkowy, skrajny prawy. Multikino ma też
// kanapy trzyosobowe, stąd "m". Brak pola = fotel osobny.
type Seat = { label: string; x: number; kind: "standard" | "sofa" | "wheelchair"; area?: string; pair?: "l" | "m" | "r" };
type Row = { label: string; y: number; seats: Seat[] };
type Layout = { rows: Row[]; areas?: { name: string; description?: string }[] };

const SEAT_CLASS: Record<Seat["kind"], string> = {
  standard: "bg-slate-600",
  sofa: "bg-indigo-500",
  wheelchair: "bg-amber-500",
};

const LEGEND: [Seat["kind"], string][] = [
  ["standard", "zwykłe"],
  ["sofa", "kanapa"],
  ["wheelchair", "miejsce dla niepełnosprawnych"],
];

// Odstęp między fotelami jako UŁAMEK ich szerokości, nie stała w pikselach. Fotel kurczy się wraz
// z szerokością ramki (patrz niżej), więc sztywne 3 px przy 12 px to ładne 25%, ale przy 5 px na
// telefonie już 60% - i sala zamieniała się w rozsypane kropki. Odstęp pionowy zostaje stały:
// procentowy `row-gap` liczy się od wysokości, a ta jest tu nieokreślona.
const GAP_RATIO = 0.25;
const ROW_GAP = 2;

// Fotel nie ma stałego rozmiaru: kolumny to `minmax(MIN, 1fr)`, więc szeroka sala (do 48 kolumn)
// kurczy się do szerokości modalu zamiast wypychać pasek przewijania, a wąska (od 6 kolumn) nie
// rozdyma się na cały wiersz, bo blok ma `maxWidth` liczony z MAX. Pasek pojawia się dopiero
// wtedy, gdy nawet przy MIN sala się nie mieści - poniżej tego rozmiaru fotele przestają być czytelne.
const SEAT_MAX = 12;
const SEAT_MIN = 5;

// Zaokrąglenie rogu jako procent boku - stałe 2 px przy 12 px to subtelny róg, ale przy 5 px
// już 40% boku, czyli fotel robi się kółkiem. Procent utrzymuje ten sam kształt w każdej skali.
const RADIUS = "16%";

export default function HallPlan({ cinemaId, roomName }: { cinemaId: string; roomName: string | null }) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!roomName) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("cinema_halls")
        .select("layout")
        .eq("cinema_id", cinemaId)
        .eq("room_name", roomName)
        .maybeSingle();
      if (cancelled) return;
      setLayout((data?.layout ?? null) as Layout | null);
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [cinemaId, roomName]);

  if (!roomName) return null;
  if (!loaded) return <div className="h-24 rounded-lg border border-slate-800 bg-slate-900/40 animate-pulse" />;
  if (!layout?.rows?.length) return null;

  // Współrzędne `x` są siatką ŹRÓDŁA i nie zaczynają się od zera (kolumny brzegowe bywają puste),
  // więc przesuwamy je do wspólnego początku - inaczej sala byłaby wyrenderowana z pustym marginesem.
  const xs = layout.rows.flatMap((r) => r.seats.map((s) => s.x));
  const minX = Math.min(...xs);
  const columns = Math.max(...xs) - minX + 1;
  const kinds = new Set(layout.rows.flatMap((r) => r.seats.map((s) => s.kind)));
  // Etykiety rzędów bywają rzymskie ("XVIII"), więc stała szerokość rynny je ucinała. `ch` mierzy
  // szerokość znaku, a `tabular-nums` wyrównuje cyfry, więc rynna jest równa we wszystkich rzędach.
  const gutter = `${Math.max(2, ...layout.rows.map((r) => r.label.length))}ch`;
  // Odstęp w procentach szerokości rzędu, tak by wyszedł równo GAP_RATIO szerokości fotela:
  // z `N*s + (N-1)*g = W` oraz `g = k*s` wychodzi `g/W = k / (N + k*(N-1))`.
  const columnGap = `${(GAP_RATIO / (columns + GAP_RATIO * (columns - 1))) * 100}%`;

  return (
    <div className="flex flex-col gap-2">
      {/* Zastrzeżenie PRZED rysunkiem, nie pod nim: przeczytane po fakcie nie zdąży zapobiec
          wzięciu planu za podgląd wolnych miejsc z kasy kina. */}
      <p className="text-sm text-slate-300">
        Układ sali (nie pokazuje, które miejsca są wolne):
      </p>

      {/* Sala dopasowuje się do szerokości ramki (patrz SEAT_MIN/SEAT_MAX), a wąska - 409 sal ma
          poniżej 20 kolumn, najmniejsza 6 - jest wyśrodkowana zamiast wisieć przy lewej krawędzi. */}
      <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/40 p-3">
        <div
          className="mx-auto w-full"
          style={{ maxWidth: `calc(${gutter} + 0.5rem + ${columns * SEAT_MAX + (columns - 1) * SEAT_MAX * GAP_RATIO}px)` }}
        >
          {/* Sam napis, bez rysowanego ekranu: żadna z sieci nie podaje jego szerokości ani
              położenia (Helios `screenElements` i CC `E` są zawsze puste), więc pasek udawałby
              wymiar, którego nie znamy. Napis wystarcza, by wiedzieć, gdzie jest przód sali.
              Wcięcie o szerokość rynny z numerami rzędów - inaczej napis stoi nad nią, a nie
              nad środkiem sali. */}
          <div
            className="mb-3 text-center text-[10px] uppercase tracking-[0.2em] text-slate-500"
            style={{ paddingLeft: `calc(${gutter} + 0.5rem)` }}
          >
            Ekran
          </div>

          <div className="flex flex-col" style={{ rowGap: ROW_GAP }}>
            {layout.rows.map((row) => (
              <div key={`${row.y}-${row.label}`} className="flex items-center gap-2">
                <span
                  className="shrink-0 text-right text-[10px] leading-none tabular-nums text-slate-600"
                  style={{ width: gutter }}
                >
                  {row.label}
                </span>
                <div
                  className="grid flex-1"
                  style={{ gridTemplateColumns: `repeat(${columns}, minmax(${SEAT_MIN}px, 1fr))`, columnGap }}
                >
                  {/* Klucz z indeksu, bo Helios potrafi zdublować miejsce dla niepełnosprawnych -
                      ta sama kolumna i ta sama etykieta, więc `x`+`label` nie były unikalne. */}
                  {row.seats.map((seat, i) => (
                    <span
                      key={i}
                      title={`${row.label ? `Rząd ${row.label}, ` : ""}miejsce ${seat.label}${seat.pair ? " (kanapa)" : ""}`}
                      className={`relative aspect-square ${SEAT_CLASS[seat.kind] ?? SEAT_CLASS.standard}`}
                      style={{
                        gridColumnStart: seat.x - minX + 1,
                        // Kanapa jest zaokrąglona tylko na zewnętrznych rogach - w środku ma być
                        // ciągła, bo to jedno siedzisko.
                        borderStartStartRadius: seat.pair === "m" || seat.pair === "r" ? 0 : RADIUS,
                        borderEndStartRadius: seat.pair === "m" || seat.pair === "r" ? 0 : RADIUS,
                        borderStartEndRadius: seat.pair === "m" || seat.pair === "l" ? 0 : RADIUS,
                        borderEndEndRadius: seat.pair === "m" || seat.pair === "l" ? 0 : RADIUS,
                      }}
                    >
                      {/* Odstęp po prawej zasypuje NAKŁADKA, a nie ujemny margines na samym fotelu:
                          margines poszerzał pudełko, a przy `aspect-square` wysokość idzie za
                          szerokością, więc lewa połówka kanapy robiła się wyższa od prawej.
                          Piksel zapasu, bo kolumny `1fr` mają szerokości ułamkowe i nakładka równa
                          co do piksela zostawiała włos tła. Nadmiar zakrywa sąsiedni fotel tej samej
                          kanapy - rysuje się po nakładce i ma ten sam kolor. */}
                      {(seat.pair === "l" || seat.pair === "m") && (
                        <span
                          className="absolute inset-y-0 left-full bg-inherit"
                          style={{ width: `calc(${GAP_RATIO * 100}% + 1px)` }}
                        />
                      )}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Legendę pokazujemy tylko dla rodzajów, które w TEJ sali występują. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
        {LEGEND.filter(([kind]) => kinds.has(kind)).map(([kind, label]) => (
          <span key={kind} className="inline-flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 ${SEAT_CLASS[kind]}`} style={{ borderRadius: RADIUS }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
