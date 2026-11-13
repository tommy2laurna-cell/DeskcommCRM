import type { MetadataRoute } from "next";

import { marcaDaSaida } from "@/lib/branding/saida";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const marca = await marcaDaSaida(null);
  return {
    name: marca.nome,
    short_name: marca.nome,
    display: "standalone",
    start_url: "/app",
    scope: "/",
    background_color: "#ffffff",
    theme_color: marca.accent,
    icons: [
      { src: "/icon", sizes: "64x64", type: "image/png" },
      { src: "/icone/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icone/512", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
