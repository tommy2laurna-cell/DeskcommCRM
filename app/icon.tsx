import { desenharIcone } from "@/lib/branding/icone-png";

export const dynamic = "force-dynamic";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default async function Icon() {
  return desenharIcone(size.width);
}
