import { ImageResponse } from "next/og";

import { SITE_NAME } from "@/lib/site";

// Obrazek podglądu linku (Facebook, Messenger, WhatsApp, Slack). Generowany kodem, więc nie trzeba
// utrzymywać pliku graficznego - wystarczy zmienić ten komponent.
// 1200x630 to rozmiar oczekiwany przez większość serwisów; mniejszy bywa przycinany.
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = `${SITE_NAME} - repertuar kin w jednym miejscu`;

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          // Kolory zgodne z aplikacją (slate-950 + indigo), żeby podgląd nie wyglądał na obcy.
          background: "linear-gradient(135deg, #020617 0%, #0f172a 55%, #1e1b4b 100%)",
          color: "#f8fafc",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", fontSize: 116, lineHeight: 1 }}>🎬</div>
        <div
          style={{
            display: "flex",
            fontSize: 82,
            fontWeight: 700,
            marginTop: 28,
            letterSpacing: -2,
          }}
        >
          {SITE_NAME}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 36,
            marginTop: 20,
            color: "#94a3b8",
            textAlign: "center",
            maxWidth: 900,
          }}
        >
          Multikino, Cinema City, Helios i kina studyjne w jednym miejscu
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 46,
            height: 8,
            width: 240,
            borderRadius: 999,
            background: "#4f46e5",
          }}
        />
      </div>
    ),
    size,
  );
}
