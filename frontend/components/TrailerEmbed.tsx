// Odtwarzacz zwiastuna. Powstaje dopiero po kliknięciu przycisku "Zwiastun" w modalu, więc przed
// świadomą czynnością użytkownika NIC nie leci do Google - stąd brak potrzeby banera zgód.
// Domena nocookie ogranicza śledzenie już po starcie; sama z siebie by nie wystarczyła, bo zapisuje
// localStorage - kluczowe jest, że komponent w ogóle nie jest renderowany wcześniej.
export default function TrailerEmbed({ youtubeId, title }: { youtubeId: string; title: string }) {
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
      <iframe
        src={`https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=1&rel=0`}
        title={`Zwiastun: ${title}`}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        className="absolute inset-0 h-full w-full border-0"
      />
    </div>
  );
}
