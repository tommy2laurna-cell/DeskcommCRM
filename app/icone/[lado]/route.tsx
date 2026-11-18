import { desenharIcone } from "@/lib/branding/icone-png";

export const dynamic = "force-dynamic";

/** Íconos 192 y 512 del manifest (Chrome los exige para ofrecer «Instalar»). Misma marca que `/icon`. */
export async function GET(_req: Request, ctx: { params: Promise<{ lado: string }> }) {
  const { lado } = await ctx.params;
  if (lado !== "192" && lado !== "512") return new Response("not found", { status: 404 });
  return desenharIcone(Number(lado));
}
